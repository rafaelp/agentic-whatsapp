import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

export type Row = Record<string, SQLOutputValue>;
export type Param = SQLInputValue | boolean | undefined;

const require = createRequire(import.meta.url);

/**
 * node:sqlite is built into Node from 22.13. Node 22 still flags it as experimental on
 * every start, which would only be noise in the agent log, so that one warning is dropped.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

/** Each entry upgrades the schema by one version; never edit one that was released. */
const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Every message wacli delivered with content, processed or not. (chat, id) makes each one count once.
  CREATE TABLE messages (
    chat TEXT NOT NULL,
    id TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    sender TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    from_me INTEGER NOT NULL DEFAULT 0,
    forwarded INTEGER NOT NULL DEFAULT 0,
    media TEXT NOT NULL DEFAULT '',
    text TEXT,
    sent_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    route TEXT NOT NULL,
    kind TEXT,
    reason TEXT,
    batch_id INTEGER,
    PRIMARY KEY (chat, id)
  );
  CREATE INDEX messages_received ON messages (received_at);

  -- Messages of one chat sent to the model together, and what came of them.
  CREATE TABLE batches (
    id INTEGER PRIMARY KEY,
    chat TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finished_at TEXT,
    messages INTEGER NOT NULL,
    invoked INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
    actions TEXT,
    warnings TEXT
  );

  -- One row per run of the engine, with its tokens and cost. day, week and month are local to
  -- agent.timezone at the time of the call, so limits and summaries are simple lookups.
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER,
    chat TEXT NOT NULL DEFAULT '',
    chat_name TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    day TEXT NOT NULL,
    week TEXT NOT NULL,
    month TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    thinking_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    tools TEXT,
    conversation_id TEXT,
    prompt TEXT,
    response TEXT
  );
  CREATE INDEX calls_day ON calls (day);
  CREATE INDEX calls_week ON calls (week);
  CREATE INDEX calls_month ON calls (month);

  -- Everything the agent sent, or would have sent. message_id lets it recognize its own echoes.
  CREATE TABLE sent (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER,
    at TEXT NOT NULL,
    chat TEXT NOT NULL,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL,
    message_id TEXT,
    text TEXT,
    error TEXT
  );
  CREATE INDEX sent_message_id ON sent (message_id);

  -- One-time notices, such as "daily limit reached" for a given day.
  CREATE TABLE notices (key TEXT PRIMARY KEY, at TEXT NOT NULL);

  CREATE TABLE skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'commands',
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE mcp_servers (
    name TEXT PRIMARY KEY,
    transport TEXT NOT NULL,
    command TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL DEFAULT '[]',
    url TEXT NOT NULL DEFAULT '',
    env TEXT NOT NULL DEFAULT '{}',
    headers TEXT NOT NULL DEFAULT '{}',
    tools TEXT NOT NULL DEFAULT '["*"]',
    scope TEXT NOT NULL DEFAULT 'commands',
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- Images and audio the model read: where the file is kept, and the description or transcript.
  ALTER TABLE messages ADD COLUMN media_file TEXT;
  ALTER TABLE messages ADD COLUMN media_text TEXT;
  ALTER TABLE messages ADD COLUMN media_error TEXT;

  -- What a call was for: a decision, or reading an image or audio.
  ALTER TABLE calls ADD COLUMN purpose TEXT NOT NULL DEFAULT 'decision';
  `,
  `
  -- Messages the model highlighted for the owner's stream, with why. message_ids is a JSON list.
  CREATE TABLE highlights (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER,
    at TEXT NOT NULL,
    chat TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    message_ids TEXT NOT NULL DEFAULT '[]',
    text TEXT
  );
  `,
  `
  -- Stream entries that are not highlighted messages. 'daily_cost': the model calls of a day,
  -- in data as a JSON object, shown the next morning.
  ALTER TABLE highlights ADD COLUMN kind TEXT NOT NULL DEFAULT 'messages';
  ALTER TABLE highlights ADD COLUMN data TEXT;
  `,
  `
  -- Commands the agent ran, or tried to run, with run_cli. rule is the [cli] rule that allowed
  -- it; args is the whole command as a JSON list, kept like other texts. status: ok, failed,
  -- timeout, refused or dry_run.
  CREATE TABLE commands (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    program TEXT NOT NULL,
    rule TEXT NOT NULL DEFAULT '',
    args TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX commands_at ON commands (at);
  `,
  `
  -- The OAuth client of an http MCP server that signs in with OAuth, as a JSON object with
  -- clientId and clientSecret. agy keeps the tokens.
  ALTER TABLE mcp_servers ADD COLUMN oauth TEXT;
  `,
  `
  -- Tasks the owner scheduled: what to do, in the owner's words, when (due_at), and the chat it is
  -- about, where a reply goes ('' for none). status: pending, running, done, failed, missed or
  -- cancelled. result says what it did, kept like other texts; error why it did not.
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    task TEXT,
    chat TEXT NOT NULL DEFAULT '',
    chat_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    finished_at TEXT,
    result TEXT,
    error TEXT
  );
  CREATE INDEX tasks_due ON tasks (status, due_at);
  `,
];

/**
 * The agent's SQLite database: messages, batches, model calls and their cost, what it sent,
 * and the skills and MCP servers it may use. WAL mode lets the CLI read and change it while
 * the service runs.
 */
export class Store {
  private readonly statements = new Map<string, StatementSync>();

  private constructor(
    readonly db: DatabaseSync,
    readonly file: string | null,
  ) {}

  /** Opens (creating and upgrading) the database at `file`, or an in-memory one when `file` is null. */
  static open(file: string | null): Store {
    const { DatabaseSync } = loadSqlite();
    if (file !== null) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file ?? ':memory:');
    db.exec('PRAGMA busy_timeout = 5000');
    if (file !== null) db.exec('PRAGMA journal_mode = WAL');
    const store = new Store(db, file);
    store.migrate();
    store.protect();
    return store;
  }

  get version(): number {
    return Number(this.get('PRAGMA user_version')?.user_version ?? 0);
  }

  run(sql: string, ...params: Param[]): { changes: number; id: number } {
    const result = this.statement(sql).run(...params.map(toSql));
    return { changes: Number(result.changes), id: Number(result.lastInsertRowid) };
  }

  get(sql: string, ...params: Param[]): Row | undefined {
    return this.statement(sql).get(...params.map(toSql));
  }

  all(sql: string, ...params: Param[]): Row[] {
    return this.statement(sql).all(...params.map(toSql));
  }

  /** Runs `fn` in one transaction, so its writes land together or not at all. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  meta(key: string): string | undefined {
    const value = this.get('SELECT value FROM meta WHERE key = ?', key)?.value;
    return typeof value === 'string' ? value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private migrate(): void {
    const current = this.version;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `The database ${this.file ?? ''} was written by a newer agentic-whatsapp (schema ${current}). Update agentic-whatsapp.`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version] ?? '');
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  /** Only the user may read the database: it holds message text and MCP credentials. */
  private protect(): void {
    if (this.file === null) return;
    for (const file of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
}

function toSql(value: Param): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function text(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function num(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 0;
}

/** Parses a JSON column, falling back when it is missing or not valid JSON. */
export function json<T>(value: SQLOutputValue | undefined, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
