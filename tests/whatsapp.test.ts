import { describe, expect, it } from 'vitest';
import { chatKind, fromStoredMessage, fromWebhookPayload } from '../src/whatsapp.js';
import { BOB, FAMILY } from './helpers.js';

describe('chatKind', () => {
  it('tells groups, direct chats and everything else apart', () => {
    expect(chatKind(FAMILY)).toBe('group');
    expect(chatKind(BOB)).toBe('direct');
    expect(chatKind('86088878149676@lid')).toBe('direct');
    expect(chatKind('status@broadcast')).toBe('other');
    expect(chatKind('120363000000000009@newsletter')).toBe('other');
  });
});

describe('fromWebhookPayload', () => {
  it('maps the wacli message payload', () => {
    const message = fromWebhookPayload({
      Chat: FAMILY,
      ID: '3EB0',
      SenderJID: BOB,
      Timestamp: '2026-07-25T10:00:00Z',
      FromMe: false,
      Text: 'oi',
      ChatName: 'Família',
      PushName: 'Bob',
      IsForwarded: true,
    });
    expect(message).toEqual({
      id: '3EB0',
      chat: FAMILY,
      chatName: 'Família',
      sender: BOB,
      senderName: 'Bob',
      timestamp: new Date('2026-07-25T10:00:00Z'),
      fromMe: false,
      text: 'oi',
      mediaType: '',
      forwarded: true,
      reaction: false,
      edited: false,
      revoked: false,
    });
  });

  it('uses the media caption when there is no text', () => {
    const message = fromWebhookPayload({
      Chat: BOB,
      ID: '1',
      Timestamp: '2026-07-25T10:00:00Z',
      Media: { Type: 'image', Caption: 'olha a foto' },
    });
    expect(message).toMatchObject({ text: 'olha a foto', mediaType: 'image' });
  });

  it('keeps the MIME type and size of media', () => {
    const message = fromWebhookPayload({
      Chat: BOB,
      ID: '1',
      Timestamp: '2026-07-25T10:00:00Z',
      Media: { Type: 'audio', MimeType: 'audio/ogg; codecs=opus', FileLength: 9_120 },
    });
    expect(message).toMatchObject({ text: '', mediaType: 'audio', mediaMime: 'audio/ogg; codecs=opus', mediaSize: 9_120 });
  });

  it('flags reactions', () => {
    expect(fromWebhookPayload({ Chat: BOB, ID: '1', ReactionToID: 'X', ReactionEmoji: '👍' })?.reaction).toBe(true);
  });

  it('ignores receipts, presence events and malformed payloads', () => {
    expect(fromWebhookPayload({ EventType: 'receipt', Chat: BOB, ID: '1' })).toBeNull();
    expect(fromWebhookPayload({ EventType: 'chat_presence', Chat: BOB })).toBeNull();
    expect(fromWebhookPayload({ Chat: BOB })).toBeNull();
    expect(fromWebhookPayload('text')).toBeNull();
  });
});

describe('fromStoredMessage', () => {
  it('maps a row of wacli messages list', () => {
    const message = fromStoredMessage({
      MsgID: 'A1',
      ChatJID: BOB,
      ChatName: 'Bob',
      SenderJID: BOB,
      SenderName: 'Bob',
      Timestamp: '2026-11-10T14:00:00Z',
      FromMe: false,
      Text: '',
      MediaType: 'document',
      MediaCaption: 'contrato.pdf',
    });
    expect(message).toMatchObject({ id: 'A1', chat: BOB, text: 'contrato.pdf', mediaType: 'document' });
  });
});
