import { type ActionContext, executePlan, planActions } from './actions.js';
import { Batcher } from './batcher.js';
import type { Config } from './config.js';
import type { DecisionMaker } from './decision.js';
import type { InstructionsStore } from './instructions.js';
import type { Logger } from './log.js';
import { buildPrompt } from './prompt.js';
import { type RoutingRules, routeMessage } from './router.js';
import type { AgentState } from './state.js';
import { dayKey } from './time.js';
import type { Action, Batch, ChatMessage, Decision } from './types.js';
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
  instructions: InstructionsStore;
  log: Logger;
  dryRun?: boolean;
  now?: () => Date;
  events?: AgentEvents;
}

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
    if (!state.markSeen(`${message.chat}/${message.id}`)) {
      log.debug('duplicate message', { chat: message.chat, id: message.id });
      return;
    }
    const route = routeMessage(message, this.rules, {
      now: this.now(),
      isAgentOutgoing: (candidate) => this.isAgentOutgoing(candidate),
    });
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
    const { config, state, log } = this.deps;
    const now = this.now();
    const invoked = batch.messages.some((message) => message.kind === 'command');
    const context: ActionContext = {
      chat: batch.chat,
      chatName: batch.chatName,
      replyAllowed: invoked || config.routing.autoReplyChats.includes(batch.chat),
      ownerCommand: batch.messages.some((message) => message.kind === 'command' && !message.forwarded),
    };

    const day = dayKey(now, config.agent.timezone);
    if (!state.tryConsumeCall(day, config.engine.maxCallsPerDay)) {
      log.warn('daily model call limit reached, skipping', { chat: batch.chat, messages: batch.messages.length });
      if (state.markCapNotified(day)) {
        await this.execute(
          [
            {
              type: 'notify',
              text: `⚠️ Daily limit of ${config.engine.maxCallsPerDay} model calls reached. New messages are ignored until tomorrow.`,
            },
          ],
          context,
        );
      }
      return;
    }

    const prompt = buildPrompt({
      agent: config.agent,
      instructions: await this.deps.instructions.read(),
      batch,
      history: await this.loadHistory(batch),
      replyAllowed: context.replyAllowed,
      now,
    });

    let decision: Decision;
    try {
      decision = await this.deps.decider.decide(prompt);
    } catch (error) {
      log.error('model call failed', { chat: batch.chat, error: errorMessage(error) });
      this.deps.events?.onDecision?.(errorMessage(error));
      if (invoked) {
        await this.execute([{ type: 'notify', text: `⚠️ Could not process your command: ${errorMessage(error)}` }], context);
      }
      return;
    }
    this.deps.events?.onDecision?.();
    for (const warning of decision.warnings) log.warn('model answer', { chat: batch.chat, warning });
    log.info('decision', {
      chat: batch.chat,
      chatName: batch.chatName || undefined,
      actions: decision.actions.map((action) => action.type),
    });
    await this.execute(decision.actions, context);
  }

  private enqueue(batch: Batch): void {
    this.queue = this.queue
      .then(() => this.processBatch(batch))
      .catch((error: unknown) => {
        this.deps.log.error('could not process a batch', { chat: batch.chat, error: errorMessage(error) });
      });
  }

  private async execute(actions: Action[], context: ActionContext): Promise<void> {
    const { config, wacli, state, instructions, log } = this.deps;
    await executePlan(planActions(actions, context, config.agent.homeChat), {
      wacli,
      state,
      instructions,
      agentName: config.agent.name,
      messagePrefix: config.agent.messagePrefix,
      dryRun: this.deps.dryRun ?? false,
      log,
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
