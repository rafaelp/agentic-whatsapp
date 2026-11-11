import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from './agent.js';
import type { Config } from './config.js';
import { Store } from './db.js';
import { createEngine, mediaReaderOf } from './engine.js';
import { Health } from './health.js';
import { InstructionsStore } from './instructions.js';
import { createLogger, rotateIfLarge } from './log.js';
import { MediaProcessor } from './media.js';
import { createNotifier } from './notify.js';
import { systemPrompt } from './prompt.js';
import { startReceiver } from './receiver.js';
import { settingsServer } from './settings-mcp.js';
import { LiveRouting } from './settings.js';
import { AgentState } from './state.js';
import { ToolRegistry } from './tools.js';
import { UsageLedger } from './usage.js';
import { errorMessage } from './util.js';
import { SyncSupervisor, Wacli } from './wacli.js';

const DRAIN_TIMEOUT_MS = 15_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
const DAILY_COST_CHECK_MS = 60_000;

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
 * `agentic-whatsapp logs` follows.
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

  const store = Store.open(paths.database);
  const state = new AgentState(store, { saveText: config.storage.saveText });
  const imported = await state.importLegacy(join(paths.stateDir, 'state.json'));
  if (imported > 0) log.info('imported state.json into the database', { entries: imported, database: paths.database });
  const usage = new UsageLedger(store, config.engine, config.costs, config.agent.timezone, config.storage.saveText);
  const registry = new ToolRegistry(store, paths.skillsDir);
  const tools = config.engine.kind === 'antigravity' ? registry : undefined;
  if (tools === undefined && hasEnabledTools(registry)) {
    log.warn('skills and MCP servers only work with engine.kind = "antigravity"; they are not used');
  }
  const prune = async () => {
    if (config.storage.retentionDays === 0) return;
    const before = new Date(Date.now() - config.storage.retentionDays * 86_400_000);
    try {
      const cleared = state.pruneText(before);
      if (cleared > 0) log.info('deleted old texts from the database', { rows: cleared, before: before.toISOString() });
      const files = state.takeMediaFiles(before);
      for (const file of files) await rm(file, { force: true });
      if (files.length > 0) log.info('deleted old images and audio', { files: files.length, before: before.toISOString() });
    } catch (error) {
      log.warn('could not delete old texts', { error: errorMessage(error) });
    }
  };
  await prune();
  const pruneTimer = setInterval(() => void prune(), PRUNE_EVERY_MS);
  pruneTimer.unref();

  const instructions = new InstructionsStore(paths.instructionsFile, join(paths.stateDir, 'instructions-history'));
  const engine = createEngine(config.engine, paths.stateDir, systemPrompt(config.agent));
  await engine.prepare();
  const reader = mediaReaderOf(engine);
  const readsMedia = config.media.images || config.media.audio;
  if (reader === undefined && readsMedia) {
    log.info('images and audio are only read with engine.kind = "antigravity"; the model sees just their type');
  }
  const media =
    reader === undefined || !readsMedia
      ? undefined
      : new MediaProcessor({
          config: config.media,
          agent: config.agent,
          dir: paths.mediaDir,
          wacli,
          reader,
          keepFiles: config.storage.saveText,
        });
  const health = new Health(paths.healthFile, notify, config.agent.name);

  const agent = new Agent({
    config,
    wacli,
    decider: engine,
    state,
    usage,
    tools,
    media,
    settingsServer: tools !== undefined && config.agent.settingsTools ? settingsServer(config, { dryRun: options.dryRun }) : undefined,
    routing: new LiveRouting({ configFile: paths.configFile, stateDir: paths.stateDir, logDir: paths.logDir }, config.routing, log),
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
  agent.reportDailyCost();
  const costTimer = setInterval(() => agent.reportDailyCost(), DAILY_COST_CHECK_MS);
  costTimer.unref();

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
    settingsTools: tools !== undefined && config.agent.settingsTools,
    skills: tools?.skills().filter((skill) => skill.enabled).length,
    mcpServers: tools?.servers().filter((server) => server.enabled).length,
    media: media === undefined ? undefined : [config.media.images && 'images', config.media.audio && 'audio'].filter(Boolean),
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
  clearInterval(pruneTimer);
  clearInterval(costTimer);
  store.close();
  health.stopped();
  await health.save();
  log.info('stopped');
}

function hasEnabledTools(registry: ToolRegistry): boolean {
  return registry.skills().some((skill) => skill.enabled) || registry.servers().some((server) => server.enabled);
}
