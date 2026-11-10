import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from './log.js';
import { type RunResult, runProcess } from './process.js';
import { asString, errorMessage, isRecord, lastLines } from './util.js';
import type { StoredMessage } from './whatsapp.js';

export interface WacliClient {
  /** Sends a text message and returns its WhatsApp message ID when wacli reports one. */
  sendText(to: string, text: string): Promise<string | undefined>;
  /** Most recent stored messages of a chat, newest first. */
  listMessages(chat: string, limit: number): Promise<StoredMessage[]>;
}

/**
 * Thin wrapper over the wacli CLI. While `wacli sync --follow` runs, wacli delegates
 * sends to it and serves reads from the local store, so these calls work alongside it.
 */
export class Wacli implements WacliClient {
  constructor(
    readonly command: string,
    private readonly store: string,
  ) {}

  globalArgs(): string[] {
    return this.store === '' ? [] : [`--store=${this.store}`];
  }

  async run(args: string[], timeoutMs = 60_000): Promise<RunResult> {
    try {
      return await runProcess(this.command, [...this.globalArgs(), ...args], { timeoutMs });
    } catch (error) {
      throw new Error(`Could not start ${this.command}: ${errorMessage(error)}`);
    }
  }

  async sendText(to: string, text: string): Promise<string | undefined> {
    // "--flag=value" keeps text that starts with "-" from being read as a flag.
    const data = await this.json(['send', 'text', `--to=${to}`, `--message=${text}`, '--no-preview'], 120_000);
    return isRecord(data) && typeof data.id === 'string' && data.id !== '' ? data.id : undefined;
  }

  async listMessages(chat: string, limit: number): Promise<StoredMessage[]> {
    const data = await this.json(['messages', 'list', `--chat=${chat}`, `--limit=${limit}`], 30_000);
    return isRecord(data) && Array.isArray(data.messages) ? (data.messages as StoredMessage[]) : [];
  }

  /** Text (or media caption) of one stored message, read-only; null when it cannot be read. */
  async messageText(chat: string, id: string): Promise<string | null> {
    try {
      const data = await this.json(['--read-only', 'messages', 'show', `--chat=${chat}`, `--id=${id}`], 10_000);
      if (!isRecord(data)) return null;
      return asString(data.Text) || asString(data.MediaCaption) || asString(data.DisplayText);
    } catch {
      return null;
    }
  }

  async authStatus(): Promise<{ authenticated: boolean; detail: string }> {
    const result = await this.run(['auth', 'status']);
    return { authenticated: result.code === 0, detail: `${result.stdout}${result.stderr}`.trim() };
  }

  async version(): Promise<string> {
    const result = await this.run(['version']);
    return result.stdout.trim();
  }

  private async json(args: string[], timeoutMs: number): Promise<unknown> {
    const result = await this.run([...args, '--json'], timeoutMs);
    const envelope = parseEnvelope(result.stdout);
    if (envelope === null) {
      throw new Error(`wacli ${args[0] ?? ''} failed: ${lastLines(result.stderr) || `exit code ${String(result.code)}`}`);
    }
    if (!envelope.success) throw new Error(`wacli ${args[0] ?? ''} failed: ${envelope.error ?? 'unknown error'}`);
    return envelope.data;
  }
}

/** Parses wacli's `{"success", "data", "error"}` JSON envelope from the last JSON line. */
export function parseEnvelope(stdout: string): { success: boolean; data: unknown; error: string | null } | null {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value) && typeof value.success === 'boolean') {
        return {
          success: value.success,
          data: value.data,
          error: typeof value.error === 'string' ? value.error : null,
        };
      }
    } catch {
      // Not the envelope; keep looking.
    }
  }
  return null;
}

const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const HEALTHY_RUN_MS = 2 * 60_000;
const STOP_TIMEOUT_MS = 10_000;

export interface SyncEvents {
  /** wacli sync exited on its own. `lastLine` is the last warning or error it printed. */
  onExit?: (exit: { code: number | null; signal: NodeJS.Signals | null; lastLine: string }) => void;
  /** wacli sync has stayed up for `healthyAfterMs` (default 2 minutes). */
  onHealthy?: () => void;
  healthyAfterMs?: number;
}

/** Keeps `wacli sync --follow` running, restarting it with backoff when it exits. */
export class SyncSupervisor {
  private child: ChildProcess | undefined;
  private stopping = false;
  private attempt = 0;
  private lastLine = '';
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private healthyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly wacli: Wacli,
    private readonly args: string[],
    private readonly log: Logger,
    private readonly events: SyncEvents = {},
  ) {}

  start(): void {
    this.stopping = false;
    this.spawn();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    if (this.healthyTimer !== undefined) clearTimeout(this.healthyTimer);
    const child = this.child;
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  private spawn(): void {
    this.lastLine = '';
    const child = spawn(this.wacli.command, [...this.wacli.globalArgs(), ...this.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      this.onExit(code, signal);
    };

    if (this.healthyTimer !== undefined) clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      if (this.child !== child) return;
      this.attempt = 0;
      this.events.onHealthy?.();
    }, this.events.healthyAfterMs ?? HEALTHY_RUN_MS);
    this.healthyTimer.unref();

    forEachLine(child.stdout, (line) => this.logLine(line));
    forEachLine(child.stderr, (line) => this.logLine(line));
    child.on('error', (error) => {
      this.lastLine = `could not run ${this.wacli.command}: ${errorMessage(error)}`;
      this.log.error('could not run wacli sync', { error: errorMessage(error) });
      onExit(null, null);
    });
    child.on('close', onExit);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined;
    if (this.healthyTimer !== undefined) clearTimeout(this.healthyTimer);
    if (this.stopping) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.attempt, RESTART_DELAYS_MS.length - 1)] ?? 60_000;
    this.attempt += 1;
    this.log.warn('wacli sync stopped, restarting', { code, signal, inSeconds: delay / 1000 });
    this.events.onExit?.({ code, signal, lastLine: this.lastLine });
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  private logLine(line: string): void {
    if (/^Synced \d+ messages/.test(line)) {
      this.log.debug(`wacli: ${line}`);
    } else if (/^(warning|error)|fail|not authenticated|logged out|revoked/i.test(line)) {
      this.lastLine = line;
      this.log.warn(`wacli: ${line}`);
    } else {
      this.log.info(`wacli: ${line}`);
    }
  }
}

function forEachLine(stream: Readable | null, onLine: (line: string) => void): void {
  if (stream === null) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (line !== '') onLine(line);
    }
  });
  stream.on('end', () => {
    const line = buffer.trim();
    if (line !== '') onLine(line);
  });
}
