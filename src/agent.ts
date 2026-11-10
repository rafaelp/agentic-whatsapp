import { type ActionContext, executePlan, planActions } from './actions.js';
import { Batcher } from './batcher.js';
import type { Config } from './config.js';
import type { Attempt, DecisionMaker } from './decision.js';
import type { InstructionsStore } from './instructions.js';
import type { Logger } from './log.js';
import { buildPrompt } from './prompt.js';
import { type RoutingRules, routeMessage } from './router.js';
import type { AgentState } from './state.js';
import { dayKey } from './time.js';
import type { ToolRegistry } from './tools.js';
import type { Action, Batch, ChatMessage, Decision } from './types.js';
import { NO_USAGE, PERIOD_NAMES, type UsageLedger, addUsage, formatMoney } from './usage.js';
import { errorMessage } from './util.js';
import type { WacliClient } from './wacli.js';
import { fromStoredMessage, fromWebhookPayload } from './whatsapp.js';

const MAX_BATCH_SIZE = 30;

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
  private readonly rules: RoutingRules;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AgentDeps) {
    const { agent, routing } = deps.config;
    this.rules = {
      agentName: agent.name,
      homeChat: agent.homeChat,
      directMessages: routing.directMessages,
      groupAllowlist: routing.groupAllowlist,
      maxMessageAgeMinutes: routing.maxMessageAgeMinutes,
    };
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
    // A message can arrive first without content (e.g. only the group key it carries) and again,
    // with the same ID, once wacli has its text. Only messages with content count as seen.
    if (message.text.trim() === '' && message.mediaType === '') {
      log.debug('skipped message', { chat: message.chat, id: message.id, reason: 'no content' });
      return;
    }
    const route = routeMessage(message, this.rules, {
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
    if (!route.process) {
      log.debug('skipped message', { ...fields, reason: route.reason });
      return;
    }
    log.info('queued message', { ...fields, kind: route.kind });
    this.deps.events?.onQueued?.();
    this.batcher.add({ ...message, kind: route.kind });
  }

  /** Sends every waiting chat to the queue now, without waiting for the debounce. */
  flushPending(): void {
    this.batcher.flushAll();
  }

  /** Drops chats still waiting for their debounce; returns how many were dropped. */
  discardPending(): number {
    return this.batcher.clear();
  }

  /** Resolves when every queued batch has been processed. */
  idle(): Promise<void> {
    return this.queue;
  }

  async processBatch(batch: Batch): Promise<void> {
    const { config, state, usage, log } = this.deps;
    const now = this.now();
    const invoked = batch.messages.some((message) => message.kind === 'command');
    const context: ActionContext = {
      chat: batch.chat,
      chatName: batch.chatName,
      replyAllowed: invoked || config.routing.autoReplyChats.includes(batch.chat),
      ownerCommand: batch.messages.some((message) => message.kind === 'command' && !message.forwarded),
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

    const tools = this.deps.tools?.forBatch(context.ownerCommand);
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
      try {
        const attemptCost = usage.record(attempt, { batchId, chat: batch.chat, chatName: batch.chatName, prompt });
        cost += attemptCost;
        tokens = addUsage(tokens, attempt.usage);
        log.info('model call', {
          chat: batch.chat,
          chatName: batch.chatName || undefined,
          attempt: attempt.attempt,
          status: attempt.status,
          seconds: Math.round(attempt.durationMs / 100) / 10,
          inputTokens: attempt.usage.inputTokens,
          outputTokens: attempt.usage.outputTokens,
          cachedTokens: attempt.usage.cachedTokens || undefined,
          thinkingTokens: attempt.usage.thinkingTokens || undefined,
          cost: roundCost(attemptCost),
          tools: attempt.tools.length === 0 ? undefined : attempt.tools,
        });
      } catch (error) {
        log.error('could not record a model call', { chat: batch.chat, error: errorMessage(error) });
      }
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

  /** Tells the owner, once per period, that a cost limit is nearly used up. */
  private async warnNearLimits(context: ActionContext, batchId: number): Promise<void> {
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

  private async execute(actions: Action[], context: ActionContext, batchId: number): Promise<void> {
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
      return stored
        .map(fromStoredMessage)
        .filter((message) => !batchIds.has(message.id) && !message.reaction && !message.revoked)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .slice(-limit);
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
