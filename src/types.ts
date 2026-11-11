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
  /** MIME type of the media, such as "audio/ogg; codecs=opus", when wacli reports it. */
  mediaMime?: string;
  /** Size of the media in bytes, when wacli reports it. */
  mediaSize?: number;
  /** File name of a document, as the sender named it. */
  mediaFilename?: string;
  /** What the model read from the media: a description of an image or a transcript of audio. */
  mediaText?: string;
  /** Why the media was not read, such as "too large". */
  mediaNote?: string;
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
  | { type: 'update_instructions'; content: string }
  /** Shows messages of the batch in the owner's stream; `ids` empty means all of them. */
  | { type: 'highlight'; text: string; ids: string[] };

export interface Decision {
  actions: Action[];
  warnings: string[];
}
