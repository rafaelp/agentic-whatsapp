import type { ChatKind, ChatMessage } from './types.js';
import { asString, isRecord } from './util.js';

export function chatKind(jid: string): ChatKind {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'direct';
  return 'other';
}

/**
 * Normalizes a `wacli sync --webhook` payload. Returns null for receipts, presence
 * updates and anything that does not look like a message.
 */
export function fromWebhookPayload(payload: unknown): ChatMessage | null {
  if (!isRecord(payload)) return null;
  const eventType = asString(payload.EventType);
  if (eventType !== '' && eventType !== 'message') return null;

  const chat = asString(payload.Chat);
  const id = asString(payload.ID);
  if (chat === '' || id === '') return null;

  const media = isRecord(payload.Media) ? payload.Media : {};
  return {
    id,
    chat,
    chatName: asString(payload.ChatName),
    sender: asString(payload.SenderJID),
    senderName: asString(payload.PushName),
    timestamp: parseTimestamp(payload.Timestamp),
    fromMe: payload.FromMe === true,
    text: asString(payload.Text) || asString(media.Caption),
    mediaType: asString(media.Type),
    mediaMime: asString(media.MimeType) || undefined,
    mediaSize: typeof media.FileLength === 'number' && media.FileLength > 0 ? media.FileLength : undefined,
    forwarded: payload.IsForwarded === true,
    reaction: asString(payload.ReactionToID) !== '',
    edited: payload.Edited === true,
    revoked: payload.Revoked === true,
  };
}

/** A row of `wacli messages list --json`. */
export interface StoredMessage {
  MsgID: string;
  ChatJID: string;
  ChatName?: string;
  SenderJID?: string;
  SenderName?: string;
  Timestamp: string;
  FromMe: boolean;
  Text?: string;
  DisplayText?: string;
  MediaType?: string;
  MediaCaption?: string;
  MimeType?: string;
  IsForwarded?: boolean;
  ReactionToID?: string;
  Edited?: boolean;
  Revoked?: boolean;
}

export function fromStoredMessage(message: StoredMessage): ChatMessage {
  return {
    id: message.MsgID,
    chat: message.ChatJID,
    chatName: message.ChatName ?? '',
    sender: message.SenderJID ?? '',
    senderName: message.SenderName ?? '',
    timestamp: parseTimestamp(message.Timestamp),
    fromMe: message.FromMe === true,
    text: message.Text || message.MediaCaption || message.DisplayText || '',
    mediaType: message.MediaType ?? '',
    mediaMime: message.MimeType || undefined,
    forwarded: message.IsForwarded === true,
    reaction: (message.ReactionToID ?? '') !== '',
    edited: message.Edited === true,
    revoked: message.Revoked === true,
  };
}

function parseTimestamp(value: unknown): Date {
  const date = new Date(asString(value));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
