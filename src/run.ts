import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Agent } from './agent.js';
import type { Config } from './config.js';
import { createEngine } from './engine.js';
import { InstructionsStore } from './instructions.js';
import { createLogger } from './log.js';
import { systemPrompt } from './prompt.js';
import { startReceiver } from './receiver.js';
import { AgentState } from './state.js';
import { SyncSupervisor, Wacli } from './wacli.js';

const DRAIN_TIMEOUT_MS = 15_000;

export interface RunOptions {
  dryRun: boolean;
  verbose: boolean;
}

/**
 * Runs the agent until SIGINT or SIGTERM: a webhook receiver on localhost, then
 * `wacli sync --follow` pointed at it. The webhook secret is random on every start,
 * so it is never stored anywhere.
 */
export async function runAgent(config: Config, options: RunOptions): Promise<void> {
  const log = createLogger({ verbose: options.verbose });
  const { stateDir } = config.paths;

  const wacli = new Wacli(config.wacli.command, config.wacli.store);
  const auth = await wacli.authStatus();
  if (!auth.authenticated) {
    throw new Error(`wacli is not authenticated. Run "wacli auth" first.\n${auth.detail}`);
  }

  const state = await AgentState.load(join(stateDir, 'state.json'));
  const instructions = new InstructionsStore(config.paths.instructionsFile, join(stateDir, 'instructions-history'));
  const engine = createEngine(config.engine, stateDir, systemPrompt(config.agent));
  await engine.prepare();

  const agent = new Agent({ config, wacli, decider: engine, state, instructions, log, dryRun: options.dryRun });
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
  log.info('stopped');
}
