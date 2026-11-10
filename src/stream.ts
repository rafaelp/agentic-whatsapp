import { open, stat } from 'node:fs/promises';
import type { Config } from './config.js';
import { type LogEntry, type LogFields, parseLogLine } from './log.js';
import { formatClock } from './time.js';
import { asString } from './util.js';
import { Wacli } from './wacli.js';
import { chatKind } from './whatsapp.js';

export interface StreamOptions {
  /** Also show messages the agent ignored (groups outside the allowlist, your own messages…). */
  all: boolean;
  /** Show message text, read from the wacli archive. Off keeps the screen free of content. */
  text: boolean;
  /** Also show wacli's own output and other debug lines. */
  verbose: boolean;
  /** Earlier events to show when starting. */
  lines: number;
  color: boolean;
}

/** Returns the text of a stored message, or null. */
export type TextLookup = (chat: string, id: string) => Promise<string | null>;

const KNOWN = new Set([
  'agent running',
  'stopping',
  'stopped',
  'queued message',
  'decision',
  'sent',
  'dry run: would send',
  'dry run: would update the instructions',
  'instructions updated',
  'notification for the owner',
]);

/** Turns agent log entries into one readable line each, for `agentic-whatsapp stream`. */
export class StreamRenderer {
  private readonly names = new Map<string, string>();
  private readonly paint: Painter;

  constructor(
    private readonly config: Config,
    private readonly options: Pick<StreamOptions, 'all' | 'text' | 'verbose' | 'color'>,
    private readonly lookup: TextLookup,
    private readonly width: () => number = () => process.stdout.columns || 120,
  ) {
    this.paint = painter(options.color);
  }

  wants(entry: LogEntry): boolean {
    if (entry.message === 'skipped message') return this.options.all;
    if (entry.message.startsWith('wacli: ')) return this.options.verbose;
    if (entry.level === 'warn' || entry.level === 'error') return true;
    if (KNOWN.has(entry.message)) return true;
    return this.options.verbose;
  }

  async render(entry: LogEntry): Promise<string | null> {
    const { paint } = this;
    const f = entry.fields;
    const chat = asString(f.chat);
    let body: string;
    let color: (text: string) => string = (text) => text;

    switch (entry.message) {
      case 'agent running':
        body = `▶ ${asString(f.name) || this.config.agent.name} is running (${asString(f.engine)}, ${asString(f.model)})${f.dryRun === true ? ' · dry run, nothing is sent' : ''}`;
        color = paint.bold;
        break;
      case 'stopping':
        return null;
      case 'stopped':
        body = `■ ${this.config.agent.name} stopped`;
        color = paint.bold;
        break;
      case 'queued message': {
        this.remember(f);
        const text = await this.text(chat, asString(f.id), asString(f.media));
        if (f.kind === 'command') {
          body = `⚡ ${this.who(f)} in ${this.chatLabel(chat)}${text}`;
          color = paint.magenta;
        } else {
          const from = chatKind(chat) === 'group' ? `${this.chatLabel(chat)} · ${this.who(f)}` : this.chatLabel(chat);
          body = `📩 ${from}${text}`;
          color = paint.cyan;
        }
        break;
      }
      case 'skipped message':
        this.remember(f);
        body = `· ${this.chatLabel(chat)} · ${this.who(f)}, ignored: ${asString(f.reason)}`;
        color = paint.dim;
        break;
      case 'decision': {
        this.remember(f);
        const actions = Array.isArray(f.actions) ? f.actions.map(String) : [];
        body = `🧠 ${this.chatLabel(chat)}: ${actions.length === 0 ? 'nothing to do' : actions.join(', ')}`;
        break;
      }
      case 'sent': {
        const to = asString(f.to);
        const text = await this.text(to, asString(f.id), '');
        body = `📤 ${asString(f.purpose)} → ${this.chatLabel(to)}${text}`;
        color = paint.green;
        break;
      }
      case 'dry run: would send':
        body = `📝 would ${asString(f.purpose)} → ${this.chatLabel(asString(f.to))}${this.options.text ? `: ${oneLine(asString(f.text))}` : ''}`;
        color = paint.yellow;
        break;
      case 'dry run: would update the instructions':
        body = '📝 would update the instructions';
        color = paint.yellow;
        break;
      case 'instructions updated':
        body = '📝 instructions updated';
        color = paint.green;
        break;
      case 'notification for the owner':
        body = `🔔 ${this.options.text ? oneLine(asString(f.text)) : 'notification (no home chat set)'}`;
        color = paint.yellow;
        break;
      case 'model call failed':
        body = `✗ model call failed (${this.chatLabel(chat)}): ${asString(f.error)}`;
        color = paint.red;
        break;
      case 'send failed':
        body = `✗ send failed → ${this.chatLabel(asString(f.to))}: ${asString(f.error)}`;
        color = paint.red;
        break;
      case 'dropped an action':
        body = `⚠ dropped ${asString(f.action)}: ${asString(f.reason)}`;
        color = paint.yellow;
        break;
      case 'daily model call limit reached, skipping':
        body = `⚠ daily call limit reached, skipped ${this.chatLabel(chat)}`;
        color = paint.yellow;
        break;
      case 'wacli sync stopped, restarting':
        body = `⚠ wacli sync stopped, restarting in ${String(f.inSeconds ?? '?')}s`;
        color = paint.yellow;
        break;
      default:
        if (entry.message.startsWith('notification: ')) {
          body = `🔔 ${entry.message.slice('notification: '.length)}: ${asString(f.message)}`;
          color = paint.yellow;
        } else {
          const details = Object.keys(f).length === 0 ? '' : ` ${JSON.stringify(f)}`;
          if (entry.level === 'error') {
            body = `✗ ${entry.message}${details}`;
            color = paint.red;
          } else if (entry.level === 'warn') {
            body = `⚠ ${entry.message}${details}`;
            color = paint.yellow;
          } else {
            body = `${entry.message}${details}`;
            color = paint.dim;
          }
        }
    }

    const time = formatClock(entry.time, this.config.agent.timezone);
    return `${paint.dim(time)}  ${color(truncate(body, this.width() - time.length - 2))}`;
  }

  private remember(fields: LogFields): void {
    const chat = asString(fields.chat);
    const name = asString(fields.chatName);
    if (chat === '') return;
    if (name !== '') this.names.set(chat, name);
    else if (chatKind(chat) === 'direct' && !this.names.has(chat)) {
      const sender = asString(fields.sender);
      if (sender !== '' && sender !== 'me') this.names.set(chat, sender);
    }
  }

  private chatLabel(chat: string): string {
    if (chat !== '' && chat === this.config.agent.homeChat) return `${this.config.agent.name} chat`;
    return this.names.get(chat) ?? (chat.split('@')[0] || 'unknown chat');
  }

  private who(fields: LogFields): string {
    const sender = asString(fields.sender);
    return sender === 'me' ? 'you' : sender || 'someone';
  }

  private async text(chat: string, id: string, media: string): Promise<string> {
    const tag = media === '' ? '' : `[${media}] `;
    if (!this.options.text || chat === '' || id === '') return tag === '' ? '' : `: ${tag.trim()}`;
    const text = await this.lookup(chat, id);
    const content = `${tag}${oneLine(text ?? '')}`.trim();
    return content === '' ? '' : `: ${content}`;
  }
}

export interface FollowHandlers {
  /** The lines already in the file when following starts. */
  onInitial: (lines: string[]) => Promise<void>;
  onLine: (line: string) => Promise<void>;
  /** The file does not exist (yet). Called once until it appears. */
  onMissing?: () => void;
  pollMs?: number;
  signal?: AbortSignal;
}

const INITIAL_BYTES = 256 * 1024;

/** Follows a log file like `tail -F`: survives rotation and waits for the file to appear. */
export async function followFile(path: string, handlers: FollowHandlers): Promise<void> {
  const pollMs = handlers.pollMs ?? 500;
  let position = 0;
  let inode: number | undefined;
  let partial = '';
  let missingReported = false;

  const initial = await stat(path).catch(() => null);
  if (initial === null) {
    handlers.onMissing?.();
    missingReported = true;
    await handlers.onInitial([]);
  } else {
    inode = initial.ino;
    const start = Math.max(0, initial.size - INITIAL_BYTES);
    const lines = (await readRange(path, start, initial.size)).split('\n');
    if (start > 0) lines.shift();
    partial = lines.pop() ?? '';
    position = initial.size;
    await handlers.onInitial(lines);
  }

  while (handlers.signal?.aborted !== true) {
    await sleep(pollMs, handlers.signal);
    const current = await stat(path).catch(() => null);
    if (current === null) {
      if (!missingReported) handlers.onMissing?.();
      missingReported = true;
      continue;
    }
    missingReported = false;
    if (inode !== undefined && (current.ino !== inode || current.size < position)) {
      position = 0;
      partial = '';
    }
    inode = current.ino;
    if (current.size <= position) continue;
    const chunk = await readRange(path, position, current.size);
    position = current.size;
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) await handlers.onLine(line);
  }
}

/** `agentic-whatsapp stream`: shows what the agent does, live, until Ctrl+C. */
export async function stream(
  config: Config,
  options: StreamOptions,
  io: { write?: (line: string) => void; signal?: AbortSignal; pollMs?: number; lookup?: TextLookup } = {},
): Promise<void> {
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const wacli = new Wacli(config.wacli.command, config.wacli.store);
  const renderer = new StreamRenderer(config, options, io.lookup ?? ((chat, id) => wacli.messageText(chat, id)));
  const paint = painter(options.color);
  const show = async (entry: LogEntry | null) => {
    if (entry === null || !renderer.wants(entry)) return;
    const line = await renderer.render(entry);
    if (line !== null) write(line);
  };

  write(paint.dim(`Following ${config.paths.agentLog} · Ctrl+C to stop`));
  await followFile(config.paths.agentLog, {
    onInitial: async (lines) => {
      if (options.lines <= 0) return;
      const entries = lines.map(parseLogLine).filter((entry) => entry !== null && renderer.wants(entry));
      for (const entry of entries.slice(-options.lines)) await show(entry);
    },
    onLine: async (line) => show(parseLogLine(line)),
    onMissing: () =>
      write(paint.dim(`Waiting for ${config.paths.agentLog}. Is the agent running? Check with: agentic-whatsapp status`)),
    pollMs: io.pollMs,
    signal: io.signal,
  });
}

interface Painter {
  dim: (text: string) => string;
  bold: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  cyan: (text: string) => string;
  magenta: (text: string) => string;
}

function painter(enabled: boolean): Painter {
  const code = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    dim: code(2, 22),
    bold: code(1, 22),
    red: code(31, 39),
    green: code(32, 39),
    yellow: code(33, 39),
    cyan: code(36, 39),
    magenta: code(35, 39),
  };
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ⏎ ').trim();
}

function truncate(text: string, width: number): string {
  const chars = [...text];
  const limit = Math.max(20, width);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

async function readRange(path: string, start: number, end: number): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await file.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
