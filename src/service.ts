import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import type { Config } from './config.js';
import { Store } from './db.js';
import { Health, type HealthSnapshot } from './health.js';
import { dayKey, formatLocalTime } from './time.js';
import { formatMoney, limitFor, PERIOD_NAMES, PERIODS, periodsOf, UsageLedger } from './usage.js';
import { Wacli } from './wacli.js';

export const LABEL = 'agentic-whatsapp';

/** Copied into the service when set, so it uses the same paths as the shell that installed it. */
export const ENV_KEYS = [
  'AGENTIC_WHATSAPP_STATE_DIR',
  'AGENTIC_WHATSAPP_LOG_DIR',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'WACLI_STORE_DIR',
] as const;

export function plistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const domain = (): string => `gui/${userInfo().uid}`;
const target = (): string => `${domain()}/${LABEL}`;

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Finds an executable like a shell does: a path as given, or the first match on PATH. */
export function resolveExecutable(command: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  const candidates = command.includes('/')
    ? [resolve(command)]
    : pathEnv
        .split(delimiter)
        .filter((dir) => dir !== '')
        .map((dir) => join(dir, command));
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

export interface PlistOptions {
  node: string;
  script: string;
  configFile: string;
  path: string;
  env: Record<string, string>;
  launchdLog: string;
}

/**
 * A launchd agent that runs `agentic-whatsapp run --service` at login and restarts it when
 * it crashes. A clean exit, which is how the agent stops on a problem the user has to fix,
 * does not restart it.
 */
export function buildPlist(options: PlistOptions): string {
  const args = [options.node, options.script, 'run', '--service', '--config', options.configFile];
  const env = { PATH: options.path, ...options.env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.launchdLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.launchdLog)}</string>
</dict>
</plist>
`;
}

/**
 * The plist for this installation. Node and the script are pinned by absolute path, so
 * switching the global Node of mise, nvm or asdf does not break the service, and PATH holds
 * the folders of wacli and the engine, which launchd's minimal PATH does not.
 */
export function plistFor(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const find = (command: string, setting: string): string => {
    const found = resolveExecutable(command, env.PATH);
    if (found === null) throw new Error(`${command} was not found on PATH. Install it, or set ${setting} to its full path.`);
    return found;
  };
  const wacli = find(config.wacli.command, 'wacli.command');
  const engine = find(config.engine.command, 'engine.command');
  const dirs = [dirname(process.execPath), dirname(wacli), dirname(engine), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const copied: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') copied[key] = value;
  }
  return buildPlist({
    node: process.execPath,
    script: cliScript(),
    configFile: config.paths.configFile,
    path: [...new Set(dirs)].join(':'),
    env: copied,
    launchdLog: config.paths.launchdLog,
  });
}

/** dist/cli.js when installed, src/cli.ts when running from a checkout. */
function cliScript(): string {
  return join(import.meta.dirname, `cli${extname(import.meta.filename)}`);
}

function requireMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('The background service uses launchd, so it only runs on macOS. On Linux, see contrib/systemd/.');
  }
}

function launchctl(args: string[], allowFailure = false): { ok: boolean; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0 && !allowFailure) throw new Error(`launchctl ${args[0] ?? ''} failed: ${output}`);
  return { ok: result.status === 0, output };
}

function isLoaded(): boolean {
  return launchctl(['print', target()], true).ok;
}

export async function install(config: Config): Promise<string[]> {
  requireMacOS();
  const plist = plistFor(config);
  const auth = await new Wacli(config.wacli.command, config.wacli.store).authStatus();
  if (!auth.authenticated) throw new Error('WhatsApp is not linked yet. Run "wacli auth" first, then install again.');

  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(config.paths.logDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, plist);
  const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
  if (lint.status !== 0) throw new Error(`The generated plist is invalid: ${lint.stdout}${lint.stderr}`);
  launchctl(['bootout', target()], true);
  launchctl(['bootstrap', domain(), file]);
  return [
    `installed ${file}`,
    `${config.agent.name} starts now and at every login, and restarts if it crashes`,
    `log: ${config.paths.agentLog}`,
    'watch it: agentic-whatsapp logs, or only what you asked to see: agentic-whatsapp stream',
  ];
}

export function uninstall(): string[] {
  requireMacOS();
  launchctl(['bootout', target()], true);
  const file = plistPath();
  if (existsSync(file)) unlinkSync(file);
  return [`removed ${file}`];
}

export function start(): string[] {
  requireMacOS();
  const file = plistPath();
  if (!existsSync(file)) throw new Error('The service is not installed. Run "agentic-whatsapp install".');
  if (isLoaded()) launchctl(['kickstart', target()]);
  else launchctl(['bootstrap', domain(), file]);
  return ['started'];
}

export function stop(): string[] {
  requireMacOS();
  launchctl(['bootout', target()], true);
  return ['stopped; it starts again at the next login, or with "agentic-whatsapp start"'];
}

export function restart(): string[] {
  requireMacOS();
  if (!isLoaded()) return start();
  launchctl(['kickstart', '-k', target()]);
  return ['restarted'];
}

/** Follows the agent log, across rotations, until Ctrl+C. */
export function followLog(config: Config): void {
  spawnSync('tail', ['-n', '50', '-F', config.paths.agentLog], { stdio: 'inherit' });
}

export interface LaunchdState {
  installed: boolean;
  loaded: boolean;
  state?: string;
  pid?: string;
  runs?: string;
  lastExitCode?: string;
}

export function launchdState(): LaunchdState {
  const installed = existsSync(plistPath());
  if (process.platform !== 'darwin') return { installed, loaded: false };
  const result = launchctl(['print', target()], true);
  if (!result.ok) return { installed, loaded: false };
  const field = (name: string) => new RegExp(`^\\s*${name} = (.*)$`, 'm').exec(result.output)?.[1]?.trim();
  return {
    installed,
    loaded: true,
    state: field('state'),
    pid: field('pid'),
    runs: field('runs'),
    lastExitCode: field('last exit code'),
  };
}

/** The lines `agentic-whatsapp status` prints. */
export async function statusLines(config: Config, now: Date = new Date()): Promise<string[]> {
  const zone = config.agent.timezone;
  const time = (iso: string | undefined) => (iso === undefined ? '-' : formatLocalTime(new Date(iso), zone));
  const launchd = launchdState();
  const health = await Health.read(config.paths.healthFile);
  const usage = openLedger(config);

  let service: string;
  if (!launchd.installed && !launchd.loaded) service = 'not installed (agentic-whatsapp install)';
  else if (!launchd.loaded) service = 'stopped (agentic-whatsapp start)';
  else {
    const details = [`pid ${launchd.pid ?? '-'}`, `started ${launchd.runs ?? '?'} time(s)`];
    if (launchd.lastExitCode !== undefined) details.push(`last exit ${launchd.lastExitCode}`);
    service = `${launchd.state ?? 'loaded'} (${details.join(', ')})`;
  }

  const lines = [
    `service   ${service}`,
    `agent     ${agentLine(health, time)}`,
    `calls     ${usage?.ledger.callsOn(dayKey(now, zone)) ?? 0} of ${config.engine.maxCallsPerDay} today`,
    `cost      ${costLine(config, usage?.ledger, now)}`,
    `wacli     ${componentLine(health?.wacli, time)}`,
    `engine    ${componentLine(health?.engine, time)} (${config.engine.kind}, ${config.engine.model})`,
    `log       ${config.paths.agentLog}`,
  ];
  if (usage !== undefined) lines.push(`database  ${config.paths.database}`);
  if (launchd.installed) lines.push(`plist     ${plistPath()}`);
  usage?.store.close();
  return lines;
}

/** The ledger of an existing database; undefined before the agent first ran, so status never creates one. */
export function openLedger(config: Config): { store: Store; ledger: UsageLedger } | undefined {
  if (!existsSync(config.paths.database)) return undefined;
  const store = Store.open(config.paths.database);
  return { store, ledger: new UsageLedger(store, config.engine, config.costs, config.agent.timezone) };
}

/** "$0.0867 today · $0.58 this week · $1.52 this month", with the limits that are set. */
export function costLine(config: Config, ledger: UsageLedger | undefined, now: Date): string {
  const money = (amount: number) => formatMoney(amount, config.costs.currency);
  const periods = periodsOf(now, config.agent.timezone);
  return PERIODS.map((period) => {
    const spent = ledger?.spent(period, periods[period]) ?? 0;
    const limit = limitFor(config.costs, period);
    return `${money(spent)}${limit > 0 ? ` of ${money(limit)}` : ''} ${PERIOD_NAMES[period].current}`;
  }).join(' · ');
}

function agentLine(health: HealthSnapshot | null, time: (iso: string | undefined) => string): string {
  if (health === null) return 'has not run yet';
  let run: string;
  if (health.stoppedAt !== undefined) run = `stopped at ${time(health.stoppedAt)}`;
  else if (isAlive(health.pid)) run = `up since ${time(health.startedAt)}`;
  else run = `not running (started ${time(health.startedAt)}, did not stop cleanly)`;
  return [run, `last message ${time(health.lastMessageAt)}`, `last decision ${time(health.lastDecisionAt)}`].join(' · ');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function componentLine(
  health: HealthSnapshot['wacli'] | undefined,
  time: (iso: string | undefined) => string,
): string {
  if (health === undefined) return '-';
  if (health.failures > 0) return `failing, ${health.failures} in a row (last ${time(health.lastErrorAt)}): ${health.lastError ?? ''}`;
  if (health.lastError !== undefined) return `ok (last error ${time(health.lastErrorAt)}: ${health.lastError})`;
  return 'ok';
}
