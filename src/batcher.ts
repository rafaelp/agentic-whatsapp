import type { Batch, RoutedMessage } from './types.js';

export interface BatcherOptions {
  debounceMs: number;
  maxBatchSize: number;
  onFlush: (batch: Batch) => void;
}

interface Pending {
  batch: Batch;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Groups messages per chat and flushes a chat once it has been quiet for `debounceMs`,
 * so a burst of messages costs one model call. Commands flush right away.
 */
export class Batcher {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: BatcherOptions) {}

  add(message: RoutedMessage): void {
    let entry = this.pending.get(message.chat);
    if (entry === undefined) {
      entry = { batch: { chat: message.chat, chatName: message.chatName, messages: [] }, timer: undefined };
      this.pending.set(message.chat, entry);
    }
    entry.batch.messages.push(message);
    if (message.chatName !== '') entry.batch.chatName = message.chatName;
    if (entry.timer !== undefined) clearTimeout(entry.timer);

    if (message.kind === 'command' || entry.batch.messages.length >= this.options.maxBatchSize) {
      this.flush(message.chat);
      return;
    }
    entry.timer = setTimeout(() => this.flush(message.chat), this.options.debounceMs);
  }

  flush(chat: string): void {
    const entry = this.pending.get(chat);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.pending.delete(chat);
    this.options.onFlush(entry.batch);
  }

  flushAll(): void {
    for (const chat of [...this.pending.keys()]) this.flush(chat);
  }

  /** Drops everything still waiting, without flushing. Returns how many chats were dropped. */
  clear(): number {
    const count = this.pending.size;
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.pending.clear();
    return count;
  }

  get size(): number {
    return this.pending.size;
  }
}
