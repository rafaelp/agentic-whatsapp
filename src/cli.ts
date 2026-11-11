#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_NAME_PATTERN, ConfigError, defaultConfigPath, loadConfig } from './config.js';
import { createEngine, engineLabel } from './engine.js';
import { createLogger } from './log.js';
import { createNotifier } from './notify.js';
import { runProcess } from './process.js';
import { systemPrompt } from './prompt.js';
import { runAgent, StartupError } from './run.js';
import { cliCheck, serveCli } from './commands.js';
import { serveSettings } from './settings-mcp.js';
import { Store } from './db.js';
import { mcpCommand, skillsCommand, splitConfigOption } from './manage.js';
import { costReport } from './report.js';
import {
  followLog,
  install,
  openLedger,
  plistFor,
  resolveExecutable,
  restart,
  servicePath,
  start,
  statusLines,
  stop,
  uninstall,
} from './service.js';
import { logs } from './logs.js';
import { stream } from './stream.js';
import { configTemplate, instructionsTemplate } from './templates.js';
import { systemTimeZone } from './time.js';
import { ToolError, ToolRegistry } from './tools.js';
import { formatMoney, formatPrice, limitFor, PERIODS, pricesFor } from './usage.js';
import { errorMessage } from './util.js';
import { Wacli } from './wacli.js';

const usage = (version: string) => `agentic-whatsapp ${version}: an AI assistant that reads your WhatsApp and tells you what matters

Usage: agentic-whatsapp <command> [options]

Commands:
  init        Create the config and instructions files (--name <name>, --language, --home-chat, --force)
  check       Check the config, wacli and the engine (--call also makes one real model call)
  run         Run the agent in the foreground until Ctrl+C (--dry-run, --verbose)
  install     Install and start the background service (macOS launchd)
  uninstall   Stop the service and delete its plist
  start       Start the installed service
  stop        Stop the service until the next start or login
  restart     Restart the service, e.g. after changing the config
  status      Show the service, today's activity and recent errors
  stream      What Ane highlighted as your instructions ask, and each day's cost at 1 am, live; clears the screen first (--no-text, --no-clear, --lines N)
  logs        Watch everything the agent does, live (--all, --no-text, --lines N, --verbose; --raw for the raw log)
  costs       Tokens and costs of today, this week, this month (--days N, --by day|chat|model|purpose, --json)
  mcp         Manage the MCP servers the agent may use (list, add, show, tools, scope, enable, disable, remove)
  skills      Manage the agent's skills (list, add, show, scope, enable, disable, remove)
  settings-mcp  The MCP server with the agent's own settings; Antigravity starts it (--dry-run)
  cli-mcp     The MCP server that runs the programs [cli] allows; Antigravity starts it (--dry-run)
  print       Print the plist that "install" writes
  help        Show this help
  version     Show the version

Options:
  --config <file>   Config file (default: ${defaultConfigPath()})

Settings live in the config file; see https://github.com/rafaelp/agentic-whatsapp#configuration
`;

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  const version = await packageVersion();
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage(version));
    return 0;
  }
  if (command === 'mcp' || command === 'skills') {
    // Their own flags, such as those of an MCP server command, are not the CLI's.
    const { config, args } = splitConfigOption(command, rest);
    const loaded = await loadConfig(resolve(config ?? defaultConfigPath()));
    const lines = command === 'mcp' ? await mcpCommand(loaded, args) : await skillsCommand(loaded, args);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  const { values } = parseArgs({
    args: rest,
    strict: true,
    allowNegative: true,
    options: {
      config: { type: 'string' },
      name: { type: 'string' },
      language: { type: 'string' },
      'home-chat': { type: 'string' },
      force: { type: 'boolean', default: false },
      call: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      service: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      text: { type: 'boolean', default: true },
      lines: { type: 'string' },
      raw: { type: 'boolean', default: false },
      clear: { type: 'boolean', default: true },
      days: { type: 'string', default: '7' },
      by: { type: 'string', default: 'day' },
      json: { type: 'boolean', default: false },
    },
  });
  const configFile = resolve(values.config ?? defaultConfigPath());
  const print = (lines: string[]) => process.stdout.write(`${lines.join('\n')}\n`);

  switch (command) {
    case 'init':
      return init(configFile, {
        name: values.name,
        language: values.language,
        homeChat: values['home-chat'],
        force: values.force,
      });
    case 'check':
      return check(configFile, values.call);
    case 'run':
      return run(configFile, { dryRun: values['dry-run'], verbose: values.verbose, service: values.service });
    case 'install':
      print(await install(await loadConfig(configFile)));
      return 0;
    case 'uninstall':
      print(uninstall());
      return 0;
    case 'start':
      print(start());
      return 0;
    case 'stop':
      print(stop());
      return 0;
    case 'restart':
      print(restart());
      return 0;
    case 'status':
      print(await statusLines(await loadConfig(configFile)));
      return 0;
    case 'stream':
      await stream(await loadConfig(configFile), {
        text: values.text,
        lines: count(values.lines, 10),
        color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
        clear: values.clear && process.stdout.isTTY === true,
      });
      return 0;
    case 'logs':
      if (values.raw) {
        followLog(await loadConfig(configFile));
        return 0;
      }
      await logs(await loadConfig(configFile), {
        all: values.all,
        text: values.text,
        verbose: values.verbose,
        lines: count(values.lines, 20),
        color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
      });
      return 0;
    case 'costs': {
      const by = values.by;
      if (by !== 'day' && by !== 'chat' && by !== 'model' && by !== 'purpose') {
        process.stderr.write('--by takes day, chat, model or purpose\n');
        return 2;
      }
      const days = Number.parseInt(values.days, 10);
      const config = await loadConfig(configFile);
      const opened = openLedger(config);
      try {
        print(costReport(config, opened?.ledger, new Date(), { days: Number.isFinite(days) ? Math.min(Math.max(days, 1), 366) : 7, by, json: values.json }));
      } finally {
        opened?.store.close();
      }
      return 0;
    }
    case 'cli-mcp':
      await serveCli(await loadConfig(configFile), { dryRun: values['dry-run'], version });
      return 0;
    case 'settings-mcp': {
      const config = await loadConfig(configFile);
      await serveSettings(config, {
        dryRun: values['dry-run'],
        version,
        chats: new Wacli(config.wacli.command, config.wacli.store),
      });
      return 0;
    }
    case 'print':
    case 'launchd':
      process.stdout.write(plistFor(await loadConfig(configFile)));
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${usage(version)}`);
      return 2;
  }
}

async function run(
  configFile: string,
  options: { dryRun: boolean; verbose: boolean; service: boolean },
): Promise<number> {
  try {
    await runAgent(await loadConfig(configFile), options);
    return 0;
  } catch (error) {
    if (!options.service || !(error instanceof ConfigError || error instanceof StartupError)) throw error;
    // launchd restarts the service when it fails; a problem the user has to fix would only
    // loop. Say so, and exit cleanly so it stays down until "agentic-whatsapp restart".
    const notify = createNotifier(createLogger(), true);
    notify('agentic-whatsapp could not start', errorMessage(error));
    return 0;
  }
}

async function init(
  configFile: string,
  options: { name: string | undefined; language: string | undefined; homeChat: string | undefined; force: boolean },
): Promise<number> {
  const name = options.name?.trim() ?? '';
  if (!AGENT_NAME_PATTERN.test(name)) {
    process.stderr.write('Choose a name for your agent with --name, e.g. --name Ane (2 to 32 letters or digits).\n');
    return 2;
  }
  if (!options.force && (await exists(configFile))) {
    process.stderr.write(`${configFile} already exists. Use --force to overwrite it.\n`);
    return 1;
  }

  const config = configTemplate({
    name,
    language: options.language ?? Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: systemTimeZone(),
    homeChat: options.homeChat ?? '',
  });
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(configFile, config, { mode: 0o600 });
  // Validates what was just written, e.g. a malformed --home-chat.
  const loaded = await loadConfig(configFile);
  process.stdout.write(`Created ${configFile}\n`);

  const instructionsFile = loaded.paths.instructionsFile;
  if (await exists(instructionsFile)) {
    process.stdout.write(`Kept ${instructionsFile}\n`);
  } else {
    await writeFile(instructionsFile, instructionsTemplate(name), { mode: 0o600 });
    process.stdout.write(`Created ${instructionsFile}\n`);
  }

  process.stdout.write(`
Next steps:
  1. Create a WhatsApp group with only you in it, for ${name} to talk to you.
  2. Find its JID with "wacli groups list" and set agent.home_chat in the config.
  3. Run "agentic-whatsapp check", then "agentic-whatsapp run --dry-run".
  4. When it looks right, "agentic-whatsapp install" keeps it running in the background.
`);
  return 0;
}

async function check(configFile: string, callModel: boolean): Promise<number> {
  let failures = 0;
  const report = (ok: boolean, label: string, detail: string) => {
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? '✔' : '✘'} ${label.padEnd(10)} ${detail}\n`);
  };
  const note = (label: string, detail: string) => process.stdout.write(`! ${label.padEnd(10)} ${detail}\n`);

  let config;
  try {
    config = await loadConfig(configFile);
    report(true, 'config', `${configFile} (agent "${config.agent.name}", trigger @${config.agent.name.toLowerCase()})`);
  } catch (error) {
    report(false, 'config', errorMessage(error));
    return 1;
  }

  if (config.agent.homeChat === '') note('home chat', 'not set: notifications will only be logged');
  else report(true, 'home chat', config.agent.homeChat);
  report(
    true,
    'routing',
    `${config.routing.directMessages ? 'every one-to-one chat' : `${config.routing.directAllowlist.length} allowlisted one-to-one chat(s)`}, ` +
      `${config.routing.groupAllowlist.length} allowlisted group(s), plus your commands`,
  );

  const wacli = new Wacli(config.wacli.command, config.wacli.store);
  try {
    const version = await wacli.version();
    const auth = await wacli.authStatus();
    report(auth.authenticated, 'wacli', `${version}: ${auth.detail.split('\n')[0] ?? ''}`);
  } catch (error) {
    report(false, 'wacli', errorMessage(error));
  }

  const prices = pricesFor(config.engine.model, config.costs);
  const money = (amount: number) => formatMoney(amount, config.costs.currency);
  const limits = PERIODS.filter((period) => limitFor(config.costs, period) > 0).map(
    (period) => `${money(limitFor(config.costs, period))}/${period}`,
  );
  const limitText = limits.length === 0 ? 'no cost limits' : `limits ${limits.join(', ')}`;
  if (prices.known) {
    const price = (amount: number) => formatPrice(amount, config.costs.currency);
    report(true, 'costs', `${price(prices.input)} in, ${price(prices.output)} out, ${price(prices.cached)} cached per 1M tokens; ${limitText}`);
  } else {
    note('costs', `no known prices for ${config.engine.model}: set input_per_million and output_per_million in [costs]; ${limitText}`);
  }

  const store = Store.open(config.paths.database);
  try {
    const registry = new ToolRegistry(store, config.paths.skillsDir);
    const skills = registry.skills().filter((skill) => skill.enabled);
    const servers = registry.servers().filter((server) => server.enabled);
    if (skills.length + servers.length > 0 && config.engine.kind !== 'antigravity') {
      note('tools', `${skills.length} skill(s) and ${servers.length} MCP server(s) are on, but only engine.kind = "antigravity" uses them`);
    } else {
      report(true, 'tools', `${skills.length} skill(s), ${servers.length} MCP server(s) enabled`);
    }
    for (const server of servers) {
      if (server.transport === 'stdio' && resolveExecutable(server.command) === null) {
        report(false, 'mcp', `${server.name}: ${server.command} was not found`);
      }
    }
  } finally {
    store.close();
  }
  report(true, 'database', config.paths.database);

  const kinds = [config.media.images && 'images described', config.media.audio && 'audio transcribed'].filter(Boolean);
  if (kinds.length === 0) report(true, 'media', 'off: the model sees only the type of images and audio');
  else if (config.engine.kind !== 'antigravity') note('media', 'only engine.kind = "antigravity" reads images and audio');
  else report(true, 'media', `${kinds.join(', ')}, up to ${config.media.maxBytes / 1024 / 1024} MB, in ${config.paths.mediaDir}`);
  if (config.media.transcribe !== 'none') {
    const chats = config.media.transcribe === 'both' ? 'every chat' : config.media.transcribe === 'direct' ? 'one-to-one chats' : 'groups';
    const to = config.media.transcribeTo === 'both' ? 'the home chat and the stream' : config.media.transcribeTo === 'home' ? 'the home chat' : 'the stream';
    if (config.engine.kind !== 'antigravity' || !config.media.audio) note('transcribe', 'needs engine.kind = "antigravity" and media.audio = true');
    else report(true, 'transcribe', `every audio in ${chats}, to ${to}`);
  }
  if (!config.agent.settingsTools) report(true, 'settings', 'off: change [routing] in the config file');
  else if (config.engine.kind !== 'antigravity') note('settings', 'only engine.kind = "antigravity" lets the agent change its settings');
  else report(true, 'settings', 'on, for commands you type in the home chat');
  for (const line of cliCheck(config, { path: process.env.PATH ?? '', servicePath: servicePath() })) {
    if (line.status === 'note') note('cli', line.detail);
    else report(line.status === 'ok', 'cli', line.detail);
  }

  const { engine } = config;
  const label = engineLabel(engine.kind);
  try {
    const result = await runProcess(engine.command, ['--version'], { timeoutMs: 30_000 });
    report(result.code === 0, 'engine', `${label} ${result.stdout.trim()} (${engine.command}), model ${engine.model}`);
  } catch (error) {
    report(false, 'engine', `could not start ${engine.command}: ${errorMessage(error)}`);
  }

  if (callModel) {
    const decider = createEngine(engine, config.paths.stateDir, systemPrompt(config.agent));
    try {
      await decider.prepare();
      const started = Date.now();
      const decision = await decider.decide(
        'Connectivity test from agentic-whatsapp. There are no messages. Answer with {"actions": []}.',
      );
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      report(true, 'model call', `answered in ${seconds}s with ${decision.actions.length} action(s)`);
    } catch (error) {
      report(false, 'model call', errorMessage(error));
    }
  }

  return failures === 0 ? 0 : 1;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** package.json sits one level up both from src/ (checkout) and from dist/ (npm install). */
async function packageVersion(): Promise<string> {
  const file = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await readFile(file, 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const known = error instanceof ConfigError || error instanceof ToolError;
    process.stderr.write(`agentic-whatsapp: ${known ? error.message : errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);

/** A --lines value, or `fallback` when it is missing or not a number. */
function count(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
