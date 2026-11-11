import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { type CommandRule, parseCommandRule } from './command-rules.js';
import { isValidTimeZone, systemTimeZone } from './time.js';
import { errorMessage, isNotFound, isRecord } from './util.js';

export interface AgentConfig {
  name: string;
  language: string;
  timezone: string;
  homeChat: string;
  messagePrefix: string;
  /** Lets the agent change [routing] when the owner asks in the home chat (Antigravity only). */
  settingsTools: boolean;
  /** Reaction put on the owner's commands while the agent works on them; empty: none. */
  workingReaction: string;
}

export interface RoutingConfig {
  directMessages: boolean;
  groupAllowlist: string[];
  autoReplyChats: string[];
  debounceSeconds: number;
  maxMessageAgeMinutes: number;
}

export type EngineKind = 'antigravity' | 'gemini-cli';

const ENGINE_DEFAULTS: Record<EngineKind, { command: string; model: string }> = {
  // -low answered 5 to 7 times faster than -medium with the same decisions in testing.
  antigravity: { command: 'agy', model: 'gemini-3.8-flash-low' },
  'gemini-cli': { command: 'gemini', model: 'gemini-3.8-flash' },
};

export interface EngineConfig {
  kind: EngineKind;
  command: string;
  model: string;
  timeoutSeconds: number;
  maxCallsPerDay: number;
  contextMessages: number;
  extraArgs: string[];
}

export interface WacliConfig {
  command: string;
  store: string;
  listenHost: string;
  listenPort: number;
  syncArgs: string[];
}

export interface ServiceConfig {
  logMaxBytes: number;
  logKeep: number;
  notify: boolean;
}

export interface CostsConfig {
  /** Label of the currency the prices are in. */
  currency: string;
  /** Prices per million tokens; unset ones come from the known prices of the model. */
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedPerMillion?: number;
  /** 0: no limit. */
  maxPerDay: number;
  maxPerWeek: number;
  maxPerMonth: number;
  /** Tell the owner once a limit is this far used up. 0: never. */
  warnPercent: number;
}

export interface StorageConfig {
  /** Keep message text, prompts, answers and sent text in the database. */
  saveText: boolean;
  /** Delete those texts after this many days; tokens and costs stay. 0: keep them. */
  retentionDays: number;
}

export interface MediaConfig {
  /** Describe images with the model. */
  images: boolean;
  /** Transcribe audio and voice notes with the model. */
  audio: boolean;
  /** Larger files are not downloaded. */
  maxBytes: number;
}

/** Command-line programs the agent may run for the owner, through its run_cli tool. */
export interface CliConfig {
  allow: CommandRule[];
  deny: CommandRule[];
  /** "commands": a command the owner typed, in any chat. "home": only in the home chat. */
  scope: 'commands' | 'home';
  timeoutSeconds: number;
}

export interface Paths {
  configFile: string;
  instructionsFile: string;
  stateDir: string;
  healthFile: string;
  /** SQLite database with messages, decisions, calls and costs, skills and MCP servers. */
  database: string;
  /** Installed copies of the skills. */
  skillsDir: string;
  /** Downloaded images and audio, one folder per chat. */
  mediaDir: string;
  logDir: string;
  /** Everything the agent logs, rotated by size. */
  agentLog: string;
  /** stdout and stderr of the launchd service: crashes and startup errors. */
  launchdLog: string;
}

export interface Config {
  agent: AgentConfig;
  routing: RoutingConfig;
  engine: EngineConfig;
  wacli: WacliConfig;
  service: ServiceConfig;
  costs: CostsConfig;
  storage: StorageConfig;
  media: MediaConfig;
  cli: CliConfig;
  paths: Paths;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const AGENT_NAME_PATTERN = /^[\p{L}\p{N}_-]{2,32}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTIC_WHATSAPP_CONFIG) return env.AGENTIC_WHATSAPP_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'agentic-whatsapp', 'config.toml');
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTIC_WHATSAPP_STATE_DIR) return env.AGENTIC_WHATSAPP_STATE_DIR;
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'agentic-whatsapp');
}

/** ~/Library/Logs/agentic-whatsapp on macOS, next to the state elsewhere. */
export function defaultLogDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AGENTIC_WHATSAPP_LOG_DIR) return env.AGENTIC_WHATSAPP_LOG_DIR;
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'agentic-whatsapp')
    : join(defaultStateDir(env), 'logs');
}

export function defaultMessagePrefix(name: string): string {
  return `🤖 ${name}: `;
}

export async function loadConfig(
  configFile: string = defaultConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  let text: string;
  try {
    text = await readFile(configFile, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw new ConfigError(
        `No config file at ${configFile}. Create one with: agentic-whatsapp init --name <name>`,
      );
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid TOML in ${configFile}: ${errorMessage(error)}`);
  }
  return parseConfig(raw, { configFile, stateDir: defaultStateDir(env), logDir: defaultLogDir(env) });
}

export function parseConfig(
  raw: unknown,
  location: { configFile: string; stateDir: string; logDir?: string },
): Config {
  if (!isRecord(raw)) throw new ConfigError('The config file must be a TOML table');
  const root = new Section(raw, '');

  const agentSection = root.section('agent');
  const name = agentSection.string('name').trim();
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `agent.name must be 2 to 32 letters, digits, "_" or "-" (got ${JSON.stringify(name)})`,
    );
  }
  const timezone = agentSection.string('timezone', systemTimeZone()).trim();
  if (!isValidTimeZone(timezone)) {
    throw new ConfigError(`agent.timezone is not a valid IANA time zone: ${JSON.stringify(timezone)}`);
  }
  const homeChat = agentSection.string('home_chat', '').trim();
  if (homeChat !== '') requireJid(homeChat, 'agent.home_chat');
  const agent: AgentConfig = {
    name,
    language: agentSection.string('language', 'en').trim(),
    timezone,
    homeChat,
    messagePrefix: agentSection.string('message_prefix', defaultMessagePrefix(name)),
    settingsTools: agentSection.boolean('settings_tools', true),
    workingReaction: agentSection.string('working_reaction', '✨').trim(),
  };
  agentSection.finish();

  const routingSection = root.section('routing');
  const routing: RoutingConfig = {
    directMessages: routingSection.boolean('direct_messages', true),
    groupAllowlist: routingSection.strings('group_allowlist', []),
    autoReplyChats: routingSection.strings('auto_reply_chats', []),
    debounceSeconds: routingSection.integer('debounce_seconds', 15, 0, 600),
    maxMessageAgeMinutes: routingSection.integer('max_message_age_minutes', 60, 0, 10_080),
  };
  for (const group of routing.groupAllowlist) {
    if (!group.endsWith('@g.us')) {
      throw new ConfigError(
        `routing.group_allowlist takes group JIDs ending in @g.us, and ${JSON.stringify(group)} is not one. ` +
          'Group names are not accepted because anyone in a group can rename it. List your groups with: wacli groups list',
      );
    }
  }
  for (const chat of routing.autoReplyChats) requireJid(chat, 'routing.auto_reply_chats');
  routingSection.finish();

  const engineSection = root.section('engine');
  const kind = engineSection.string('kind', 'antigravity').trim();
  if (kind !== 'antigravity' && kind !== 'gemini-cli') {
    throw new ConfigError(`engine.kind must be "antigravity" or "gemini-cli", got ${JSON.stringify(kind)}`);
  }
  const engine: EngineConfig = {
    kind,
    command: engineSection.string('command', ENGINE_DEFAULTS[kind].command),
    model: engineSection.string('model', ENGINE_DEFAULTS[kind].model),
    timeoutSeconds: engineSection.integer('timeout_seconds', 120, 10, 600),
    maxCallsPerDay: engineSection.integer('max_calls_per_day', 300, 1, 100_000),
    contextMessages: engineSection.integer('context_messages', 20, 0, 100),
    extraArgs: engineSection.strings('extra_args', []),
  };
  engineSection.finish();

  const wacliSection = root.section('wacli');
  const wacli: WacliConfig = {
    command: wacliSection.string('command', 'wacli'),
    store: wacliSection.string('store', ''),
    listenHost: wacliSection.string('listen_host', '127.0.0.1'),
    listenPort: wacliSection.integer('listen_port', 0, 0, 65_535),
    syncArgs: wacliSection.strings('sync_args', []),
  };
  if (!LOOPBACK_HOSTS.has(wacli.listenHost)) {
    throw new ConfigError(
      `wacli.listen_host must be a loopback address (127.0.0.1, ::1 or localhost), got ${JSON.stringify(wacli.listenHost)}`,
    );
  }
  wacliSection.finish();

  const serviceSection = root.section('service');
  const service: ServiceConfig = {
    logMaxBytes: serviceSection.integer('log_max_mb', 5, 1, 1024) * 1024 * 1024,
    logKeep: serviceSection.integer('log_keep', 5, 1, 50),
    notify: serviceSection.boolean('notify', true),
  };
  serviceSection.finish();

  const costsSection = root.section('costs');
  const costs: CostsConfig = {
    currency: costsSection.string('currency', 'USD').trim() || 'USD',
    inputPerMillion: costsSection.optionalNumber('input_per_million', 0, 1_000),
    outputPerMillion: costsSection.optionalNumber('output_per_million', 0, 1_000),
    cachedPerMillion: costsSection.optionalNumber('cached_per_million', 0, 1_000),
    maxPerDay: costsSection.optionalNumber('max_per_day', 0, 1_000_000) ?? 0,
    maxPerWeek: costsSection.optionalNumber('max_per_week', 0, 1_000_000) ?? 0,
    maxPerMonth: costsSection.optionalNumber('max_per_month', 0, 1_000_000) ?? 0,
    warnPercent: costsSection.integer('warn_percent', 80, 0, 99),
  };
  costsSection.finish();

  const storageSection = root.section('storage');
  const storage: StorageConfig = {
    saveText: storageSection.boolean('save_text', true),
    retentionDays: storageSection.integer('retention_days', 0, 0, 36_500),
  };
  storageSection.finish();

  const mediaSection = root.section('media');
  const media: MediaConfig = {
    images: mediaSection.boolean('images', true),
    audio: mediaSection.boolean('audio', true),
    maxBytes: mediaSection.integer('max_size_mb', 20, 1, 100) * 1024 * 1024,
  };
  mediaSection.finish();

  const cliSection = root.section('cli');
  const rules = (key: string): CommandRule[] =>
    cliSection.strings(key, []).map((text) => {
      const rule = parseCommandRule(text);
      if (typeof rule === 'string') throw new ConfigError(`cli.${key}: ${rule}`);
      return rule;
    });
  const scope = cliSection.string('scope', 'commands').trim();
  if (scope !== 'commands' && scope !== 'home') {
    throw new ConfigError(`cli.scope must be "commands" or "home", got ${JSON.stringify(scope)}`);
  }
  const cli: CliConfig = {
    allow: rules('allow'),
    deny: rules('deny'),
    scope,
    timeoutSeconds: cliSection.integer('timeout_seconds', 60, 1, 600),
  };
  cliSection.finish();
  root.finish();

  const logDir = location.logDir ?? join(location.stateDir, 'logs');
  return {
    agent,
    routing,
    engine,
    wacli,
    service,
    costs,
    storage,
    media,
    cli,
    paths: {
      configFile: location.configFile,
      instructionsFile: join(dirname(location.configFile), 'instructions.md'),
      stateDir: location.stateDir,
      healthFile: join(location.stateDir, 'health.json'),
      database: join(location.stateDir, 'agentic-whatsapp.db'),
      skillsDir: join(location.stateDir, 'skills'),
      mediaDir: join(location.stateDir, 'media'),
      logDir,
      agentLog: join(logDir, 'agent.log'),
      launchdLog: join(logDir, 'launchd.log'),
    },
  };
}

function requireJid(value: string, setting: string): void {
  if (!value.includes('@')) {
    throw new ConfigError(
      `${setting} takes chat JIDs such as 120363000000000000@g.us or 5511999999999@s.whatsapp.net, got ${JSON.stringify(value)}`,
    );
  }
}

/** One TOML table. Tracks which keys were read so unknown (misspelled) keys are rejected. */
class Section {
  private readonly used = new Set<string>();

  constructor(
    private readonly table: Record<string, unknown>,
    private readonly path: string,
  ) {}

  section(key: string): Section {
    const value = this.read(key);
    if (value === undefined) return new Section({}, this.label(key));
    if (!isRecord(value)) throw new ConfigError(`[${this.label(key)}] must be a table`);
    return new Section(value, this.label(key));
  }

  string(key: string, fallback?: string): string {
    const value = this.read(key);
    if (value === undefined) {
      if (fallback === undefined) throw new ConfigError(`${this.label(key)} is required`);
      return fallback;
    }
    if (typeof value !== 'string') throw new ConfigError(`${this.label(key)} must be a string`);
    return value;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.read(key);
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new ConfigError(`${this.label(key)} must be true or false`);
    return value;
  }

  integer(key: string, fallback: number, min: number, max: number): number {
    const value = this.read(key);
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`${this.label(key)} must be a whole number from ${min} to ${max}`);
    }
    return value;
  }

  /** A number, whole or not, or undefined when the key is absent. */
  optionalNumber(key: string, min: number, max: number): number | undefined {
    const value = this.read(key);
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new ConfigError(`${this.label(key)} must be a number from ${min} to ${max}`);
    }
    return value;
  }

  strings(key: string, fallback: string[]): string[] {
    const value = this.read(key);
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new ConfigError(`${this.label(key)} must be a list of strings`);
    }
    return value.map((item: string) => item.trim()).filter((item) => item !== '');
  }

  finish(): void {
    const unknown = Object.keys(this.table).filter((key) => !this.used.has(key));
    if (unknown.length > 0) {
      const where = this.path === '' ? 'the config file' : `[${this.path}]`;
      throw new ConfigError(`Unknown setting in ${where}: ${unknown.join(', ')}`);
    }
  }

  private read(key: string): unknown {
    this.used.add(key);
    return this.table[key];
  }

  private label(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }
}
