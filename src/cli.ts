#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AGENT_NAME_PATTERN, ConfigError, defaultConfigPath, loadConfig } from './config.js';
import { createEngine, engineLabel } from './engine.js';
import { launchdPlist } from './launchd.js';
import { runProcess } from './process.js';
import { systemPrompt } from './prompt.js';
import { runAgent } from './run.js';
import { configTemplate, instructionsTemplate } from './templates.js';
import { systemTimeZone } from './time.js';
import { errorMessage } from './util.js';
import { Wacli } from './wacli.js';

const HELP = `agentic-whatsapp: a personal WhatsApp agent powered by wacli and Antigravity CLI

Usage:
  agentic-whatsapp init --name <name> [--language <lang>] [--home-chat <jid>] [--force]
  agentic-whatsapp check [--call]
  agentic-whatsapp run [--dry-run] [--verbose]
  agentic-whatsapp launchd
  agentic-whatsapp help | --version

Commands:
  init      Create the config file and the instructions file
  check     Check the config, wacli and the engine (--call also makes one real model call)
  run       Run the agent in the foreground until Ctrl+C
  launchd   Print a macOS launchd agent that keeps "run" alive

Options:
  --config <file>   Config file (default: ${defaultConfigPath()})
  --dry-run         Decide, but log actions instead of sending or saving them
  --verbose         Also log skipped messages and wacli progress
`;

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      config: { type: 'string' },
      name: { type: 'string' },
      language: { type: 'string' },
      'home-chat': { type: 'string' },
      force: { type: 'boolean', default: false },
      call: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
  const configFile = resolve(values.config ?? defaultConfigPath());

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
      await runAgent(await loadConfig(configFile), { dryRun: values['dry-run'], verbose: values.verbose });
      return 0;
    case 'launchd':
      process.stdout.write(
        launchdPlist({
          node: process.execPath,
          script: fileURLToPath(import.meta.url),
          configFile,
          path: process.env.PATH ?? '/usr/bin:/bin',
        }),
      );
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
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
    `direct messages ${config.routing.directMessages ? 'on' : 'off'}, ${config.routing.groupAllowlist.length} allowlisted group(s)`,
  );

  const wacli = new Wacli(config.wacli.command, config.wacli.store);
  try {
    const version = await wacli.version();
    const auth = await wacli.authStatus();
    report(auth.authenticated, 'wacli', `${version}: ${auth.detail.split('\n')[0] ?? ''}`);
  } catch (error) {
    report(false, 'wacli', errorMessage(error));
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
    process.stderr.write(`${error instanceof ConfigError ? error.message : errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
