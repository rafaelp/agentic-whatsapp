import { type ActionContext, executePlan, planActions } from './actions.js';
import { Batcher } from './batcher.js';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Config, HookConfig, RoutingConfig } from './config.js';
import type { Attempt, DecisionMaker } from './decision.js';
import { downloadForHook, type HookRunner, hooksFor } from './hooks.js';
import type { InstructionsStore } from './instructions.js';
import type { Logger } from './log.js';
import type { MediaKind, MediaProcessor, MediaResult } from './media.js';
import { buildPrompt, buildTaskPrompt } from './prompt.js';
import { type RoutingRules, routeMessage } from './router.js';
import type { AgentState } from './state.js';
import { type Task, type TaskStore, taskResult } from './tasks.js';
import { dayKey, formatLocalTime, localHour, previousDay } from './time.js';
import type { LiveRouting } from './settings.js';
import type { McpServer, ToolRegistry, ToolSet } from './tools.js';
import type { Action, Batch, ChatMessage, Decision } from './types.js';
import { type CallContext, NO_USAGE, PERIOD_NAMES, type UsageLedger, addUsage, formatMoney } from './usage.js';
import { errorMessage } from './util.js';
import type { WacliClient } from './wacli.js';
import { chatKind, fromStoredMessage, fromWebhookPayload } from './whatsapp.js';

const MAX_BATCH_SIZE = 30;
/** Images and audio read per batch, and how many at a time. */
const MAX_MEDIA_PER_BATCH = 10;
const MEDIA_CONCURRENCY = 3;
/** The local hour from which the stream shows the cost of the day before. */
const DAILY_COST_HOUR = 1;
/** A task found this late, because the agent was off when it was due, is not run. */
const MAX_TASK_DELAY_MS = 12 * 3_600_000;

export interface AgentEvents {
  /** A message passed routing and is waiting for its batch. */
  onQueued?: () => void;
  /** The model answered (`error` undefined) or failed. */
  onDecision?: (error?: string) => void;
}

export interface AgentDeps {
  config: Config;
  wacli: WacliClient;
  decider: DecisionMaker;
  state: AgentState;
  usage: UsageLedger;
  /** Skills and MCP servers; absent when the engine cannot use them. */
  tools?: ToolRegistry;
  /** Reads images and audio; absent when the engine cannot, or both are off. */
  media?: MediaProcessor;
  /** The built-in server with the agent's own settings, offered for commands typed in the home chat. */
  settingsServer?: McpServer;
  /** The built-in server that runs the programs [cli] allows, offered for commands the owner typed. */
  cliServer?: McpServer;
  /** Runs the media hooks of [[hooks]]; absent when the engine cannot. */
  hookRunner?: HookRunner;
  /** [routing] as it is now in the config file; absent keeps the settings the agent started with. */
  routing?: LiveRouting;
  /** The tasks the owner scheduled, run when they are due; absent runs none. */
  tasks?: TaskStore;
  instructions: InstructionsStore;
  log: Logger;
  dryRun?: boolean;
  now?: () => Date;
  events?: AgentEvents;
}

/** Costs in the log, to a millionth of the currency. */
const roundCost = (cost: number): number => Math.round(cost * 1e6) / 1e6;

/** Routes incoming messages, batches them per chat and runs one decision per batch, in order. */
export class Agent {
  private readonly batcher: Batcher;
  private queue: Promise<void> = Promise.resolve();
  /** The working reaction being put on each command, by message ID, so it is removed only after. */
  private readonly reacting = new Map<string, Promise<void>>();
  /** Reactions still being removed, for idle(). */
  private readonly unreacting = new Set<Promise<void>>();
  /** Audio of followed chats whose transcript also goes to the home chat, by chat and ID. */
  private readonly forwardTranscripts = new Set<string>();
  /** Audio of chats nobody follows, transcribed one at a time for the home chat. */
  private transcriptions: Promise<void> = Promise.resolve();
  /** Due tasks already in the queue, by ID, so each one is queued once. */
  private readonly queuedTasks = new Set<number>();

  constructor(private readonly deps: AgentDeps) {
    const { routing } = deps.config;
    this.batcher = new Batcher({
      debounceMs: routing.debounceSeconds * 1000,
      maxBatchSize: MAX_BATCH_SIZE,
      onFlush: (batch) => this.enqueue(batch),
    });
  }

  /** Entry point for every webhook payload. */
  handleEvent(payload: unknown): void {
    const message = fromWebhookPayload(payload);
    if (message === null) return;
    const { state, log } = this.deps;
    // A deletion for everyone arrives as an empty message with the ID of the one deleted.
    if (message.revoked) {
      this.noteDeleted(message);
      return;
    }
    // A message can arrive first without content (e.g. only the group key it carries) and again,
    // with the same ID, once wacli has its text. Only messages with content count as seen.
    if (message.text.trim() === '' && message.mediaType === '') {
      log.debug('skipped message', { chat: message.chat, id: message.id, reason: 'no content' });
      return;
    }
    const route = routeMessage(message, this.rules(), {
      now: this.now(),
      isAgentOutgoing: (candidate) => this.isAgentOutgoing(candidate),
    });
    if (!state.recordMessage(message, route, this.now())) {
      log.debug('duplicate message', { chat: message.chat, id: message.id });
      return;
    }
    // Names and IDs only: message text never goes to the log.
    const fields = {
      chat: message.chat,
      chatName: message.chatName || undefined,
      id: message.id,
      sender: message.fromMe ? 'me' : message.senderName || message.sender || undefined,
      media: message.mediaType || undefined,
    };
    const hooks = this.hooksFor(message);
    if (hooks.length > 0) {
      this.enqueueHooks(message, hooks);
      // A file the hooks handle reaches a decision only with a caption, which says something more.
      if (route.process && message.text.trim() === '') {
        log.info('queued message', { ...fields, kind: 'hook', hooks: hooks.map((hook) => hook.name) });
        return;
      }
    }
    if (this.wantsTranscript(message)) {
      // A followed chat's audio is transcribed once, for the decision; the home chat gets that text.
      if (route.process) this.forwardTranscripts.add(messageKey(message));
      else this.transcribeForOwner(message);
    }
    if (!route.process) {
      log.debug('skipped message', { ...fields, reason: route.reason });
      return;
    }
    log.info('queued message', { ...fields, kind: route.kind });
    this.deps.events?.onQueued?.();
    this.batcher.add({ ...message, kind: route.kind });
    if (route.kind === 'command') this.react(message);
  }

  /**
   * Puts a message someone else deleted for everyone in the stream (agent.stream_deleted). It
   * never reaches the model, whatever the chat; the owner's own deletions are left alone.
   */
  private noteDeleted(message: ChatMessage): void {
    const { config, state, log } = this.deps;
    if (!config.agent.streamDeleted || message.fromMe || chatKind(message.chat) === 'other') return;
    try {
      const original = state.messagesById(message.chat, [message.id])[0];
      if (original?.fromMe === true) return;
      const chatName = message.chatName || state.chatName(message.chat);
      if (state.recordDeleted({ chat: message.chat, chatName, id: message.id }, this.now()) === undefined) return;
      log.info('message deleted', {
        chat: message.chat,
        chatName: chatName || undefined,
        id: message.id,
        sender: original?.senderName || message.senderName || message.sender || undefined,
        kept: original !== undefined && (original.text !== '' || original.media !== ''),
      });
    } catch (error) {
      log.warn('could not record a deleted message', { chat: message.chat, error: errorMessage(error) });
    }
  }

  /** Shows the owner the command was received: the working reaction, removed once it is handled. */
  private react(message: ChatMessage): void {
    const emoji = this.deps.config.agent.workingReaction;
    if (emoji === '' || this.deps.dryRun === true) return;
    const added = this.deps.wacli.sendReaction(message.chat, message.id, message.sender, emoji).catch((error: unknown) => {
      this.deps.log.warn('could not react', { chat: message.chat, id: message.id, error: errorMessage(error) });
    });
    this.reacting.set(message.id, added);
  }

  private unreact(batch: Batch): void {
    for (const message of batch.messages) this.unreactMessage(message);
  }

  private unreactMessage(message: ChatMessage): void {
    const added = this.reacting.get(message.id);
    if (added === undefined) return;
    this.reacting.delete(message.id);
    const removed = added
      .then(() => this.deps.wacli.sendReaction(message.chat, message.id, message.sender, ''))
      .catch((error: unknown) => {
        this.deps.log.warn('could not remove a reaction', { chat: message.chat, id: message.id, error: errorMessage(error) });
      })
      .finally(() => this.unreacting.delete(removed));
    this.unreacting.add(removed);
  }

  /** The [[hooks]] this message sets off, when the engine can run them and it is recent enough. */
  private hooksFor(message: ChatMessage): HookConfig[] {
    const { config, hookRunner } = this.deps;
    if (hookRunner === undefined || config.hooks.length === 0) return [];
    const maxAge = config.routing.maxMessageAgeMinutes;
    if (maxAge > 0 && this.now().getTime() - message.timestamp.getTime() > maxAge * 60_000) return [];
    return hooksFor(message, config.hooks, config.agent.homeChat);
  }

  /**
   * Runs the hooks of a file in the decision queue, since they share the tools workspace. A file
   * sent to the home chat gets the working reaction meanwhile.
   */
  private enqueueHooks(message: ChatMessage, hooks: readonly HookConfig[]): void {
    const home = message.chat === this.deps.config.agent.homeChat;
    if (home) this.react(message);
    this.queue = this.queue
      .then(async () => {
        for (const hook of hooks) await this.runHook(hook, message);
      })
      .catch((error: unknown) => {
        this.deps.log.error('could not run a hook', { chat: message.chat, error: errorMessage(error) });
      })
      .finally(() => {
        if (home) this.unreactMessage(message);
      });
  }

  /** Downloads the file, runs the hook's skill on it, and tells the owner what came of it. */
  private async runHook(hook: HookConfig, message: ChatMessage): Promise<void> {
    const { config, state, usage, log, wacli, hookRunner } = this.deps;
    if (hookRunner === undefined) return;
    const home = message.chat === config.agent.homeChat;
    const chatName = message.chatName || state.chatName(message.chat);
    const fields = { chat: message.chat, chatName: chatName || undefined, id: message.id, hook: hook.name };
    const tell = async (text: string) => {
      if (!hook.notify) return;
      const context: ActionContext = { chat: message.chat, chatName, replyAllowed: false, ownerCommand: false, messageIds: [] };
      await this.execute([{ type: 'notify', text }], context);
    };
    if (this.deps.dryRun === true) {
      log.info('dry run: would run a hook', fields);
      return;
    }
    const now = this.now();
    if (usage.callsOn(dayKey(now, config.agent.timezone)) >= config.engine.maxCallsPerDay || usage.limitReached(now) !== undefined) {
      log.info('hook skipped', { ...fields, reason: 'a call or cost limit was reached' });
      return;
    }
    const skill = this.deps.tools?.skills().find((candidate) => candidate.name === hook.skill && candidate.enabled);
    if (skill === undefined) {
      const reason = `the skill ${hook.skill} is not installed or is disabled`;
      log.warn('hook skipped', { ...fields, reason });
      await tell(`⚠️ Hook ${hook.name}: ${reason}.`);
      return;
    }
    const download = await downloadForHook(message, { dir: config.paths.mediaDir, maxBytes: config.media.maxBytes, wacli });
    if (!('file' in download)) {
      const reason = 'skipped' in download ? download.skipped : download.error;
      log.warn('hook skipped', { ...fields, reason });
      await tell(`⚠️ Hook ${hook.name}: could not get the file (${reason}).`);
      return;
    }
    const name = basename(download.file);
    const tools = [...(this.deps.cliServer === undefined ? [] : [this.deps.cliServer]), ...(this.deps.tools?.forBatch(home).mcp ?? [])];
    let cost = 0;
    try {
      const answer = await hookRunner.runHook(
        {
          hook,
          skill,
          file: download.file,
          message,
          chatName,
          home,
          language: config.agent.language,
          assistant: config.agent.name,
          timezone: config.agent.timezone,
        },
        {
          tools,
          onAttempt: (attempt) => {
            cost += this.recordAttempt(attempt, { chat: message.chat, chatName, purpose: 'hook' });
          },
        },
      );
      log.info('hook', { ...fields, file: name, cost: roundCost(cost) });
      await tell(`📎 ${name}\n${answer.trim()}`);
    } catch (error) {
      log.warn('hook failed', { ...fields, error: errorMessage(error), cost: roundCost(cost) });
      await tell(`⚠️ Hook ${hook.name} failed on ${name}: ${errorMessage(error)}`);
    } finally {
      if (config.storage.saveText) state.recordMediaFile(message.chat, message.id, download.file);
      else await rm(download.file, { force: true });
    }
  }

  /** Sends every waiting chat to the queue now, without waiting for the debounce. */
  flushPending(): void {
    this.batcher.flushAll();
  }

  /** Drops chats still waiting for their debounce; returns how many were dropped. */
  discardPending(): number {
    return this.batcher.clear();
  }

  /** Resolves when every queued batch and transcription has been processed, and reactions removed. */
  async idle(): Promise<void> {
    await this.queue;
    await this.transcriptions;
    await Promise.all([...this.unreacting]);
  }

  /** Decides one batch, then takes the working reaction off its commands, whatever happened. */
  async processBatch(batch: Batch): Promise<void> {
    try {
      await this.decideBatch(batch);
    } finally {
      this.unreact(batch);
      for (const message of batch.messages) this.forwardTranscripts.delete(messageKey(message));
    }
  }

  private async decideBatch(batch: Batch): Promise<void> {
    const { config, state, usage, log } = this.deps;
    const now = this.now();
    const invoked = batch.messages.some((message) => message.kind === 'command');
    const context: ActionContext = {
      chat: batch.chat,
      chatName: batch.chatName,
      replyAllowed: invoked || this.routing().autoReplyChats.includes(batch.chat),
      ownerCommand: batch.messages.some((message) => message.kind === 'command' && !message.forwarded),
      messageIds: batch.messages.map((message) => message.id),
    };
    const batchId = state.startBatch(batch, invoked, now);
    const money = (amount: number) => formatMoney(amount, config.costs.currency);

    const day = dayKey(now, config.agent.timezone);
    if (usage.callsOn(day) >= config.engine.maxCallsPerDay) {
      log.warn('daily model call limit reached, skipping', { chat: batch.chat, messages: batch.messages.length });
      state.finishBatch(batchId, { status: 'skipped', error: 'daily model call limit reached' }, this.now());
      if (state.markNotice(`calls:${day}`, now)) {
        const text = `⚠️ Daily limit of ${config.engine.maxCallsPerDay} model calls reached. New messages are ignored until tomorrow.`;
        await this.execute([{ type: 'notify', text }], context, batchId);
      }
      return;
    }

    const limit = usage.limitReached(now);
    if (limit !== undefined) {
      log.warn('cost limit reached, skipping', {
        chat: batch.chat,
        chatName: batch.chatName || undefined,
        period: limit.period,
        spent: roundCost(limit.spent),
        limit: limit.limit,
      });
      state.finishBatch(batchId, { status: 'skipped', error: `${limit.period} cost limit reached` }, this.now());
      if (state.markNotice(`cost:${limit.period}:${limit.key}`, now)) {
        const names = PERIOD_NAMES[limit.period];
        const text =
          `⚠️ ${names.adjective} cost limit of ${money(limit.limit)} reached (${money(limit.spent)} spent). ` +
          `New messages are ignored ${names.until}.`;
        await this.execute([{ type: 'notify', text }], context, batchId);
      }
      return;
    }

    batch = await this.readMedia(batch, batchId);
    const tools = this.toolsFor(context);
    const prompt = buildPrompt({
      agent: config.agent,
      instructions: await this.deps.instructions.read(),
      batch,
      history: await this.loadHistory(batch),
      replyAllowed: context.replyAllowed,
      now,
      tools,
    });

    let cost = 0;
    let tokens = NO_USAGE;
    const onAttempt = (attempt: Attempt) => {
      cost += this.recordAttempt(attempt, { batchId, chat: batch.chat, chatName: batch.chatName, prompt });
      tokens = addUsage(tokens, attempt.usage);
    };

    let decision: Decision;
    try {
      decision = await this.deps.decider.decide(prompt, { tools, onAttempt });
    } catch (error) {
      log.error('model call failed', { chat: batch.chat, error: errorMessage(error), cost: roundCost(cost) });
      state.finishBatch(batchId, { status: 'failed', error: errorMessage(error) }, this.now());
      this.deps.events?.onDecision?.(errorMessage(error));
      if (invoked) {
        await this.execute([{ type: 'notify', text: `⚠️ Could not process your command: ${errorMessage(error)}` }], context, batchId);
      }
      await this.warnNearLimits(context, batchId);
      return;
    }
    this.deps.events?.onDecision?.();
    for (const warning of decision.warnings) log.warn('model answer', { chat: batch.chat, warning });
    log.info('decision', {
      chat: batch.chat,
      chatName: batch.chatName || undefined,
      actions: decision.actions.map((action) => action.type),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cost: roundCost(cost),
    });
    state.finishBatch(batchId, { status: 'decided', decision }, this.now());
    await this.execute(decision.actions, context, batchId);
    await this.warnNearLimits(context, batchId);
  }

  /** [routing] as it is now: changes from the home chat, or to the file, apply without a restart. */
  private routing(): RoutingConfig {
    return this.deps.routing?.current() ?? this.deps.config.routing;
  }

  private rules(): RoutingRules {
    const { agent } = this.deps.config;
    const routing = this.routing();
    return {
      agentName: agent.name,
      homeChat: agent.homeChat,
      directMessages: routing.directMessages,
      directAllowlist: routing.directAllowlist,
      groupAllowlist: routing.groupAllowlist,
      maxMessageAgeMinutes: routing.maxMessageAgeMinutes,
    };
  }

  /**
   * The owner's skills and servers for the batch's scope, plus the built-in servers on a command
   * the owner typed: the CLI server (in the home chat only with [cli] scope "home"), and the
   * settings server in the home chat, where nobody else writes.
   */
  private toolsFor(context: ActionContext): ToolSet | undefined {
    const owned = this.deps.tools?.forBatch(context.ownerCommand);
    if (!context.ownerCommand) return owned;
    const { settingsServer, cliServer, config } = this.deps;
    const home = config.agent.homeChat !== '' && context.chat === config.agent.homeChat;
    const builtIn = [
      ...(settingsServer !== undefined && home ? [settingsServer] : []),
      ...(cliServer !== undefined && (home || config.cli.scope === 'commands') ? [cliServer] : []),
    ];
    if (builtIn.length === 0) return owned;
    return { mcp: [...builtIn, ...(owned?.mcp ?? [])], skills: owned?.skills ?? [] };
  }

  /**
   * Puts the cost of the day before in the stream, once, from 1 am local time on. The service
   * calls this every minute and when it starts, so a report missed while it was off comes
   * when it is back, as long as that is still the next day.
   */
  reportDailyCost(): void {
    const { config, state, usage, log } = this.deps;
    const now = this.now();
    const zone = config.agent.timezone;
    if (localHour(now, zone) < DAILY_COST_HOUR) return;
    const day = previousDay(dayKey(now, zone));
    try {
      if (!state.markNotice(`daily-cost:${day}`, now)) return;
      const totals = usage.totals('day', day);
      const { calls, inputTokens, outputTokens, cost } = totals;
      state.recordDailyCost({ day, calls, inputTokens, outputTokens, cost, currency: config.costs.currency }, now);
      log.info('daily cost', { day, calls, inputTokens, outputTokens, cost: roundCost(cost) });
    } catch (error) {
      log.warn('could not report the daily cost', { day, error: errorMessage(error) });
    }
  }

  /**
   * Queues the scheduled tasks that are due, to run one at a time with the decisions, since they
   * share the tools workspace. The service calls this every few seconds.
   */
  runDueTasks(): void {
    const { tasks, log } = this.deps;
    if (tasks === undefined) return;
    let due: Task[];
    try {
      due = tasks.due(this.now());
    } catch (error) {
      log.warn('could not read the scheduled tasks', { error: errorMessage(error) });
      return;
    }
    for (const task of due) {
      if (this.queuedTasks.has(task.id)) continue;
      this.queuedTasks.add(task.id);
      this.queue = this.queue
        .then(() => this.runTask(task))
        .catch((error: unknown) => {
          log.error('could not run a task', { task: task.id, error: errorMessage(error) });
        })
        .finally(() => this.queuedTasks.delete(task.id));
    }
  }

  /**
   * Fails the tasks that were running when the agent last stopped, and tells the owner: they are
   * not run again, since a message they were sending may have gone out. Called once at start.
   */
  failInterruptedTasks(): void {
    const { tasks, log } = this.deps;
    if (tasks === undefined) return;
    try {
      for (const task of tasks.failInterrupted(this.now())) {
        log.warn('task failed', { ...taskFields(task), reason: task.error });
        this.queue = this.queue.then(() => this.tellTaskFailed(task, task.error));
      }
    } catch (error) {
      log.warn('could not read the scheduled tasks', { error: errorMessage(error) });
    }
  }

  /** Runs a due task: a decision on the owner's words, in the chat the task is about. */
  private async runTask(task: Task): Promise<void> {
    const { config, tasks, state, usage, log } = this.deps;
    if (tasks === undefined) return;
    const now = this.now();
    // Cancelled meanwhile, or run by another agent process.
    if (!tasks.start(task.id, now)) return;
    const fields = taskFields(task);
    let cost = 0;
    const fail = async (status: 'failed' | 'missed', reason: string) => {
      try {
        tasks.finish(task.id, { status, error: reason }, this.now());
      } catch (error) {
        log.error('could not record a task', { ...fields, error: errorMessage(error) });
      }
      log.warn(status === 'missed' ? 'task missed' : 'task failed', { ...fields, reason, cost: cost > 0 ? roundCost(cost) : undefined });
      await this.tellTaskFailed(task, reason, status);
    };
    try {
      if (now.getTime() - task.dueAt.getTime() > MAX_TASK_DELAY_MS) {
        await fail('missed', 'the agent was not running when it was due');
        return;
      }
      if (usage.callsOn(dayKey(now, config.agent.timezone)) >= config.engine.maxCallsPerDay || usage.limitReached(now) !== undefined) {
        await fail('failed', 'a call or cost limit was reached');
        return;
      }
      const home = config.agent.homeChat;
      const chat = task.chat || home;
      const chatName = task.chat === '' ? '' : task.chatName || state.chatName(task.chat);
      const context: ActionContext = { chat, chatName, replyAllowed: chat !== '', ownerCommand: true, messageIds: [] };
      // The tools of a command typed in the home chat, wherever the task replies.
      const tools = this.toolsFor({ ...context, chat: home });
      const history = task.chat === '' || task.chat === home ? [] : await this.loadHistory({ chat: task.chat, chatName, messages: [] });
      const prompt = buildTaskPrompt({
        agent: config.agent,
        instructions: await this.deps.instructions.read(),
        task,
        chat: { id: chat, name: chatName },
        history,
        now,
        tools,
      });
      let tokens = NO_USAGE;
      let decision: Decision;
      try {
        decision = await this.deps.decider.decide(prompt, {
          tools,
          onAttempt: (attempt) => {
            cost += this.recordAttempt(attempt, { chat, chatName, prompt, purpose: 'task' });
            tokens = addUsage(tokens, attempt.usage);
          },
        });
      } catch (error) {
        await fail('failed', errorMessage(error));
        return;
      }
      for (const warning of decision.warnings) log.warn('model answer', { chat, warning });
      log.info('task', {
        ...fields,
        actions: decision.actions.map((action) => action.type),
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cost: roundCost(cost),
      });
      await this.execute(decision.actions, context);
      tasks.finish(task.id, { status: 'done', result: taskResult(decision.actions, chatName || chat.split('@')[0] || 'the chat') }, this.now());
      await this.warnNearLimits(context);
    } catch (error) {
      if (tasks.get(task.id)?.status !== 'running') throw error;
      await fail('failed', errorMessage(error));
    }
  }

  /** "⚠️ Scheduled task not run (Thu 2026-11-12 09:00, Carol): …", then what it said. */
  private async tellTaskFailed(task: Task, reason: string, status: 'failed' | 'missed' = 'failed'): Promise<void> {
    const { config } = this.deps;
    const zone = config.agent.timezone;
    const where = task.chat === '' ? '' : `, ${task.chatName || task.chat.split('@')[0]}`;
    const what = status === 'missed' ? 'not run' : 'failed';
    const text = `⚠️ Scheduled task ${what} (${formatLocalTime(task.dueAt, zone)}${where}): ${reason}${task.task === '' ? '' : `\n${task.task}`}`;
    const context: ActionContext = { chat: config.agent.homeChat, chatName: '', replyAllowed: false, ownerCommand: false, messageIds: [] };
    await this.execute([{ type: 'notify', text }], context);
  }

  /** Stores one run of the engine and logs it; returns its cost. */
  private recordAttempt(attempt: Attempt, call: CallContext): number {
    const { usage, log } = this.deps;
    try {
      const cost = usage.record(attempt, call);
      log.info('model call', {
        chat: call.chat,
        chatName: call.chatName || undefined,
        purpose: call.purpose === undefined || call.purpose === 'decision' ? undefined : call.purpose,
        attempt: attempt.attempt,
        status: attempt.status,
        seconds: Math.round(attempt.durationMs / 100) / 10,
        inputTokens: attempt.usage.inputTokens,
        outputTokens: attempt.usage.outputTokens,
        cachedTokens: attempt.usage.cachedTokens || undefined,
        thinkingTokens: attempt.usage.thinkingTokens || undefined,
        cost: roundCost(cost),
        tools: attempt.tools.length === 0 ? undefined : attempt.tools,
      });
      return cost;
    } catch (error) {
      log.error('could not record a model call', { chat: call.chat, error: errorMessage(error) });
      return 0;
    }
  }

  /**
   * Describes the images and transcribes the audio of a batch, a few at a time, and returns
   * the batch with that text on each message. A file that cannot be read gets a note instead.
   */
  private async readMedia(batch: Batch, batchId: number): Promise<Batch> {
    const { media, state, log } = this.deps;
    if (media === undefined) return batch;
    const pending = batch.messages.filter((message) => media.kindOf(message) !== undefined);
    if (pending.length === 0) return batch;

    const found = new Map<string, Pick<ChatMessage, 'mediaText' | 'mediaNote'>>();
    for (const message of pending.slice(MAX_MEDIA_PER_BATCH)) found.set(message.id, { mediaNote: 'too many files in one batch' });
    await forEachLimited(pending.slice(0, MAX_MEDIA_PER_BATCH), MEDIA_CONCURRENCY, async (message) => {
      const kind = media.kindOf(message) as MediaKind;
      const call: CallContext = { batchId, chat: batch.chat, chatName: batch.chatName, purpose: kind };
      let cost = 0;
      let tokens = NO_USAGE;
      const result = await media.read(message, {
        onAttempt: (attempt) => {
          cost += this.recordAttempt(attempt, call);
          tokens = addUsage(tokens, attempt.usage);
        },
      });
      if (result === undefined) return;
      try {
        state.recordMedia(message.chat, message.id, result);
      } catch (error) {
        log.error('could not store a description or transcript', { chat: message.chat, error: errorMessage(error) });
      }
      if (this.forwardTranscripts.delete(messageKey(message))) await this.sendTranscript(message, result);
      const fields = { chat: batch.chat, chatName: batch.chatName || undefined, id: message.id, kind };
      if (result.text !== undefined) {
        log.info('media read', {
          ...fields,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          cost: roundCost(cost),
        });
        found.set(message.id, { mediaText: result.text });
      } else if (result.skipped !== undefined) {
        log.info('media not read', { ...fields, reason: result.skipped });
        found.set(message.id, { mediaNote: result.skipped });
      } else {
        log.warn('could not read media', { ...fields, error: result.error, cost: roundCost(cost) });
        found.set(message.id, { mediaNote: kind === 'image' ? 'could not be described' : 'could not be transcribed' });
      }
    });
    return { ...batch, messages: batch.messages.map((message) => ({ ...message, ...found.get(message.id) })) };
  }

  /**
   * Whether media.audio_transcribe asks for this message's transcript in the home chat: audio
   * someone else sent, in a chat of the chosen kind, recent enough, and readable.
   */
  private wantsTranscript(message: ChatMessage): boolean {
    const { config, media } = this.deps;
    const mode = config.media.transcribe;
    if (mode === 'none' || media === undefined || message.fromMe || message.chat === config.agent.homeChat) return false;
    const kind = chatKind(message.chat);
    if (kind === 'other' || (mode !== 'both' && mode !== kind)) return false;
    const maxAge = config.routing.maxMessageAgeMinutes;
    if (maxAge > 0 && this.now().getTime() - message.timestamp.getTime() > maxAge * 60_000) return false;
    return media.kindOf(message) === 'audio';
  }

  /** Transcribes the audio of a chat nobody follows, for the home chat only: no decision is made. */
  private transcribeForOwner(message: ChatMessage): void {
    this.transcriptions = this.transcriptions
      .then(() => this.transcribeAlone(message))
      .catch((error: unknown) => {
        this.deps.log.error('could not transcribe an audio for the home chat', { chat: message.chat, error: errorMessage(error) });
      });
  }

  private async transcribeAlone(message: ChatMessage): Promise<void> {
    const { config, media, state, usage, log } = this.deps;
    if (media === undefined) return;
    const now = this.now();
    const fields = { chat: message.chat, chatName: message.chatName || undefined, id: message.id, kind: 'audio' };
    if (usage.callsOn(dayKey(now, config.agent.timezone)) >= config.engine.maxCallsPerDay || usage.limitReached(now) !== undefined) {
      log.info('media not read', { ...fields, reason: 'a call or cost limit was reached' });
      return;
    }
    const call: CallContext = { chat: message.chat, chatName: message.chatName, purpose: 'audio' };
    let cost = 0;
    let tokens = NO_USAGE;
    const result = await media.read(message, {
      onAttempt: (attempt) => {
        cost += this.recordAttempt(attempt, call);
        tokens = addUsage(tokens, attempt.usage);
      },
    });
    if (result === undefined) return;
    state.recordMedia(message.chat, message.id, result);
    if (result.text !== undefined) {
      log.info('media read', { ...fields, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, cost: roundCost(cost) });
    } else if (result.skipped !== undefined) {
      log.info('media not read', { ...fields, reason: result.skipped });
    } else {
      log.warn('could not read media', { ...fields, error: result.error, cost: roundCost(cost) });
    }
    await this.sendTranscript(message, result);
  }

  /**
   * Sends a transcript where media.audio_transcribe_to says: "🎤 Família · Carol", then what she
   * said, to the home chat, and an entry in the stream.
   */
  private async sendTranscript(message: ChatMessage, result: MediaResult): Promise<void> {
    const { config, state, log } = this.deps;
    const to = config.media.transcribeTo;
    const chatName = message.chatName || state.chatName(message.chat);
    const note = result.text === undefined ? (result.skipped ?? result.error ?? 'unknown error') : undefined;
    if (to === 'stream' || to === 'both') {
      try {
        state.recordTranscript({ chat: message.chat, chatName, id: message.id, note }, this.now());
      } catch (error) {
        log.error('could not put a transcript in the stream', { chat: message.chat, error: errorMessage(error) });
      }
    }
    if (to === 'home' || to === 'both') {
      const who = message.senderName || message.sender.split('@')[0] || 'someone';
      const label = chatKind(message.chat) === 'group' ? `${chatName || message.chat.split('@')[0]} · ${who}` : chatName || who;
      const text = note === undefined ? `🎤 ${label}\n${result.text ?? ''}` : `🎤 ${label}: audio not transcribed (${note})`;
      const context: ActionContext = { chat: message.chat, chatName, replyAllowed: false, ownerCommand: false, messageIds: [] };
      await this.execute([{ type: 'notify', text }], context);
    }
  }

  /** Tells the owner, once per period, that a cost limit is nearly used up. */
  private async warnNearLimits(context: ActionContext, batchId?: number): Promise<void> {
    const { config, state, usage } = this.deps;
    const now = this.now();
    for (const near of usage.nearLimits(now)) {
      if (!state.markNotice(`warn:${near.period}:${near.key}`, now)) continue;
      const percent = Math.floor((near.spent / near.limit) * 100);
      const money = (amount: number) => formatMoney(amount, config.costs.currency);
      const text = `📊 ${percent}% of the ${PERIOD_NAMES[near.period].adjective.toLowerCase()} cost limit used: ${money(near.spent)} of ${money(near.limit)}.`;
      await this.execute([{ type: 'notify', text }], context, batchId);
    }
  }

  private enqueue(batch: Batch): void {
    this.queue = this.queue
      .then(() => this.processBatch(batch))
      .catch((error: unknown) => {
        this.deps.log.error('could not process a batch', { chat: batch.chat, error: errorMessage(error) });
      });
  }

  private async execute(actions: Action[], context: ActionContext, batchId?: number): Promise<void> {
    const { config, wacli, state, instructions, log } = this.deps;
    await executePlan(planActions(actions, context, config.agent.homeChat), {
      wacli,
      state,
      instructions,
      agentName: config.agent.name,
      messagePrefix: config.agent.messagePrefix,
      dryRun: this.deps.dryRun ?? false,
      log,
      batchId,
    });
  }

  private async loadHistory(batch: Batch): Promise<ChatMessage[]> {
    const limit = this.deps.config.engine.contextMessages;
    if (limit === 0) return [];
    try {
      const batchIds = new Set(batch.messages.map((message) => message.id));
      const stored = await this.deps.wacli.listMessages(batch.chat, limit + batch.messages.length);
      const history = stored
        .map(fromStoredMessage)
        .filter((message) => !batchIds.has(message.id) && !message.reaction && !message.revoked)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .slice(-limit);
      // Images and audio read in earlier batches come back with their description or transcript.
      const withMedia = history.filter((message) => message.mediaType !== '').map((message) => message.id);
      const texts = withMedia.length === 0 ? new Map<string, string>() : this.deps.state.mediaTexts(batch.chat, withMedia);
      return history.map((message) => {
        const mediaText = texts.get(message.id);
        return mediaText === undefined ? message : { ...message, mediaText };
      });
    } catch (error) {
      this.deps.log.warn('could not load chat history', { chat: batch.chat, error: errorMessage(error) });
      return [];
    }
  }

  private isAgentOutgoing(message: ChatMessage): boolean {
    const { state, config } = this.deps;
    const prefix = config.agent.messagePrefix.trim();
    return (
      state.isAgentSent(message.id) ||
      state.isRecentOutgoing(message.chat, message.text) ||
      (prefix !== '' && message.text.startsWith(prefix))
    );
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** What the log says about a task. */
function taskFields(task: Task): Record<string, unknown> {
  return { task: task.id, chat: task.chat || undefined, chatName: task.chatName || undefined };
}

/** A message's chat and ID, which together identify it. */
function messageKey(message: Pick<ChatMessage, 'chat' | 'id'>): string {
  return `${message.chat}/${message.id}`;
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
