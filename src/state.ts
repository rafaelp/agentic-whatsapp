import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isNotFound, isRecord, writeFileAtomic } from './util.js';

const SEEN_LIMIT = 5_000;
const SENT_LIMIT = 1_000;
const OUTGOING_TTL_MS = 10 * 60_000;
const SAVE_DELAY_MS = 1_000;

interface Usage {
  day: string;
  calls: number;
  capNotified: boolean;
}

interface StateFile {
  version: 1;
  seen: string[];
  agentSent: string[];
  usage: Usage;
}

/** Insertion-ordered set that forgets its oldest entries past `limit`. */
class BoundedSet {
  private readonly items: Set<string>;

  constructor(
    private readonly limit: number,
    initial: Iterable<string> = [],
  ) {
    this.items = new Set(initial);
    this.trim();
  }

  has(item: string): boolean {
    return this.items.has(item);
  }

  add(item: string): void {
    this.items.delete(item);
    this.items.add(item);
    this.trim();
  }

  values(): string[] {
    return [...this.items];
  }

  private trim(): void {
    for (const item of this.items) {
      if (this.items.size <= this.limit) break;
      this.items.delete(item);
    }
  }
}

/**
 * Small persistent state: which messages were already handled, which ones the agent
 * sent itself, and how many model calls were made today.
 */
export class AgentState {
  private readonly seen: BoundedSet;
  private readonly agentSent: BoundedSet;
  private usage: Usage;
  private readonly outgoing = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly file: string | null,
    data: StateFile,
  ) {
    this.seen = new BoundedSet(SEEN_LIMIT, data.seen);
    this.agentSent = new BoundedSet(SENT_LIMIT, data.agentSent);
    this.usage = data.usage;
  }

  /** Loads the state from `file`, or keeps it in memory only when `file` is null. */
  static async load(file: string | null): Promise<AgentState> {
    if (file === null) return new AgentState(null, emptyState());
    try {
      return new AgentState(file, parseState(JSON.parse(await readFile(file, 'utf8'))));
    } catch (error) {
      if (isNotFound(error)) return new AgentState(file, emptyState());
      throw new Error(`Could not read the state file ${file}: ${String(error)}`);
    }
  }

  /** Records a message; returns false when it was already seen. */
  markSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.scheduleSave();
    return true;
  }

  markAgentSent(id: string): void {
    this.agentSent.add(id);
    this.scheduleSave();
  }

  isAgentSent(id: string): boolean {
    return this.agentSent.has(id);
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

  /** Counts one model call for `day`; returns false once `max` calls were made that day. */
  tryConsumeCall(day: string, max: number): boolean {
    if (this.usage.day !== day) this.usage = { day, calls: 0, capNotified: false };
    if (this.usage.calls >= max) return false;
    this.usage.calls += 1;
    this.scheduleSave();
    return true;
  }

  /** Returns true the first time it is called on a day the limit was hit. */
  markCapNotified(day: string): boolean {
    if (this.usage.day !== day || this.usage.capNotified) return false;
    this.usage.capNotified = true;
    this.scheduleSave();
    return true;
  }

  callsToday(day: string): number {
    return this.usage.day === day ? this.usage.calls : 0;
  }

  async save(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.file === null) return;
    const data: StateFile = {
      version: 1,
      seen: this.seen.values(),
      agentSent: this.agentSent.values(),
      usage: this.usage,
    };
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, `${JSON.stringify(data)}\n`);
  }

  private scheduleSave(): void {
    if (this.file === null || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save().catch((error: unknown) => {
        process.stderr.write(`agentic-whatsapp: could not save state: ${String(error)}\n`);
      });
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }
}

function outgoingKey(chat: string, text: string): string {
  return `${chat}\n${text.trim()}`;
}

function emptyState(): StateFile {
  return { version: 1, seen: [], agentSent: [], usage: { day: '', calls: 0, capNotified: false } };
}

function parseState(value: unknown): StateFile {
  const state = emptyState();
  if (!isRecord(value)) return state;
  const strings = (items: unknown): string[] =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  state.seen = strings(value.seen);
  state.agentSent = strings(value.agentSent);
  if (isRecord(value.usage)) {
    state.usage = {
      day: typeof value.usage.day === 'string' ? value.usage.day : '',
      calls: typeof value.usage.calls === 'number' ? value.usage.calls : 0,
      capNotified: value.usage.capNotified === true,
    };
  }
  return state;
}
