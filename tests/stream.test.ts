import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { AgentState, type Highlight, type StoredText } from '../src/state.js';
import { CLEAR_SCREEN, HighlightRenderer, stream } from '../src/stream.js';
import { BOB, FAMILY, HOME, makeConfig, message, NOW, tempDir } from './helpers.js';

const config = makeConfig();
const highlight = (overrides: Partial<Highlight> = {}): Highlight => ({
  id: 1,
  at: NOW,
  chat: FAMILY,
  chatName: 'Família',
  ids: ['M1'],
  text: 'Carol chamou para jantar',
  kind: 'messages',
  ...overrides,
});
const stored = (overrides: Partial<StoredText> = {}): StoredText => ({
  id: 'M1',
  sender: '5521999990002@s.whatsapp.net',
  senderName: 'Carol',
  fromMe: false,
  media: '',
  text: 'vamos jantar sexta?',
  mediaText: '',
  ...overrides,
});
const archive = async (chat: string, id: string) => (chat === BOB && id === 'OLD' ? 'texto do arquivo' : null);
const renderer = (text = true) => new HighlightRenderer(config, { text, color: false }, archive, () => NOW);

describe('HighlightRenderer', () => {
  it('shows the chat, who wrote what, and why it matters', async () => {
    expect(await renderer().render(highlight(), [stored()])).toEqual([
      '12:00:00  ★ Família',
      '          Carol: vamos jantar sexta?',
      '          ↳ Carol chamou para jantar',
    ]);
  });

  it('shows transcripts and descriptions with the media type, and the owner as you', async () => {
    const lines = await renderer().render(highlight({ chat: HOME, chatName: '' }), [
      stored({ fromMe: true, media: 'audio', text: '', mediaText: 'lembra do boleto' }),
      stored({ media: 'image', text: 'olha', mediaText: 'Um boleto de R$ 120,00.' }),
    ]);
    expect(lines.slice(0, 3)).toEqual([
      '12:00:00  ★ Ane chat',
      '          you: [audio] lembra do boleto',
      '          Carol: [image] olha Um boleto de R$ 120,00.',
    ]);
  });

  it('reads text the database did not keep from the wacli archive, and hides text with --no-text', async () => {
    const old = highlight({ chat: BOB, chatName: '', text: '', at: new Date('2026-11-08T13:30:00Z') });
    expect(await renderer().render(old, [stored({ id: 'OLD', sender: BOB, senderName: '', text: '' })])).toEqual([
      '2026-11-08 10:30  ★ 5521999990001',
      '          5521999990001: texto do arquivo',
    ]);
    expect((await renderer().render(highlight({ chat: BOB, chatName: '' }), [stored({ senderName: 'Bob' })]))[0]).toBe('12:00:00  ★ Bob');
    expect(await renderer(false).render(highlight(), [stored()])).toEqual([
      '12:00:00  ★ Família',
      '          Carol',
      '          ↳ Carol chamou para jantar',
    ]);
  });
});

describe('HighlightRenderer, daily costs', () => {
  it('shows the cost of a day on one line', async () => {
    const daily = highlight({
      chat: '',
      chatName: '',
      ids: [],
      text: '',
      kind: 'daily_cost',
      at: new Date('2026-11-10T04:00:00Z'),
      dailyCost: { day: '2026-11-09', calls: 37, inputTokens: 1_250_000, outputTokens: 31_000, cost: 0.4213, currency: 'USD' },
    });
    expect(await renderer().render(daily, [])).toEqual(['01:00:00  Σ Costs of 2026-11-09: $0.4213 in 37 model calls · 1.25M tokens in, 31k out']);
    const one = { ...daily, dailyCost: { day: '2026-11-09', calls: 1, inputTokens: 900, outputTokens: 50, cost: 2.5, currency: 'BRL' } };
    expect(await renderer(false).render(one, [])).toEqual(['01:00:00  Σ Costs of 2026-11-09: 2.50 BRL in 1 model call · 900 tokens in, 50 out']);
  });
});

describe('stream', () => {
  it('prints recent highlights, then new ones as they are recorded', async () => {
    const dir = await tempDir();
    const local = makeConfig({}, dir);
    const writer = new AgentState(Store.open(local.paths.database));
    writer.recordMessage(message({ chat: FAMILY, id: 'M1', senderName: 'Carol', text: 'vamos jantar sexta?' }), { process: true, kind: 'message' }, NOW);
    writer.recordHighlight({ chat: FAMILY, chatName: 'Família', ids: ['M1'], text: 'convite' }, NOW);
    writer.recordHighlight({ chat: FAMILY, chatName: 'Família', ids: ['M1'], text: 'convite de novo' }, NOW);

    const lines: string[] = [];
    const controller = new AbortController();
    const running = stream(
      local,
      { lines: 1, text: true, color: false, clear: false },
      { write: (line) => lines.push(line), signal: controller.signal, pollMs: 10, lookup: archive, now: () => NOW },
    );
    await waitFor(() => lines.some((line) => line.includes('convite de novo')));
    expect(lines.some((line) => line.endsWith('↳ convite'))).toBe(false);

    writer.recordHighlight({ chat: FAMILY, chatName: 'Família', ids: ['M1'], text: 'terceiro' }, NOW);
    await waitFor(() => lines.some((line) => line.includes('↳ terceiro')));
    writer.recordDailyCost({ day: '2026-11-09', calls: 2, inputTokens: 3_000, outputTokens: 200, cost: 0.003, currency: 'USD' }, NOW);
    await waitFor(() => lines.some((line) => line.includes('Σ Costs of 2026-11-09')));
    controller.abort();
    await running;
    expect(lines).toContain('          Carol: vamos jantar sexta?');
    writer.store.close();
  });

  it('clears the screen before its first line, unless asked not to', async () => {
    const dir = await tempDir();
    const local = makeConfig({}, dir);
    Store.open(local.paths.database).close();
    const firstLine = async (clear: boolean) => {
      const lines: string[] = [];
      const controller = new AbortController();
      const running = stream(local, { lines: 0, text: true, color: false, clear }, { write: (line) => lines.push(line), signal: controller.signal, pollMs: 10 });
      await waitFor(() => lines.length > 0);
      controller.abort();
      await running;
      return lines[0];
    };
    expect(await firstLine(true)).toBe(`${CLEAR_SCREEN}Highlights from Ane · Ctrl+C to stop`);
    expect(await firstLine(false)).toBe('Highlights from Ane · Ctrl+C to stop');
  });

  it('waits for the database, and explains how to get highlights when there are none', async () => {
    const dir = await tempDir();
    const local = makeConfig({}, join(dir, 'state'));
    const lines: string[] = [];
    const controller = new AbortController();
    const running = stream(local, { lines: 10, text: true, color: false, clear: false }, { write: (line) => lines.push(line), signal: controller.signal, pollMs: 10 });
    await waitFor(() => lines.some((line) => line.startsWith('Waiting for')));
    Store.open(local.paths.database).close();
    await waitFor(() => lines.some((line) => line.startsWith('Nothing highlighted yet')));
    controller.abort();
    await running;
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
