import { readFile, rename } from 'node:fs/promises';
import type { Store } from './db.js';
import type { Route } from './router.js';
import type { Batch, ChatMessage, Decision } from './types.js';
import { isNotFound, isRecord } from './util.js';

const OUTGOING_TTL_MS = 10 * 60_000;

export type BatchStatus = 'pending' | 'decided' | 'failed' | 'skipped';
export type SentStatus = 'sent' | 'failed' | 'dry_run' | 'logged';

export interface SentRecord {
  batchId?: number;
  chat: string;
  purpose: string;
  status: SentStatus;
  messageId?: string;
  text: string;
  error?: string;
}

/**
 * What the agent remembers, in the database: every message it was given (so each one is
 * handled once), every batch and its decision, everything it sent (so it never answers
 * itself), and one-time notices such as "daily limit reached".
 */
export class AgentState {
  private readonly outgoing = new Map<string, number>();

  constructor(
    readonly store: Store,
    private readonly options: { saveText: boolean } = { saveText: true },
  ) {}

  /** Stores a message the first time it is seen, with what routing made of it; false for a duplicate. */
  recordMessage(message: ChatMessage, route: Route, receivedAt: Date = new Date()): boolean {
    const { changes } = this.store.run(
      `INSERT INTO messages (chat, id, chat_name, sender, sender_name, from_me, forwarded, media, text, sent_at, received_at,
        route, kind, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chat, id) DO NOTHING`,
      message.chat,
      message.id,
      message.chatName,
      message.sender,
      message.senderName,
      message.fromMe,
      message.forwarded,
      message.mediaType,
      this.options.saveText ? message.text : undefined,
      message.timestamp.toISOString(),
      receivedAt.toISOString(),
      route.process ? 'queued' : 'skipped',
      route.process ? route.kind : undefined,
      route.process ? undefined : route.reason,
    );
    return changes > 0;
  }

  /** Records a batch about to be decided and links its messages to it. */
  startBatch(batch: Batch, invoked: boolean, at: Date = new Date()): number {
    return this.store.transaction(() => {
      const { id } = this.store.run(
        'INSERT INTO batches (chat, chat_name, created_at, messages, invoked, status) VALUES (?, ?, ?, ?, ?, ?)',
        batch.chat,
        batch.chatName,
        at.toISOString(),
        batch.messages.length,
        invoked,
        'pending',
      );
      for (const message of batch.messages) {
        this.store.run('UPDATE messages SET batch_id = ? WHERE chat = ? AND id = ?', id, message.chat, message.id);
      }
      return id;
    });
  }

  finishBatch(
    id: number,
    outcome: { status: BatchStatus; error?: string; decision?: Decision },
    at: Date = new Date(),
  ): void {
    const actions = outcome.decision?.actions.map((action) => (this.options.saveText ? action : { type: action.type }));
    this.store.run(
      'UPDATE batches SET status = ?, error = ?, actions = ?, warnings = ?, finished_at = ? WHERE id = ?',
      outcome.status,
      outcome.error,
      actions === undefined ? undefined : JSON.stringify(actions),
      outcome.decision === undefined || outcome.decision.warnings.length === 0 ? undefined : JSON.stringify(outcome.decision.warnings),
      at.toISOString(),
      id,
    );
  }

  recordSent(record: SentRecord, at: Date = new Date()): void {
    this.store.run(
      'INSERT INTO sent (batch_id, at, chat, purpose, status, message_id, text, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      record.batchId,
      at.toISOString(),
      record.chat,
      record.purpose,
      record.status,
      record.messageId,
      this.options.saveText ? record.text : undefined,
      record.error,
    );
  }

  /** Whether the agent sent the WhatsApp message with this ID. */
  isAgentSent(id: string): boolean {
    return this.store.get('SELECT 1 AS found FROM sent WHERE message_id = ? LIMIT 1', id) !== undefined;
  }

  /**
   * Remembers a text right before the agent sends it. The message can echo back
   * before the send returns its ID, so the echo is recognized by its text as well.
   */
  noteOutgoing(chat: string, text: string, now = Date.now()): void {
    for (const [key, at] of this.outgoing) {
      if (now - at > OUTGOING_TTL_MS) this.outgoing.delete(key);
    }
    this.outgoing.set(outgoingKey(chat, text), now);
  }

  isRecentOutgoing(chat: string, text: string, now = Date.now()): boolean {
    const at = this.outgoing.get(outgoingKey(chat, text));
    return at !== undefined && now - at <= OUTGOING_TTL_MS;
  }

  /** Returns true the first time it is called for `key`, such as "calls:2026-11-10". */
  markNotice(key: string, at: Date = new Date()): boolean {
    return this.store.run('INSERT INTO notices (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', key, at.toISOString()).changes > 0;
  }

  /**
   * Deletes message text, prompts, answers and sent text older than `before`. IDs, names,
   * decisions, tokens and costs stay, so duplicates are still recognized and costs still add up.
   */
  pruneText(before: Date): number {
    const cutoff = before.toISOString();
    return this.store.transaction(
      () =>
        this.store.run('UPDATE messages SET text = NULL WHERE received_at < ? AND text IS NOT NULL', cutoff).changes +
        this.store.run(
          'UPDATE calls SET prompt = NULL, response = NULL WHERE started_at < ? AND (prompt IS NOT NULL OR response IS NOT NULL)',
          cutoff,
        ).changes +
        this.store.run('UPDATE sent SET text = NULL WHERE at < ? AND text IS NOT NULL', cutoff).changes +
        this.store.run(
          `UPDATE batches SET actions = (SELECT json_group_array(json_object('type', json_extract(value, '$.type')))
             FROM json_each(batches.actions))
           WHERE created_at < ? AND (actions LIKE '%"text"%' OR actions LIKE '%"content"%')`,
          cutoff,
        ).changes,
    );
  }

  /**
   * Imports the state.json of agentic-whatsapp 0.3 and earlier: the messages it handled and
   * the IDs it sent, so none of them is processed again. The file is then renamed.
   */
  async importLegacy(file: string, at: Date = new Date()): Promise<number> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw new Error(`Could not read the state file ${file}: ${String(error)}`);
    }
    const strings = (items: unknown): string[] =>
      Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
    const seen = isRecord(value) ? strings(value.seen) : [];
    const sent = isRecord(value) ? strings(value.agentSent) : [];
    const stamp = at.toISOString();
    let imported = 0;
    this.store.transaction(() => {
      for (const key of seen) {
        const slash = key.indexOf('/');
        if (slash <= 0) continue;
        imported += this.store.run(
          `INSERT INTO messages (chat, id, sent_at, received_at, route) VALUES (?, ?, ?, ?, 'imported')
           ON CONFLICT (chat, id) DO NOTHING`,
          key.slice(0, slash),
          key.slice(slash + 1),
          stamp,
          stamp,
        ).changes;
      }
      for (const id of sent) {
        if (this.isAgentSent(id)) continue;
        this.store.run(
          `INSERT INTO sent (at, chat, purpose, status, message_id) VALUES (?, '', 'imported', 'sent', ?)`,
          stamp,
          id,
        );
        imported += 1;
      }
    });
    await rename(file, `${file}.imported`);
    return imported;
  }
}

function outgoingKey(chat: string, text: string): string {
  return `${chat}\n${text.trim()}`;
}
