import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import { Store } from './db.js';
import { oneLine, type Painter, painter, sleep, type TextLookup } from './logs.js';
import { AgentState, type DailyCost, type Highlight, type StoredText } from './state.js';
import { dayKey, formatClock, formatLocalTime } from './time.js';
import { formatMoney, formatTokens } from './usage.js';
import { Wacli } from './wacli.js';
import { chatKind } from './whatsapp.js';

export interface StreamOptions {
  /** Earlier highlights to show when starting. */
  lines: number;
  /** Show the text of the highlighted messages. Off shows who wrote and why it matters. */
  text: boolean;
  color: boolean;
  /** Clear the terminal, scrollback included, before the first line. */
  clear: boolean;
}

/** Cursor home, clear the screen, clear the scrollback: what `clear` does in a macOS terminal. */
export const CLEAR_SCREEN = '\x1b[H\x1b[2J\x1b[3J';

/** Indent of the lines under a highlight's header, the width of "HH:MM:SS  ". */
const INDENT = ' '.repeat(10);

/** A message's media type, text and description or transcript, on one line. */
function describe(message: Pick<StoredText, 'media' | 'text' | 'mediaText'>): string {
  const parts = [message.media === '' ? '' : `[${message.media}]`, oneLine(message.text), oneLine(message.mediaText)];
  return parts.filter((part) => part !== '').join(' ');
}

/** Turns a highlight and its messages into the lines `agentic-whatsapp stream` prints. */
export class HighlightRenderer {
  private readonly paint: Painter;

  constructor(
    private readonly config: Config,
    private readonly options: Pick<StreamOptions, 'text' | 'color'>,
    private readonly lookup: TextLookup,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.paint = painter(options.color);
  }

  async render(highlight: Highlight, messages: readonly StoredText[]): Promise<string[]> {
    const { paint } = this;
    const zone = this.config.agent.timezone;
    const time =
      dayKey(highlight.at, zone) === dayKey(this.now(), zone) ? formatClock(highlight.at, zone) : formatLocalTime(highlight.at, zone);
    if (highlight.kind === 'daily_cost') return [`${paint.dim(time)}  ${this.costLine(highlight.dailyCost)}`];
    if (highlight.kind === 'deleted') return this.deleted(time, highlight, messages[0]);
    if (highlight.kind === 'transcript') return this.transcript(time, highlight, messages[0]);
    const lines = [`${paint.dim(time)}  ${paint.bold(paint.magenta(`★ ${this.chatLabel(highlight, messages)}`))}`];
    for (const message of messages) {
      const who = message.fromMe ? 'you' : message.senderName || message.sender.split('@')[0] || 'someone';
      const content = this.options.text ? await this.content(highlight.chat, message) : '';
      lines.push(`${INDENT}${paint.cyan(who)}${content === '' ? '' : `: ${content}`}`);
    }
    if (highlight.text !== '') lines.push(`${INDENT}${paint.yellow(`↳ ${oneLine(highlight.text)}`)}`);
    return lines;
  }

  /** "Σ Costs of 2026-11-09: $0.4213 in 37 model calls · 1.25M tokens in, 31k out" */
  private costLine(daily: DailyCost | undefined): string {
    const { paint } = this;
    if (daily === undefined) return paint.green('Σ Costs');
    const calls = `${daily.calls} model call${daily.calls === 1 ? '' : 's'}`;
    const tokens = `${formatTokens(daily.inputTokens)} tokens in, ${formatTokens(daily.outputTokens)} out`;
    return `${paint.bold(paint.green(`Σ Costs of ${daily.day}: ${formatMoney(daily.cost, daily.currency)} in ${calls}`))}${paint.dim(` · ${tokens}`)}`;
  }

  private chatLabel(highlight: Highlight, messages: readonly StoredText[]): string {
    if (highlight.chat === this.config.agent.homeChat) return `${this.config.agent.name} chat`;
    if (highlight.chatName !== '') return highlight.chatName;
    // A one-to-one chat often comes without a name; the contact's own name is the next best.
    const contact = chatKind(highlight.chat) === 'direct' ? messages.find((message) => !message.fromMe)?.senderName : undefined;
    return contact || highlight.chat.split('@')[0] || 'unknown chat';
  }

  /** The text, caption, description or transcript of a message, read from the wacli archive when the database kept none. */
  private async content(chat: string, message: StoredText): Promise<string> {
    let text = message.text;
    if (text === '' && message.mediaText === '') text = (await this.lookup(chat, message.id)) ?? '';
    return describe({ ...message, text });
  }

  /** "🎤 Família · Carol", then what the audio said, or why it was not transcribed. */
  private transcript(time: string, highlight: Highlight, message: StoredText | undefined): string[] {
    const { paint } = this;
    const who = message === undefined ? 'someone' : message.senderName || message.sender.split('@')[0] || 'someone';
    const label = this.chatLabel(highlight, message === undefined ? [] : [message]);
    const where = chatKind(highlight.chat) === 'group' ? `${label} · ${who}` : label;
    const lines = [`${paint.dim(time)}  ${paint.bold(paint.blue(`🎤 ${where}`))}`];
    if (this.options.text) {
      const said = message === undefined ? '' : oneLine(message.mediaText);
      lines.push(`${INDENT}${said !== '' ? said : paint.dim(`(not transcribed${highlight.note === undefined ? '' : `: ${highlight.note}`})`)}`);
    }
    return lines;
  }

  /**
   * "🗑 Família · Carol deleted a message", then what it said. wacli clears a deleted message
   * from its archive, so only the database has it.
   */
  private deleted(time: string, highlight: Highlight, message: StoredText | undefined): string[] {
    const { paint } = this;
    const who = message === undefined ? 'someone' : message.senderName || message.sender.split('@')[0] || 'someone';
    const label = this.chatLabel(highlight, message === undefined ? [] : [message]);
    const where = chatKind(highlight.chat) === 'group' ? `${label} · ${who}` : label;
    const lines = [`${paint.dim(time)}  ${paint.bold(paint.red(`🗑 ${where} deleted a message`))}`];
    if (this.options.text) {
      const content = message === undefined ? '' : describe(message);
      lines.push(`${INDENT}${content === '' ? paint.dim('(its text was not kept)') : content}`);
    }
    return lines;
  }
}

/**
 * `agentic-whatsapp stream`: only the messages Ane highlighted, following the owner's
 * instructions, and the cost of each day the next morning, until Ctrl+C. Entries come from
 * the database, so they survive restarts and keep message text out of the log.
 */
export async function stream(
  config: Config,
  options: StreamOptions,
  io: { write?: (line: string) => void; signal?: AbortSignal; pollMs?: number; lookup?: TextLookup; now?: () => Date } = {},
): Promise<void> {
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const pollMs = io.pollMs ?? 1_000;
  const paint = painter(options.color);
  const wacli = new Wacli(config.wacli.command, config.wacli.store);
  const renderer = new HighlightRenderer(config, options, io.lookup ?? ((chat, id) => wacli.messageText(chat, id)), io.now);

  write(`${options.clear ? CLEAR_SCREEN : ''}${paint.dim(`Highlights from ${config.agent.name} · Ctrl+C to stop`)}`);
  let waiting = false;
  while (!existsSync(config.paths.database)) {
    if (!waiting) write(paint.dim(`Waiting for ${config.paths.database}. Is the agent running? Check with: agentic-whatsapp status`));
    waiting = true;
    await sleep(pollMs, io.signal);
    if (io.signal?.aborted === true) return;
  }

  const store = Store.open(config.paths.database);
  const state = new AgentState(store);
  const show = async (highlight: Highlight) => {
    const messages = highlight.kind === 'daily_cost' ? [] : state.messagesById(highlight.chat, highlight.ids);
    for (const line of await renderer.render(highlight, messages)) write(line);
  };
  try {
    let last = state.lastHighlightId();
    const recent = options.lines > 0 ? state.recentHighlights(options.lines) : [];
    if (last === 0) {
      write(
        paint.dim(
          `Nothing highlighted yet. Tell ${config.agent.name} in the home chat what you want to see here, ` +
            'such as: highlight the messages from Carol.',
        ),
      );
    }
    for (const highlight of recent) await show(highlight);
    while (io.signal?.aborted !== true) {
      await sleep(pollMs, io.signal);
      for (const highlight of state.highlightsAfter(last)) {
        await show(highlight);
        last = highlight.id;
      }
    }
  } finally {
    store.close();
  }
}
