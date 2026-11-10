import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, parseConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import type { DecideOptions, DecisionMaker } from '../src/decision.js';
import type { MediaOptions, MediaReader, MediaRequest } from '../src/media.js';
import type { LogFields, Logger } from '../src/log.js';
import { AgentState } from '../src/state.js';
import type { Action, ChatMessage, Decision } from '../src/types.js';
import { type Usage, UsageLedger } from '../src/usage.js';
import type { DownloadedMedia, WacliClient } from '../src/wacli.js';
import type { StoredMessage } from '../src/whatsapp.js';

export const HOME = '120363000000000001@g.us';
export const FAMILY = '120363000000000002@g.us';
export const OTHER_GROUP = '120363000000000003@g.us';
export const BOB = '5521999990001@s.whatsapp.net';
export const NOW = new Date('2026-11-10T15:00:00Z');

type RawSections = Record<string, Record<string, unknown>>;

export function makeConfig(sections: RawSections = {}, stateDir = join(tmpdir(), 'agentic-whatsapp-test')): Config {
  const base: RawSections = {
    agent: { name: 'Ane', language: 'pt-BR', timezone: 'America/Sao_Paulo', home_chat: HOME },
    routing: { group_allowlist: [FAMILY], debounce_seconds: 0 },
  };
  const merged: RawSections = { ...base };
  for (const [name, values] of Object.entries(sections)) merged[name] = { ...base[name], ...values };
  return parseConfig(merged, { configFile: join(stateDir, 'config.toml'), stateDir });
}

let counter = 0;

/** A wacli webhook message payload from Bob, now, unless overridden. */
export function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  return {
    Chat: BOB,
    ID: `MSG${counter}`,
    SenderJID: BOB,
    PushName: 'Bob',
    Timestamp: NOW.toISOString(),
    FromMe: false,
    Text: 'oi',
    Media: null,
    ...overrides,
  };
}

export function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  counter += 1;
  return {
    id: `MSG${counter}`,
    chat: BOB,
    chatName: '',
    sender: BOB,
    senderName: 'Bob',
    timestamp: NOW,
    fromMe: false,
    text: 'oi',
    mediaType: '',
    forwarded: false,
    reaction: false,
    edited: false,
    revoked: false,
    ...overrides,
  };
}

export class FakeWacli implements WacliClient {
  readonly sent: { to: string; text: string }[] = [];
  readonly downloads: { chat: string; id: string; output: string }[] = [];
  history: StoredMessage[] = [];
  failSends = false;
  /** What each download writes; null makes it fail. */
  media: string | null = 'MEDIA BYTES';

  async downloadMedia(chat: string, id: string, output: string): Promise<DownloadedMedia> {
    this.downloads.push({ chat, id, output });
    if (this.media === null) throw new Error('media expired');
    await writeFile(output, this.media);
    return { path: output, bytes: Buffer.byteLength(this.media), mimeType: '' };
  }

  async sendText(to: string, text: string): Promise<string | undefined> {
    if (this.failSends) throw new Error('send failed');
    this.sent.push({ to, text });
    return `SENT${this.sent.length}`;
  }

  async listMessages(): Promise<StoredMessage[]> {
    return this.history;
  }
}

/** An in-memory database with the state and ledger the agent uses. */
export function memoryStore(config: Config = makeConfig()): { store: Store; state: AgentState; usage: UsageLedger } {
  const store = Store.open(null);
  return {
    store,
    state: new AgentState(store),
    usage: new UsageLedger(store, config.engine, config.costs, config.agent.timezone),
  };
}

/** Answers with `actions`, reporting one attempt with `usage` (1,000 tokens in, 100 out) and `tools`. */
export class FakeDecider implements DecisionMaker {
  readonly prompts: string[] = [];
  readonly options: DecideOptions[] = [];
  error: Error | undefined;
  usage: Usage = { inputTokens: 1_000, outputTokens: 100, thinkingTokens: 0, cachedTokens: 0 };
  tools: string[] = [];

  constructor(public actions: Action[] = []) {}

  async decide(prompt: string, options: DecideOptions = {}): Promise<Decision> {
    this.prompts.push(prompt);
    this.options.push(options);
    options.onAttempt?.({
      attempt: 1,
      startedAt: NOW,
      durationMs: 1_000,
      status: this.error === undefined ? 'ok' : 'failed',
      error: this.error?.message,
      usage: this.usage,
      tools: this.tools,
    });
    if (this.error !== undefined) throw this.error;
    return { actions: this.actions, warnings: [] };
  }
}

/** Reads media as `text`, reporting one attempt of 2,000 tokens in and 50 out per file. */
export class FakeReader implements MediaReader {
  readonly requests: MediaRequest[] = [];
  /** What each file held when it was read. */
  readonly contents: string[] = [];
  error: Error | undefined;

  constructor(public text = 'Uma foto de um boleto de R$ 120,00.') {}

  async readMedia(request: MediaRequest, options: MediaOptions = {}): Promise<string> {
    this.requests.push(request);
    this.contents.push(await readFile(request.file, 'utf8'));
    options.onAttempt?.({
      attempt: 1,
      startedAt: NOW,
      durationMs: 2_000,
      status: this.error === undefined ? 'ok' : 'failed',
      error: this.error?.message,
      usage: { inputTokens: 2_000, outputTokens: 50, thinkingTokens: 0, cachedTokens: 0 },
      tools: ['read_file'],
      response: this.error === undefined ? this.text : undefined,
    });
    if (this.error !== undefined) throw this.error;
    return this.text;
  }
}

export class MemoryLogger implements Logger {
  readonly entries: { level: string; message: string; fields: LogFields | undefined }[] = [];
  debug = (message: string, fields?: LogFields) => this.entries.push({ level: 'debug', message, fields });
  info = (message: string, fields?: LogFields) => this.entries.push({ level: 'info', message, fields });
  warn = (message: string, fields?: LogFields) => this.entries.push({ level: 'warn', message, fields });
  error = (message: string, fields?: LogFields) => this.entries.push({ level: 'error', message, fields });

  has(level: string, message: string): boolean {
    return this.entries.some((entry) => entry.level === level && entry.message === message);
  }
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentic-whatsapp-'));
}

/** Writes an executable Node script, used to stand in for the gemini and wacli commands. */
export async function fakeCommand(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, `${name}.mjs`);
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}
