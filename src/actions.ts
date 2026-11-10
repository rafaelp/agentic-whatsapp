import type { InstructionsStore } from './instructions.js';
import type { Logger } from './log.js';
import { mentionPattern } from './router.js';
import type { AgentState } from './state.js';
import type { Action } from './types.js';
import { errorMessage } from './util.js';
import type { WacliClient } from './wacli.js';

export interface ActionContext {
  chat: string;
  chatName: string;
  /** The owner invoked the agent in this chat, or the chat is in auto_reply_chats. */
  replyAllowed: boolean;
  /** The batch has a command the owner typed (not forwarded), so instructions may change. */
  ownerCommand: boolean;
}

export type PlannedStep =
  | { kind: 'send'; to: string; text: string; purpose: 'notify' | 'reply' | 'suggestion' }
  | { kind: 'log'; text: string; reason: string }
  | { kind: 'write_instructions'; content: string }
  | { kind: 'drop'; action: Action['type']; reason: string };

/**
 * Applies the policy to what the model asked for. The model proposes; this decides:
 * notifications always go to the home chat, replies only where they are allowed
 * (otherwise they become a suggestion to the owner), and instructions only change
 * on a command the owner typed.
 */
export function planActions(actions: readonly Action[], context: ActionContext, homeChat: string): PlannedStep[] {
  const toOwner = (text: string, purpose: 'notify' | 'suggestion'): PlannedStep =>
    homeChat === ''
      ? { kind: 'log', text, reason: 'agent.home_chat is not set' }
      : { kind: 'send', to: homeChat, text, purpose };

  return actions.map((action): PlannedStep => {
    switch (action.type) {
      case 'notify':
        return toOwner(action.text, 'notify');
      case 'reply':
        if (context.replyAllowed) return { kind: 'send', to: context.chat, text: action.text, purpose: 'reply' };
        return toOwner(`↩️ ${context.chatName || context.chat}\n${action.text}`, 'suggestion');
      case 'update_instructions':
        return context.ownerCommand
          ? { kind: 'write_instructions', content: action.content }
          : { kind: 'drop', action: action.type, reason: 'instructions only change on a command the owner typed' };
    }
  });
}

/** Removes the "@" before the agent's name, so the agent never triggers itself. */
export function defuseMention(text: string, agentName: string): string {
  return text.replace(mentionPattern(agentName, 'giu'), (match) => match.slice(1));
}

export function formatOutgoing(text: string, agentName: string, prefix: string): string {
  return `${prefix}${defuseMention(text, agentName)}`;
}

export interface ActionRuntime {
  wacli: Pick<WacliClient, 'sendText'>;
  state: AgentState;
  instructions: InstructionsStore;
  agentName: string;
  messagePrefix: string;
  dryRun: boolean;
  log: Logger;
  /** The batch these steps answer, for the database. */
  batchId?: number;
}

export async function executePlan(plan: readonly PlannedStep[], runtime: ActionRuntime): Promise<void> {
  const { log, state, batchId } = runtime;
  for (const step of plan) {
    switch (step.kind) {
      case 'send': {
        const text = formatOutgoing(step.text, runtime.agentName, runtime.messagePrefix);
        const record = { batchId, chat: step.to, purpose: step.purpose, text };
        if (runtime.dryRun) {
          log.info('dry run: would send', { to: step.to, purpose: step.purpose, text });
          state.recordSent({ ...record, status: 'dry_run' });
          break;
        }
        state.noteOutgoing(step.to, text);
        try {
          const id = await runtime.wacli.sendText(step.to, text);
          state.recordSent({ ...record, status: 'sent', messageId: id });
          log.info('sent', { to: step.to, purpose: step.purpose, id });
        } catch (error) {
          state.recordSent({ ...record, status: 'failed', error: errorMessage(error) });
          log.error('send failed', { to: step.to, purpose: step.purpose, error: errorMessage(error) });
        }
        break;
      }
      case 'log':
        state.recordSent({ batchId, chat: '', purpose: 'notify', text: step.text, status: 'logged', error: step.reason });
        log.info('notification for the owner', { reason: step.reason, text: step.text });
        break;
      case 'write_instructions':
        if (runtime.dryRun) {
          log.info('dry run: would update the instructions', { content: step.content });
          break;
        }
        await runtime.instructions.write(step.content);
        log.info('instructions updated', { file: runtime.instructions.file });
        break;
      case 'drop':
        log.warn('dropped an action', { action: step.action, reason: step.reason });
        break;
    }
  }
}
