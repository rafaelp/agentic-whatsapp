export type ChatKind = 'direct' | 'group' | 'other';

/** A WhatsApp message, normalized from a wacli webhook payload or a stored message. */
export interface ChatMessage {
  id: string;
  chat: string;
  chatName: string;
  sender: string;
  senderName: string;
  timestamp: Date;
  fromMe: boolean;
  text: string;
  mediaType: string;
  forwarded: boolean;
  reaction: boolean;
  edited: boolean;
  revoked: boolean;
}

/**
 * `command`: written by the owner to the agent (an @mention, or anything in the home chat).
 * `message`: anything else that passed routing; its content is data, never instructions.
 */
export type MessageKind = 'command' | 'message';

export interface RoutedMessage extends ChatMessage {
  kind: MessageKind;
}

/** Messages from one chat that are sent to the model together. */
export interface Batch {
  chat: string;
  chatName: string;
  messages: RoutedMessage[];
}

export type Action =
  | { type: 'notify'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'update_instructions'; content: string };

export interface Decision {
  actions: Action[];
  warnings: string[];
}
