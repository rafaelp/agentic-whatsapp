import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Batcher } from '../src/batcher.js';
import type { Batch, MessageKind } from '../src/types.js';
import { BOB, FAMILY, message } from './helpers.js';

const routed = (chat: string, kind: MessageKind = 'message', chatName = '') => ({
  ...message({ chat, chatName }),
  kind,
});

describe('Batcher', () => {
  let flushed: Batch[];
  let batcher: Batcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    batcher = new Batcher({ debounceMs: 1_000, maxBatchSize: 3, onFlush: (batch) => flushed.push(batch) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a chat once it has been quiet for the debounce time', () => {
    batcher.add(routed(BOB));
    vi.advanceTimersByTime(600);
    batcher.add(routed(BOB));
    vi.advanceTimersByTime(600);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.messages).toHaveLength(2);
  });

  it('keeps chats in separate batches', () => {
    batcher.add(routed(BOB));
    batcher.add(routed(FAMILY, 'message', 'Família'));
    vi.advanceTimersByTime(1_000);
    expect(flushed.map((batch) => batch.chat).sort()).toEqual([FAMILY, BOB].sort());
    expect(flushed.find((batch) => batch.chat === FAMILY)?.chatName).toBe('Família');
  });

  it('flushes immediately on a command, together with what was waiting', () => {
    batcher.add(routed(BOB));
    batcher.add(routed(BOB, 'command'));
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.messages.map((m) => m.kind)).toEqual(['message', 'command']);
  });

  it('flushes when a batch reaches its maximum size', () => {
    batcher.add(routed(BOB));
    batcher.add(routed(BOB));
    batcher.add(routed(BOB));
    expect(flushed).toHaveLength(1);
    expect(batcher.size).toBe(0);
  });

  it('can flush everything or drop everything', () => {
    batcher.add(routed(BOB));
    batcher.flushAll();
    expect(flushed).toHaveLength(1);

    batcher.add(routed(FAMILY));
    expect(batcher.clear()).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(flushed).toHaveLength(1);
  });
});
