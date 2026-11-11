import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatLogLine, type LogEntry, type LogFields } from '../src/log.js';
import { followFile, LogRenderer, logs } from '../src/logs.js';
import { BOB, FAMILY, HOME, makeConfig, NOW, OTHER_GROUP, tempDir } from './helpers.js';

const config = makeConfig();
const entry = (message: string, fields: LogFields = {}, level: LogEntry['level'] = 'info'): LogEntry => ({
  time: NOW,
  level,
  message,
  fields,
});

const texts: Record<string, string> = {
  [`${BOB}/M1`]: 'me passa o endereço?',
  [`${OTHER_GROUP}/M2`]: '@ane resume isso',
  [`${HOME}/SENT1`]: '🤖 Ane: Bob pediu o endereço',
};
const lookup = async (chat: string, id: string) => texts[`${chat}/${id}`] ?? null;

const renderer = (options: Partial<{ all: boolean; text: boolean; verbose: boolean }> = {}) =>
  new LogRenderer(config, { all: false, text: true, verbose: false, color: false, ...options }, lookup, () => 200);

describe('LogRenderer', () => {
  it('shows a message arriving, with its text from the archive', async () => {
    const line = await renderer().render(entry('queued message', { chat: BOB, id: 'M1', sender: 'Bob', kind: 'message' }));
    expect(line).toBe('12:00:00  📩 Bob: me passa o endereço?');
  });

  it('shows group messages with the sender, and your commands apart', async () => {
    const r = renderer();
    expect(
      await r.render(entry('queued message', { chat: FAMILY, chatName: 'Família', id: 'X', sender: 'Ana', kind: 'message' })),
    ).toBe('12:00:00  📩 Família · Ana');
    expect(
      await r.render(entry('queued message', { chat: OTHER_GROUP, chatName: 'Amigos', id: 'M2', sender: 'me', kind: 'command' })),
    ).toBe('12:00:00  ⚡ you in Amigos: @ane resume isso');
  });

  it('shows decisions and sends with the chat names it learned', async () => {
    const r = renderer();
    await r.render(entry('queued message', { chat: BOB, id: 'M1', sender: 'Bob', kind: 'message' }));
    expect(await r.render(entry('decision', { chat: BOB, actions: ['notify'] }))).toBe('12:00:00  🧠 Bob: notify');
    expect(await r.render(entry('decision', { chat: BOB, actions: [] }))).toBe('12:00:00  🧠 Bob: nothing to do');
    expect(await r.render(entry('sent', { to: HOME, purpose: 'notify', id: 'SENT1' }))).toBe(
      '12:00:00  📤 notify → Ane chat: 🤖 Ane: Bob pediu o endereço',
    );
  });

  it('shows the tokens and cost of a decision, the tools a call used and cost limits', async () => {
    const r = renderer();
    expect(await r.render(entry('decision', { chat: BOB, actions: ['notify'], inputTokens: 9_400, outputTokens: 42, cost: 0.0072 }))).toBe(
      `12:00:00  🧠 ${BOB.split('@')[0]}: notify · 9.4k → 42 tokens · $0.0072`,
    );
    const call = entry('model call', { chat: BOB, status: 'ok', tools: ['notes/search'], cost: 0.01 });
    expect(r.wants(call)).toBe(true);
    expect(r.wants(entry('model call', { chat: BOB, status: 'ok' }))).toBe(false);
    expect(await r.render(call)).toBe(`12:00:00  🔧 ${BOB.split('@')[0]}: notes/search`);
    expect(await r.render(entry('cost limit reached, skipping', { chat: BOB, period: 'day', spent: 1.02, limit: 1 }, 'warn'))).toBe(
      `12:00:00  ⚠ day cost limit reached ($1.02 of $1.00), skipped ${BOB.split('@')[0]}`,
    );
  });

  it('shows images described and audio transcribed, with their cost, and media it could not read', async () => {
    const r = renderer();
    const bob = BOB.split('@')[0];
    expect(await r.render(entry('media read', { chat: BOB, kind: 'audio', inputTokens: 20_000, outputTokens: 40, cost: 0.015 }))).toBe(
      `12:00:00  🎤 ${bob}: audio transcribed · 20k → 40 tokens · $0.0150`,
    );
    expect(await r.render(entry('media read', { chat: BOB, kind: 'image' }))).toBe(`12:00:00  🖼 ${bob}: image described`);
    expect(await r.render(entry('media not read', { chat: BOB, kind: 'image', reason: 'too large' }))).toBe(
      `12:00:00  · ${bob}: image not read, too large`,
    );
    expect(await r.render(entry('could not read media', { chat: BOB, kind: 'audio', error: 'media expired' }, 'warn'))).toBe(
      `12:00:00  ⚠ could not read the audio (${bob}): media expired`,
    );
    expect(r.wants(entry('media read', { chat: BOB }))).toBe(true);
  });

  it('shows highlights', async () => {
    const r = renderer();
    expect(await r.render(entry('highlight', { chat: FAMILY, chatName: 'Família', messages: 2 }))).toBe(
      '12:00:00  ★ Família: highlighted 2 messages for the stream',
    );
    expect(await r.render(entry('highlight', { chat: FAMILY, messages: 1 }))).toBe('12:00:00  ★ Família: highlighted 1 message for the stream');
  });

  it('shows what changed in the settings', async () => {
    const r = renderer();
    await r.render(entry('highlight', { chat: FAMILY, chatName: 'Família', messages: 1 }));
    expect(
      await r.render(entry('settings changed', { monitoring: [FAMILY], stoppedMonitoring: [OTHER_GROUP], directMessages: false, autoReplyOn: [BOB] })),
    ).toBe(`12:00:00  ⚙ settings changed: monitoring Família; stopped monitoring 120363000000000003; direct messages off; may reply without being asked in ${BOB.split('@')[0]}`);
  });

  it('shows the commands the agent ran or was refused, without their arguments', async () => {
    const r = renderer();
    expect(await r.render(entry('command', { program: 'joplin', rule: 'joplin mknote', exitCode: 0, seconds: 1.2 }))).toBe(
      '12:00:00  ⌨ ran joplin mknote (exit 0, 1.2s)',
    );
    expect(await r.render(entry('command', { program: 'joplin', rule: 'joplin set', exitCode: null, timedOut: true }))).toBe(
      '12:00:00  ⌨ ran joplin set (timed out)',
    );
    expect(await r.render(entry('command refused', { program: 'joplin', reason: '[cli] deny has "joplin rmnote"' }, 'warn'))).toBe(
      '12:00:00  ⛔ refused to run joplin: [cli] deny has "joplin rmnote"',
    );
    expect(await r.render(entry('dry run: would run a command', { program: 'joplin', rule: 'joplin mknote' }))).toBe(
      '12:00:00  📝 would run joplin mknote',
    );
  });

  it('shows the cost of the day before', async () => {
    const r = renderer();
    expect(r.wants(entry('daily cost', { day: '2026-11-09', calls: 37, cost: 0.4213 }))).toBe(true);
    expect(await r.render(entry('daily cost', { day: '2026-11-09', calls: 37, cost: 0.4213 }))).toBe(
      '12:00:00  Σ costs of 2026-11-09: $0.4213 in 37 model calls',
    );
  });

  it('keeps message text off the screen with --no-text', async () => {
    const r = renderer({ text: false });
    expect(await r.render(entry('queued message', { chat: BOB, id: 'M1', sender: 'Bob', media: 'image' }))).toBe(
      '12:00:00  📩 Bob: [image]',
    );
    expect(await r.render(entry('dry run: would send', { to: HOME, purpose: 'notify', text: 'secret' }))).toBe(
      '12:00:00  📝 would notify → Ane chat',
    );
  });

  it('shows ignored messages only with --all, and wacli output only with --verbose', () => {
    const skipped = entry('skipped message', { chat: OTHER_GROUP, reason: 'group not in group_allowlist' }, 'debug');
    const wacli = entry('wacli: Connected.');
    expect(renderer().wants(skipped)).toBe(false);
    expect(renderer({ all: true }).wants(skipped)).toBe(true);
    expect(renderer().wants(wacli)).toBe(false);
    expect(renderer({ verbose: true }).wants(wacli)).toBe(true);
    expect(renderer().wants(entry('anything odd', {}, 'warn'))).toBe(true);
  });

  it('shows problems', async () => {
    const r = renderer();
    expect(await r.render(entry('model call failed', { chat: BOB, error: 'quota exceeded' }, 'error'))).toBe(
      `12:00:00  ✗ model call failed (${BOB.split('@')[0]}): quota exceeded`,
    );
    expect(await r.render(entry('notification: Ane: WhatsApp sync is failing', { message: '3 times in a row.' }, 'warn'))).toBe(
      '12:00:00  🔔 Ane: WhatsApp sync is failing: 3 times in a row.',
    );
    expect(await r.render(entry('wacli sync stopped, restarting', { inSeconds: 5 }, 'warn'))).toBe(
      '12:00:00  ⚠ wacli sync stopped, restarting in 5s',
    );
  });

  it('fits long lines to the terminal and colors them', async () => {
    const narrow = new LogRenderer(config, { all: false, text: true, verbose: false, color: true }, lookup, () => 30);
    const line = await narrow.render(entry('queued message', { chat: BOB, id: 'M1', sender: 'Bob' })) ?? '';
    expect(line).toContain('\u001b[36m');
    expect(line).toContain('…');
  });
});

describe('followFile', () => {
  it('reads the existing lines, then follows appends and rotation', async () => {
    const dir = await tempDir();
    const path = join(dir, 'agent.log');
    await writeFile(path, 'one\ntwo\n');
    const initial: string[] = [];
    const seen: string[] = [];
    const controller = new AbortController();

    const following = followFile(path, {
      onInitial: async (lines) => {
        initial.push(...lines);
      },
      onLine: async (line) => {
        seen.push(line);
      },
      pollMs: 20,
      signal: controller.signal,
    });

    await expect.poll(() => initial).toEqual(['one', 'two']);
    await appendFile(path, 'three\npar');
    await appendFile(path, 'tial\n');
    await expect.poll(() => seen).toEqual(['three', 'partial']);

    await rename(path, `${path}.1`);
    await writeFile(path, 'after rotation\n');
    await expect.poll(() => seen).toEqual(['three', 'partial', 'after rotation']);

    controller.abort();
    await following;
  });

  it('waits for a file that does not exist yet', async () => {
    const dir = await tempDir();
    const path = join(dir, 'agent.log');
    const seen: string[] = [];
    let missing = 0;
    const controller = new AbortController();
    const following = followFile(path, {
      onInitial: async () => {},
      onLine: async (line) => {
        seen.push(line);
      },
      onMissing: () => {
        missing += 1;
      },
      pollMs: 20,
      signal: controller.signal,
    });
    await writeFile(path, 'hello\n');
    await expect.poll(() => seen).toEqual(['hello']);
    expect(missing).toBe(1);
    controller.abort();
    await following;
  });
});

describe('logs', () => {
  it('prints recent history, then new events, from the agent log', async () => {
    const dir = await tempDir();
    const cfg = makeConfig({}, dir);
    const log = (message: string, fields: LogFields, level: LogEntry['level'] = 'info') =>
      `${formatLogLine(NOW, level, message, fields)}\n`;
    await mkdir(cfg.paths.logDir, { recursive: true });
    await writeFile(
      cfg.paths.agentLog,
      log('agent running', { name: 'Ane', engine: 'antigravity', model: 'gemini-3.8-flash-low' }) +
        log('skipped message', { chat: OTHER_GROUP, reason: 'group not in group_allowlist' }, 'debug') +
        log('queued message', { chat: BOB, id: 'M1', sender: 'Bob', kind: 'message' }),
    );

    const output: string[] = [];
    const controller = new AbortController();
    const running = logs(
      cfg,
      { all: false, text: true, verbose: false, lines: 20, color: false },
      { write: (line) => output.push(line), signal: controller.signal, pollMs: 20, lookup },
    );

    await expect.poll(() => output.length).toBe(3);
    expect(output[1]).toContain('▶ Ane is running (antigravity, gemini-3.8-flash-low)');
    expect(output[2]).toContain('📩 Bob: me passa o endereço?');

    await appendFile(cfg.paths.agentLog, log('decision', { chat: BOB, actions: ['notify'] }));
    await expect.poll(() => output.at(-1)).toContain('🧠 Bob: notify');

    controller.abort();
    await running;
  });
});
