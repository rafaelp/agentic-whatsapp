import { readFile, rename } from 'node:fs/promises';
import { json, num, type Row, type Store, text } from './db.js';
import type { MediaResult } from './media.js';
import type { Route } from './router.js';
import type { Batch, ChatMessage, Decision } from './types.js';
import { asString, isNotFound, isRecord } from './util.js';

const OUTGOING_TTL_MS = 10 * 60_000;

export type BatchStatus = 'pending' | 'decided' | 'failed' | 'skipped';
export type SentStatus = 'sent' | 'failed' | 'dry_run' | 'logged';

export interface HighlightRecord {
  batchId?: number;
  chat: string;
  chatName: string;
  /** The highlighted messages of that chat. */
  ids: string[];
  /** Why they matter, in the model's words. */
  text: string;
}

/** The model calls of one day, as the stream shows them the next morning. */
export interface DailyCost {
  /** YYYY-MM-DD */
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  currency: string;
}

/**
 * An entry of the stream: highlighted messages, or, with kind `daily_cost`, the cost of a
 * day (with no chat, IDs or text).
 */
export interface Highlight extends HighlightRecord {
  id: number;
  at: Date;
  kind: 'messages' | 'daily_cost' | 'deleted' | 'transcript';
  /** Why an audio of a transcript entry could not be transcribed. */
  note?: string;
  dailyCost?: DailyCost;
}

/** A message as the database has it, for the stream. Text is empty when it was not kept. */
export interface StoredText {
  id: string;
  sender: string;
  senderName: string;
  fromMe: boolean;
  media: string;
  text: string;
  mediaText: string;
}

export type CommandStatus = 'ok' | 'failed' | 'timeout' | 'refused' | 'dry_run';

export interface CommandRecord {
  program: string;
  /** The [cli] allow rule that let it run; empty when refused. */
  rule: string;
  /** The whole command, program first. */
  command: readonly string[];
  status: CommandStatus;
  exitCode?: number;
  durationMs: number;
  error?: string;
}

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

  /** Stores what came of reading a message's image or audio. */
  recordMedia(chat: string, id: string, result: MediaResult): void {
    this.store.run(
      'UPDATE messages SET media_file = ?, media_text = ?, media_error = ? WHERE chat = ? AND id = ?',
      result.file,
      this.options.saveText ? result.text : undefined,
      result.error ?? result.skipped,
      chat,
      id,
    );
  }

  /** Remembers a file downloaded for a message, so storage.retention_days deletes it in time. */
  recordMediaFile(chat: string, id: string, file: string): void {
    this.store.run('UPDATE messages SET media_file = ? WHERE chat = ? AND id = ?', file, chat, id);
  }

  /** Descriptions and transcripts of earlier messages of a chat, by message ID. */
  mediaTexts(chat: string, ids: readonly string[]): Map<string, string> {
    const texts = new Map<string, string>();
    for (const id of ids) {
      const row = this.store.get('SELECT media_text FROM messages WHERE chat = ? AND id = ?', chat, id);
      if (typeof row?.media_text === 'string' && row.media_text !== '') texts.set(id, row.media_text);
    }
    return texts;
  }

  recordHighlight(record: HighlightRecord, at: Date = new Date()): number {
    return this.store.run(
      'INSERT INTO highlights (batch_id, at, chat, chat_name, message_ids, text) VALUES (?, ?, ?, ?, ?, ?)',
      record.batchId,
      at.toISOString(),
      record.chat,
      record.chatName,
      JSON.stringify(record.ids),
      this.options.saveText ? record.text : undefined,
    ).id;
  }

  /**
   * Puts a message someone deleted in the stream, once. Its text comes from the messages
   * table when the stream shows it, since wacli clears it from its own archive.
   */
  recordDeleted(record: { chat: string; chatName: string; id: string }, at: Date = new Date()): number | undefined {
    if (!this.markNotice(`deleted:${record.chat}/${record.id}`, at)) return undefined;
    return this.store.run(
      "INSERT INTO highlights (at, chat, chat_name, message_ids, kind) VALUES (?, ?, ?, ?, 'deleted')",
      at.toISOString(),
      record.chat,
      record.chatName,
      JSON.stringify([record.id]),
    ).id;
  }

  /**
   * Puts the transcript of an audio in the stream (media.audio_transcribe_to). The text is the
   * message's own, in the messages table; `note` says why there is none.
   */
  recordTranscript(record: { chat: string; chatName: string; id: string; note?: string }, at: Date = new Date()): number {
    return this.store.run(
      "INSERT INTO highlights (at, chat, chat_name, message_ids, kind, data) VALUES (?, ?, ?, ?, 'transcript', ?)",
      at.toISOString(),
      record.chat,
      record.chatName,
      JSON.stringify([record.id]),
      record.note === undefined ? undefined : JSON.stringify({ note: record.note }),
    ).id;
  }

  /** Puts the cost of a day in the stream. */
  recordDailyCost(cost: DailyCost, at: Date = new Date()): number {
    return this.store.run(
      "INSERT INTO highlights (at, chat, kind, data) VALUES (?, '', 'daily_cost', ?)",
      at.toISOString(),
      JSON.stringify(cost),
    ).id;
  }

  /** Stores a command run_cli ran, or refused; its arguments only while texts are kept. */
  recordCommand(record: CommandRecord, at: Date = new Date()): number {
    return this.store.run(
      'INSERT INTO commands (at, program, rule, args, status, exit_code, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      at.toISOString(),
      record.program,
      record.rule,
      this.options.saveText ? JSON.stringify(record.command) : undefined,
      record.status,
      record.exitCode,
      Math.round(record.durationMs),
      record.error,
    ).id;
  }

  /** Highlights with an ID above `after`, oldest first. */
  highlightsAfter(after: number, limit = 100): Highlight[] {
    return this.store
      .all('SELECT * FROM highlights WHERE id > ? ORDER BY id LIMIT ?', after, limit)
      .map(highlightOf);
  }

  /** The ID of the newest highlight, 0 when there is none. */
  lastHighlightId(): number {
    return num(this.store.get('SELECT max(id) AS id FROM highlights')?.id);
  }

  /** The last `count` highlights, oldest first. */
  recentHighlights(count: number): Highlight[] {
    return this.store
      .all('SELECT * FROM highlights ORDER BY id DESC LIMIT ?', count)
      .map(highlightOf)
      .reverse();
  }

  /** The last name a chat had in the messages the agent was given; empty when none had one. */
  chatName(chat: string): string {
    return text(
      this.store.get("SELECT chat_name FROM messages WHERE chat = ? AND chat_name != '' ORDER BY received_at DESC LIMIT 1", chat)?.chat_name,
    );
  }

  /** The stored messages of a chat with these IDs, in that order; unknown IDs are left out. */
  messagesById(chat: string, ids: readonly string[]): StoredText[] {
    return ids.flatMap((id) => {
      const row = this.store.get(
        'SELECT id, sender, sender_name, from_me, media, text, media_text FROM messages WHERE chat = ? AND id = ?',
        chat,
        id,
      );
      if (row === undefined) return [];
      return [
        {
          id,
          sender: text(row.sender),
          senderName: text(row.sender_name),
          fromMe: num(row.from_me) === 1,
          media: text(row.media),
          text: text(row.text),
          mediaText: text(row.media_text),
        },
      ];
    });
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
   * Deletes message text, descriptions and transcripts, prompts, answers, sent text and the
   * reasons of highlights older than `before`. IDs, names, decisions, tokens and costs stay, so duplicates are still
   * recognized and costs still add up.
   */
  pruneText(before: Date): number {
    const cutoff = before.toISOString();
    return this.store.transaction(
      () =>
        this.store.run(
          'UPDATE messages SET text = NULL, media_text = NULL WHERE received_at < ? AND (text IS NOT NULL OR media_text IS NOT NULL)',
          cutoff,
        ).changes +
        this.store.run(
          'UPDATE calls SET prompt = NULL, response = NULL WHERE started_at < ? AND (prompt IS NOT NULL OR response IS NOT NULL)',
          cutoff,
        ).changes +
        this.store.run('UPDATE sent SET text = NULL WHERE at < ? AND text IS NOT NULL', cutoff).changes +
        this.store.run('UPDATE highlights SET text = NULL WHERE at < ? AND text IS NOT NULL', cutoff).changes +
        this.store.run('UPDATE commands SET args = NULL WHERE at < ? AND args IS NOT NULL', cutoff).changes +
        this.store.run(
          `UPDATE batches SET actions = (SELECT json_group_array(json_object('type', json_extract(value, '$.type')))
             FROM json_each(batches.actions))
           WHERE created_at < ? AND (actions LIKE '%"text"%' OR actions LIKE '%"content"%')`,
          cutoff,
        ).changes,
    );
  }

  /**
   * Forgets the media files of messages received before `before` and returns their paths,
   * for the caller to delete.
   */
  takeMediaFiles(before: Date): string[] {
    return this.store.transaction(() => {
      const cutoff = before.toISOString();
      const rows = this.store.all('SELECT media_file FROM messages WHERE received_at < ? AND media_file IS NOT NULL', cutoff);
      this.store.run('UPDATE messages SET media_file = NULL WHERE received_at < ? AND media_file IS NOT NULL', cutoff);
      return rows.map((row) => String(row.media_file));
    });
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

function highlightOf(row: Row): Highlight {
  return {
    id: num(row.id),
    at: new Date(text(row.at)),
    batchId: row.batch_id === null ? undefined : num(row.batch_id),
    chat: text(row.chat),
    chatName: text(row.chat_name),
    ids: json<unknown[]>(row.message_ids, []).filter((id): id is string => typeof id === 'string'),
    text: text(row.text),
    ...(text(row.kind) === 'daily_cost'
      ? { kind: 'daily_cost', dailyCost: dailyCostOf(json<Record<string, unknown>>(row.data, {})) }
      : text(row.kind) === 'transcript'
        ? { kind: 'transcript', ...noteOf(json<Record<string, unknown>>(row.data, {})) }
        : { kind: text(row.kind) === 'deleted' ? 'deleted' : 'messages' }),
  };
}

function noteOf(data: Record<string, unknown>): { note?: string } {
  return typeof data.note === 'string' && data.note !== '' ? { note: data.note } : {};
}

function dailyCostOf(data: Record<string, unknown>): DailyCost {
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    day: asString(data.day),
    calls: count(data.calls),
    inputTokens: count(data.inputTokens),
    outputTokens: count(data.outputTokens),
    cost: count(data.cost),
    currency: asString(data.currency) || 'USD',
  };
}
