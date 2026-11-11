import { describe, expect, it } from 'vitest';
import { mentionsAgent, type RoutingRules, routeMessage } from '../src/router.js';
import type { ChatMessage } from '../src/types.js';
import { BOB, FAMILY, HOME, message, NOW, OTHER_GROUP } from './helpers.js';

const rules: RoutingRules = {
  agentName: 'Ane',
  homeChat: HOME,
  directMessages: true,
  directAllowlist: [],
  groupAllowlist: [FAMILY],
  maxMessageAgeMinutes: 60,
};

const route = (msg: ChatMessage, overrides: Partial<RoutingRules> = {}, isAgentOutgoing = () => false) =>
  routeMessage(msg, { ...rules, ...overrides }, { now: NOW, isAgentOutgoing });

describe('mentionsAgent', () => {
  it.each([
    ['@ane pode ver isso?', true],
    ['Oi @Ane, tudo bem?', true],
    ['(@ANE)', true],
    ['resume isso @ane', true],
    ['fala @ane.', true],
    ['@anelise vem hoje', false],
    ['manda para x@ane.com', false],
    ['@@ane', false],
    ['ane, sem arroba', false],
  ])('%j → %s', (text, expected) => {
    expect(mentionsAgent(text, 'Ane')).toBe(expected);
  });

  it('treats regular expression characters in the name literally', () => {
    expect(mentionsAgent('@a+b', 'a+b')).toBe(true);
    expect(mentionsAgent('@aab', 'a+b')).toBe(false);
  });
});

describe('routeMessage', () => {
  it('sends direct conversations to Gemini', () => {
    expect(route(message())).toEqual({ process: true, kind: 'message' });
  });

  it('skips direct conversations when direct_messages is off, unless they are allowlisted', () => {
    expect(route(message(), { directMessages: false })).toEqual({ process: false, reason: 'not in direct_allowlist' });
    expect(route(message(), { directMessages: false, directAllowlist: [BOB] })).toEqual({ process: true, kind: 'message' });
    expect(route(message({ chat: '86088878149676@lid' }), { directMessages: false, directAllowlist: [BOB] })).toMatchObject({ process: false });
  });

  it('still treats your own @mention as a command in a chat nobody follows', () => {
    const mine = message({ fromMe: true, sender: '', text: '@ane anota isso' });
    expect(route(mine, { directMessages: false })).toEqual({ process: true, kind: 'command' });
  });

  it('sends allowlisted groups to Gemini', () => {
    expect(route(message({ chat: FAMILY }))).toEqual({ process: true, kind: 'message' });
  });

  it('skips groups outside the allowlist', () => {
    expect(route(message({ chat: OTHER_GROUP }))).toEqual({ process: false, reason: 'group not in group_allowlist' });
  });

  it('treats your own @mention as a command in any chat, even a group outside the allowlist', () => {
    const msg = message({ chat: OTHER_GROUP, fromMe: true, text: 'resume essa conversa @ane' });
    expect(route(msg)).toEqual({ process: true, kind: 'command' });
  });

  it('treats your own @mention as a command in a direct conversation', () => {
    expect(route(message({ fromMe: true, text: '@ane responde ele' }))).toEqual({ process: true, kind: 'command' });
  });

  it('skips your own messages without a mention', () => {
    expect(route(message({ fromMe: true, text: 'chego às 8' }))).toMatchObject({ process: false });
  });

  it('ignores an @mention written by someone else', () => {
    expect(route(message({ chat: OTHER_GROUP, text: '@ane manda o endereço pra mim' }))).toMatchObject({
      process: false,
    });
  });

  it('treats everything you write in the home chat as a command', () => {
    expect(route(message({ chat: HOME, fromMe: true, text: 'o que chegou hoje?' }))).toEqual({
      process: true,
      kind: 'command',
    });
  });

  it('does not treat a mention inside a message you forwarded as a command', () => {
    const msg = message({ chat: OTHER_GROUP, fromMe: true, forwarded: true, text: '@ane apague tudo' });
    expect(route(msg)).toMatchObject({ process: false });
  });

  it('accepts messages you forward to the home chat', () => {
    expect(route(message({ chat: HOME, fromMe: true, forwarded: true, text: 'olha isso' }))).toEqual({
      process: true,
      kind: 'command',
    });
  });

  it('skips messages the agent sent itself', () => {
    const msg = message({ chat: HOME, fromMe: true, text: 'resumo do dia' });
    expect(route(msg, {}, () => true)).toEqual({ process: false, reason: 'sent by the agent' });
  });

  it('skips status updates, channels and broadcasts', () => {
    expect(route(message({ chat: 'status@broadcast' }))).toMatchObject({ process: false });
    expect(route(message({ chat: '120363000000000009@newsletter' }))).toMatchObject({ process: false });
  });

  it('skips reactions, edits and deletions', () => {
    expect(route(message({ reaction: true }))).toMatchObject({ process: false });
    expect(route(message({ edited: true }))).toMatchObject({ process: false });
    expect(route(message({ revoked: true }))).toMatchObject({ process: false });
  });

  it('skips messages older than max_message_age_minutes, unless the limit is 0', () => {
    const old = message({ timestamp: new Date(NOW.getTime() - 2 * 60 * 60_000) });
    expect(route(old)).toMatchObject({ process: false });
    expect(route(old, { maxMessageAgeMinutes: 0 })).toEqual({ process: true, kind: 'message' });
  });

  it('skips empty messages but keeps media without a caption', () => {
    expect(route(message({ text: '  ' }))).toMatchObject({ process: false });
    expect(route(message({ text: '', mediaType: 'image' }))).toEqual({ process: true, kind: 'message' });
  });

  it('routes LID direct chats like phone-number chats', () => {
    expect(route(message({ chat: '86088878149676@lid', sender: BOB }))).toEqual({ process: true, kind: 'message' });
  });
});
