import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { type Config, ConfigError, parseConfig, type RoutingConfig } from './config.js';
import type { Logger } from './log.js';
import { errorMessage, writeFileAtomic } from './util.js';

/** The [routing] settings the agent may change itself, when the owner asks in the home chat. */
export interface RoutingUpdate {
  directMessages?: boolean;
  groupAllowlist?: string[];
  autoReplyChats?: string[];
}

/** A group JID, such as 120363000000000000@g.us. */
export const GROUP_JID = /^[\d-]+@g\.us$/;
/** A group, a contact or a hidden-number (lid) chat. */
export const CHAT_JID = /^[\d-]+@(g\.us|s\.whatsapp\.net|lid)$/;

/** Where the config file is and where its state goes, as parseConfig takes them. */
export interface ConfigLocation {
  configFile: string;
  stateDir: string;
  logDir?: string;
}

/**
 * The config file, edited key by key so the rest of it, comments included, stays as the
 * owner wrote it. Every change keeps the previous version in `historyDir`.
 */
export class ConfigFile {
  constructor(
    private readonly location: ConfigLocation,
    private readonly historyDir: string,
  ) {}

  get file(): string {
    return this.location.configFile;
  }

  async read(): Promise<Config> {
    return configFromText(await readFile(this.file, 'utf8'), this.location);
  }

  /**
   * Sets the given [routing] keys and returns the new config. The new file is parsed before
   * it is written, so a change that would break it, or that the file overrides somewhere
   * else, is refused and nothing is written.
   */
  async updateRouting(update: RoutingUpdate): Promise<Config> {
    const previous = await readFile(this.file, 'utf8');
    let text = previous;
    if (update.directMessages !== undefined) text = setTomlKey(text, 'routing', 'direct_messages', String(update.directMessages));
    if (update.groupAllowlist !== undefined) text = setTomlKey(text, 'routing', 'group_allowlist', tomlList(update.groupAllowlist));
    if (update.autoReplyChats !== undefined) text = setTomlKey(text, 'routing', 'auto_reply_chats', tomlList(update.autoReplyChats));
    const config = configFromText(text, this.location);
    const { routing } = config;
    const applied =
      (update.directMessages === undefined || routing.directMessages === update.directMessages) &&
      (update.groupAllowlist === undefined || sameList(routing.groupAllowlist, update.groupAllowlist)) &&
      (update.autoReplyChats === undefined || sameList(routing.autoReplyChats, update.autoReplyChats));
    if (!applied) throw new ConfigError(`Could not change [routing] in ${this.file}; edit it by hand`);
    if (text === previous) return config;

    await mkdir(this.historyDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(this.historyDir, `${stamp}.toml`), previous, { mode: 0o600 });
    await writeFileAtomic(this.file, text);
    return config;
  }
}

function configFromText(text: string, location: ConfigLocation): Config {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid TOML in ${location.configFile}: ${errorMessage(error)}`);
  }
  return parseConfig(raw, location);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** A TOML list of strings: on one line while it is short, one item per line after that. */
export function tomlList(items: readonly string[]): string {
  const quoted = items.map((item) => JSON.stringify(item));
  const line = `[${quoted.join(', ')}]`;
  return line.length <= 80 ? line : `[\n${quoted.map((item) => `  ${item},\n`).join('')}]`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sets `key = value` in a table of a TOML text, where `value` is already TOML. Replaces the
 * key where it is, values over several lines included; otherwise adds it under its
 * commented-out example, or at the end of the table, or adds the table.
 */
export function setTomlKey(text: string, table: string, key: string, value: string): string {
  const lines = text.split('\n');
  const header = new RegExp(`^\\s*\\[\\s*${escapeRegExp(table)}\\s*\\]\\s*(#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  const assignment = `${key} = ${value}`;
  if (start === -1) {
    const body = text.replace(/\s+$/, '');
    return `${body}${body === '' ? '' : '\n\n'}[${table}]\n${assignment}\n`;
  }
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;

  const setting = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const example = new RegExp(`^\\s*#\\s*${escapeRegExp(key)}\\s*=`);
  let after = -1;
  for (let index = start + 1; index < end; index++) {
    const line = lines[index] ?? '';
    if (setting.test(line)) {
      lines.splice(index, valueEnd(lines, index) - index + 1, assignment);
      return lines.join('\n');
    }
    if (after === -1 && example.test(line)) after = index + 1;
  }
  if (after === -1) {
    after = end;
    while (after > start + 1 && (lines[after - 1] ?? '').trim() === '') after--;
  }
  lines.splice(after, 0, assignment);
  return lines.join('\n');
}

/** The last line of the value that starts on line `first`, following brackets and strings. */
function valueEnd(lines: readonly string[], first: number): number {
  let depth = 0;
  for (let index = first; index < lines.length; index++) {
    const line = lines[index] ?? '';
    let position = index === first ? line.indexOf('=') + 1 : 0;
    let quote = '';
    for (; position < line.length; position++) {
      const char = line[position];
      if (quote !== '') {
        if (char === '\\' && quote === '"') position++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '#') {
        break;
      } else if (char === '[' || char === '{') {
        depth++;
      } else if (char === ']' || char === '}') {
        depth--;
      }
    }
    if (depth <= 0) return index;
  }
  return lines.length - 1;
}

/**
 * The [routing] settings, read again whenever the config file changes, so a change made from
 * the home chat, or by hand, applies to the next message without a restart. A file that
 * does not parse keeps the settings it had, with a warning.
 */
export class LiveRouting {
  private stamp: string;

  constructor(
    private readonly location: ConfigLocation,
    private routing: RoutingConfig,
    private readonly log: Logger,
  ) {
    this.stamp = fileStamp(location.configFile);
  }

  current(): RoutingConfig {
    const stamp = fileStamp(this.location.configFile);
    if (stamp === this.stamp) return this.routing;
    this.stamp = stamp;
    try {
      const next = configFromText(readFileSync(this.location.configFile, 'utf8'), this.location).routing;
      const change = routingChange(this.routing, next);
      this.routing = next;
      if (Object.keys(change).length > 0) this.log.info('settings changed', change);
    } catch (error) {
      this.log.warn('config file changed but could not be read; keeping the settings it had', { error: errorMessage(error) });
    }
    return this.routing;
  }
}

function fileStamp(file: string): string {
  try {
    const info = statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return '';
  }
}

/** What changed between two [routing] settings, for the log: chat IDs only. */
export function routingChange(before: RoutingConfig, after: RoutingConfig): Record<string, unknown> {
  const added = (a: readonly string[], b: readonly string[]) => b.filter((item) => !a.includes(item));
  const change: Record<string, unknown> = {};
  const lists = {
    monitoring: added(before.groupAllowlist, after.groupAllowlist),
    stoppedMonitoring: added(after.groupAllowlist, before.groupAllowlist),
    autoReplyOn: added(before.autoReplyChats, after.autoReplyChats),
    autoReplyOff: added(after.autoReplyChats, before.autoReplyChats),
  };
  for (const [name, chats] of Object.entries(lists)) if (chats.length > 0) change[name] = chats;
  if (before.directMessages !== after.directMessages) change.directMessages = after.directMessages;
  if (before.debounceSeconds !== after.debounceSeconds) change.debounceSeconds = after.debounceSeconds;
  if (before.maxMessageAgeMinutes !== after.maxMessageAgeMinutes) change.maxMessageAgeMinutes = after.maxMessageAgeMinutes;
  return change;
}
