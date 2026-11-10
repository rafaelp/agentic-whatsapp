import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Agent } from './agent.js';
import type { Config } from './config.js';
import { createEngine } from './engine.js';
import { Health } from './health.js';
import { InstructionsStore } from './instructions.js';
import { createLogger, rotateIfLarge } from './log.js';
import { createNotifier } from './notify.js';
import { systemPrompt } from './prompt.js';
import { startReceiver } from './receiver.js';
import { AgentState } from './state.js';
import { errorMessage } from './util.js';
import { SyncSupervisor, Wacli } from './wacli.js';

const DRAIN_TIMEOUT_MS = 15_000;

export interface RunOptions {
  dryRun: boolean;
  verbose: boolean;
  /** Started by launchd: log to the log file only, and raise macOS notifications. */
  service: boolean;
}

/** Something the user has to fix before the agent can start. The service does not retry it. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * Runs the agent until SIGINT or SIGTERM: a webhook receiver on localhost, then
 * `wacli sync --follow` pointed at it. The webhook secret is random on every start,
 * so it is never stored anywhere. Everything is logged to the agent log, which
 * `agentic-whatsapp stream` and `logs` follow.
 */
export async function runAgent(config: Config, options: RunOptions): Promise<void> {
  const { paths, service } = config;
  if (options.service) rotateIfLarge(paths.launchdLog, service.logMaxBytes, service.logKeep);
  const log = createLogger({
    verbose: options.verbose,
    stderr: !options.service,
    file: { path: paths.agentLog, maxBytes: service.logMaxBytes, keep: service.logKeep },
  });
  const notify = createNotifier(log, options.service && service.notify);

  const wacli = new Wacli(config.wacli.command, config.wacli.store);
  let auth;
  try {
    auth = await wacli.authStatus();
  } catch (error) {
    throw new StartupError(errorMessage(error));
  }
  if (!auth.authenticated) {
    throw new StartupError(`WhatsApp is not linked. Run "wacli auth", then "agentic-whatsapp restart".\n${auth.detail}`);
  }

  const state = await AgentState.load(join(paths.stateDir, 'state.json'));
  const instructions = new InstructionsStore(paths.instructionsFile, join(paths.stateDir, 'instructions-history'));
  const engine = createEngine(config.engine, paths.stateDir, systemPrompt(config.agent));
  await engine.prepare();
  const health = new Health(paths.healthFile, notify, config.agent.name);

  const agent = new Agent({
    config,
    wacli,
    decider: engine,
    state,
    instructions,
    log,
    dryRun: options.dryRun,
    events: {
      onQueued: () => health.messageQueued(),
      onDecision: (error) => {
        if (error === undefined) {
          health.decided();
          health.succeeded('engine');
        } else {
          health.failed('engine', error);
        }
      },
    },
  });
  const secret = randomBytes(32).toString('hex');
  const receiver = await startReceiver({
    host: config.wacli.listenHost,
    port: config.wacli.listenPort,
    secret,
    onEvent: (payload) => agent.handleEvent(payload),
    log,
  });

  const sync = new SyncSupervisor(
    wacli,
    [
      'sync',
      '--follow',
      `--webhook=${receiver.url}`,
      `--webhook-secret=${secret}`,
      '--webhook-allow-private',
      ...config.wacli.syncArgs,
    ],
    log,
    {
      onExit: ({ code, signal, lastLine }) => {
        const how = signal === null ? `code ${String(code)}` : signal;
        health.failed('wacli', `wacli sync stopped (${how})${lastLine === '' ? '' : `: ${lastLine}`}`);
      },
      onHealthy: () => health.succeeded('wacli'),
    },
  );
  sync.start();

  if (config.agent.homeChat === '') {
    log.warn('agent.home_chat is not set: notifications only go to this log');
  }
  log.info('agent running', {
    name: config.agent.name,
    engine: config.engine.kind,
    model: config.engine.model,
    dryRun: options.dryRun,
    service: options.service,
    directMessages: config.routing.directMessages,
    allowlistedGroups: config.routing.groupAllowlist.length,
  });

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  log.info('stopping');
  await receiver.close();
  const dropped = agent.discardPending();
  if (dropped > 0) log.warn('dropped chats still waiting for their debounce', { chats: dropped });
  await Promise.race([agent.idle(), new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref())]);
  await sync.stop();
  await state.save();
  health.stopped();
  await health.save();
  log.info('stopped');
}
