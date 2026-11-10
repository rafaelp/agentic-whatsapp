import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Health, NOTIFY_AFTER, RENOTIFY_EVERY } from '../src/health.js';
import { tempDir } from './helpers.js';

const setup = (file: string | null = null) => {
  const notifications: { title: string; message: string }[] = [];
  const health = new Health(file, (title, message) => notifications.push({ title, message }), 'Ane');
  return { health, notifications };
};

describe('Health', () => {
  it('notifies after a few failures in a row, then at intervals', () => {
    const { health, notifications } = setup();
    for (let index = 1; index < NOTIFY_AFTER; index++) health.failed('wacli', 'boom');
    expect(notifications).toHaveLength(0);

    health.failed('wacli', 'not authenticated');
    expect(notifications).toEqual([
      { title: 'Ane: WhatsApp sync is failing', message: `${NOTIFY_AFTER} times in a row. not authenticated` },
    ]);

    for (let index = 0; index < RENOTIFY_EVERY - 1; index++) health.failed('wacli', 'boom');
    expect(notifications).toHaveLength(1);
    health.failed('wacli', 'boom');
    expect(notifications).toHaveLength(2);
  });

  it('notifies on recovery only after it had notified a failure', () => {
    const { health, notifications } = setup();
    health.failed('engine', 'quota');
    health.succeeded('engine');
    expect(notifications).toHaveLength(0);

    for (let index = 0; index < NOTIFY_AFTER; index++) health.failed('engine', 'quota');
    health.succeeded('engine');
    expect(notifications.map((n) => n.title)).toEqual(['Ane: model calls are failing', 'Ane: model calls are back']);
    expect(health.snapshot().engine).toMatchObject({ failures: 0, lastError: 'quota' });
  });

  it('keeps components apart', () => {
    const { health } = setup();
    health.failed('wacli', 'down');
    expect(health.snapshot().engine.failures).toBe(0);
  });

  it('saves a snapshot that status can read', async () => {
    const dir = await tempDir();
    const file = join(dir, 'health.json');
    const { health } = setup(file);
    health.messageQueued();
    health.decided();
    health.failed('wacli', 'down');
    health.stopped();
    await health.save();

    const read = await Health.read(file);
    expect(read).toMatchObject({ pid: process.pid, wacli: { failures: 1, lastError: 'down' }, engine: { failures: 0 } });
    expect(read?.lastMessageAt).toBeDefined();
    expect(read?.stoppedAt).toBeDefined();
    expect(await Health.read(join(dir, 'missing.json'))).toBeNull();
  });
});
