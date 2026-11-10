import type { ChatMessage, MessageKind } from './types.js';
import { chatKind } from './whatsapp.js';

export interface RoutingRules {
  agentName: string;
  homeChat: string;
  directMessages: boolean;
  groupAllowlist: readonly string[];
  maxMessageAgeMinutes: number;
}

export type Route = { process: true; kind: MessageKind } | { process: false; reason: string };

export interface RouteContext {
  now: Date;
  /** True for messages the agent itself sent, which come back as the owner's own messages. */
  isAgentOutgoing: (message: ChatMessage) => boolean;
}

/**
 * Matches "@name" as a standalone word: "@ane", "@Ane," and "(@ane)" match,
 * "@anelise" and "x@ane" do not.
 */
export function mentionPattern(name: string, flags = 'iu'): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_@.])@${escaped}(?![\\p{L}\\p{N}_])`, flags);
}

export function mentionsAgent(text: string, agentName: string): boolean {
  return mentionPattern(agentName).test(text.normalize('NFC'));
}

/**
 * Decides whether a message goes to the model:
 *
 * - your own message mentioning the agent, in any chat: command
 * - your own message in the home chat: command
 * - a direct conversation: message (when direct_messages is on)
 * - a group: message, only when its JID is in the allowlist
 * - anything else: skipped
 */
export function routeMessage(message: ChatMessage, rules: RoutingRules, context: RouteContext): Route {
  if (message.reaction) return skip('reaction');
  if (message.revoked) return skip('deleted message');
  if (message.edited) return skip('edited message');
  if (message.text.trim() === '' && message.mediaType === '') return skip('no content');

  if (rules.maxMessageAgeMinutes > 0) {
    const ageMinutes = (context.now.getTime() - message.timestamp.getTime()) / 60_000;
    if (ageMinutes > rules.maxMessageAgeMinutes) return skip('older than max_message_age_minutes');
  }

  const kind = chatKind(message.chat);
  if (kind === 'other') return skip('status, channel or broadcast');

  if (message.fromMe) {
    if (context.isAgentOutgoing(message)) return skip('sent by the agent');
    if (rules.homeChat !== '' && message.chat === rules.homeChat) return { process: true, kind: 'command' };
    // A forwarded message carries someone else's words, so a mention inside it is not a command.
    if (message.forwarded) return skip('forwarded by the owner outside the home chat');
    if (mentionsAgent(message.text, rules.agentName)) return { process: true, kind: 'command' };
    return skip('own message without a mention');
  }

  if (kind === 'group') {
    return rules.groupAllowlist.includes(message.chat)
      ? { process: true, kind: 'message' }
      : skip('group not in group_allowlist');
  }
  return rules.directMessages ? { process: true, kind: 'message' } : skip('direct_messages is off');
}

function skip(reason: string): Route {
  return { process: false, reason };
}
