import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { InstructionsStore } from '../src/instructions.js';
import { AgentState } from '../src/state.js';
import { BOB, HOME, message, NOW, tempDir } from './helpers.js';

const queued = { process: true, kind: 'message' } as const;

describe('Store', () => {
  it('creates the schema once and keeps the file private', async () => {
    const dir = await tempDir();
    const file = join(dir, 'state', 'agentic-whatsapp.db');
    const store = Store.open(file);
    expect(store.version).toBe(6);
    store.setMeta('k', 'v');
    store.close();

    const again = Store.open(file);
    expect(again.version).toBe(6);
    expect(again.meta('k')).toBe('v');
    again.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a database from a newer version', async () => {
    const dir = await tempDir();
    const file = join(dir, 'newer.db');
    const store = Store.open(file);
    store.db.exec('PRAGMA user_version = 99');
    store.close();
    expect(() => Store.open(file)).toThrow(/newer agentic-whatsapp/);
  });

  it('rolls a failed transaction back', () => {
    const store = Store.open(null);
    expect(() =>
      store.transaction(() => {
        store.setMeta('k', 'v');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.meta('k')).toBeUndefined();
  });
});

describe('AgentState', () => {
  it('stores each message once, with what routing made of it', () => {
    const state = new AgentState(Store.open(null));
    const first = message({ text: 'oi' });
    expect(state.recordMessage(first, queued, NOW)).toBe(true);
    expect(state.recordMessage(first, queued, NOW)).toBe(false);
    expect(state.recordMessage(message({ text: 'x' }), { process: false, reason: 'edited message' }, NOW)).toBe(true);
    expect(state.store.all('SELECT text, route, kind, reason FROM messages ORDER BY text')).toEqual([
      { text: 'oi', route: 'queued', kind: 'message', reason: null },
      { text: 'x', route: 'skipped', kind: null, reason: 'edited message' },
    ]);
  });

  it('keeps no text when save_text is off', () => {
    const state = new AgentState(Store.open(null), { saveText: false });
    state.recordMessage(message({ text: 'segredo' }), queued, NOW);
    state.recordSent({ chat: HOME, purpose: 'notify', status: 'sent', messageId: 'SENT1', text: 'segredo' }, NOW);
    const id = state.startBatch({ chat: BOB, chatName: '', messages: [] }, false, NOW);
    state.finishBatch(id, { status: 'decided', decision: { actions: [{ type: 'notify', text: 'segredo' }], warnings: [] } });
    for (const table of ['messages', 'sent', 'batches']) {
      expect(JSON.stringify(state.store.all(`SELECT * FROM ${table}`))).not.toContain('segredo');
    }
    expect(state.isAgentSent('SENT1')).toBe(true);
  });

  it('links a batch to its messages and stores its decision', () => {
    const state = new AgentState(Store.open(null));
    const first = message();
    state.recordMessage(first, queued, NOW);
    const id = state.startBatch({ chat: BOB, chatName: 'Bob', messages: [{ ...first, kind: 'message' }] }, false, NOW);
    state.finishBatch(id, { status: 'decided', decision: { actions: [{ type: 'notify', text: 'Bob ligou' }], warnings: [] } }, NOW);
    expect(state.store.get('SELECT batch_id FROM messages')).toEqual({ batch_id: id });
    expect(state.store.get('SELECT status, actions FROM batches')).toEqual({
      status: 'decided',
      actions: '[{"type":"notify","text":"Bob ligou"}]',
    });
  });

  it('gives each notice once', () => {
    const state = new AgentState(Store.open(null));
    expect(state.markNotice('calls:2026-11-10')).toBe(true);
    expect(state.markNotice('calls:2026-11-10')).toBe(false);
    expect(state.markNotice('calls:2026-11-11')).toBe(true);
  });

  it('recognizes recent outgoing texts for ten minutes', () => {
    const state = new AgentState(Store.open(null));
    state.noteOutgoing(HOME, 'resumo ', 0);
    expect(state.isRecentOutgoing(HOME, 'resumo', 60_000)).toBe(true);
    expect(state.isRecentOutgoing('other@g.us', 'resumo', 60_000)).toBe(false);
    expect(state.isRecentOutgoing(HOME, 'resumo', 11 * 60_000)).toBe(false);
  });

  it('remembers messages and sends across restarts', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agentic-whatsapp.db');
    const first = message();
    const state = new AgentState(Store.open(file));
    state.recordMessage(first, queued, NOW);
    state.recordSent({ chat: HOME, purpose: 'notify', status: 'sent', messageId: 'SENT1', text: 'oi' }, NOW);
    state.store.close();

    const reopened = new AgentState(Store.open(file));
    expect(reopened.recordMessage(first, queued, NOW)).toBe(false);
    expect(reopened.isAgentSent('SENT1')).toBe(true);
  });

  it('deletes old texts but keeps everything else', () => {
    const state = new AgentState(Store.open(null));
    const old = new Date('2026-01-01T00:00:00Z');
    state.recordMessage(message({ text: 'antiga' }), queued, old);
    state.recordMessage(message({ text: 'nova' }), queued, NOW);
    state.recordSent({ chat: HOME, purpose: 'notify', status: 'sent', messageId: 'S1', text: 'enviada' }, old);
    const id = state.startBatch({ chat: BOB, chatName: '', messages: [] }, false, old);
    state.finishBatch(id, { status: 'decided', decision: { actions: [{ type: 'reply', text: 'resposta' }], warnings: [] } }, old);
    state.store.run(
      `INSERT INTO calls (started_at, day, week, month, engine, model, status, prompt, response)
       VALUES (?, '', '', '', 'antigravity', 'm', 'ok', 'p', 'r')`,
      old.toISOString(),
    );

    expect(state.pruneText(new Date('2026-06-01T00:00:00Z'))).toBe(4);
    expect(state.store.all('SELECT text FROM messages ORDER BY received_at')).toEqual([{ text: null }, { text: 'nova' }]);
    expect(state.store.get('SELECT text, message_id FROM sent')).toEqual({ text: null, message_id: 'S1' });
    expect(state.store.get('SELECT actions FROM batches')).toEqual({ actions: '[{"type":"reply"}]' });
    expect(state.store.get('SELECT prompt, response FROM calls')).toEqual({ prompt: null, response: null });
    expect(state.pruneText(new Date('2026-06-01T00:00:00Z'))).toBe(0);
  });

  it('stores what was read from media, and gives it back for the chat history', () => {
    const state = new AgentState(Store.open(null));
    state.recordMessage(message({ id: 'V1', mediaType: 'audio', text: '' }), queued, NOW);
    state.recordMessage(message({ id: 'I1', mediaType: 'image', text: '' }), queued, NOW);
    state.recordMedia(BOB, 'V1', { kind: 'audio', text: 'oi Ane', file: '/media/V1.ogg' });
    state.recordMedia(BOB, 'I1', { kind: 'image', skipped: 'too large' });

    expect(state.mediaTexts(BOB, ['V1', 'I1', 'X'])).toEqual(new Map([['V1', 'oi Ane']]));
    expect(state.store.get("SELECT media_file, media_error FROM messages WHERE id = 'I1'")).toEqual({
      media_file: null,
      media_error: 'too large',
    });
  });

  it('keeps no description or transcript when save_text is off', () => {
    const state = new AgentState(Store.open(null), { saveText: false });
    state.recordMessage(message({ id: 'V1', mediaType: 'audio' }), queued, NOW);
    state.recordMedia(BOB, 'V1', { kind: 'audio', text: 'oi Ane' });
    expect(state.mediaTexts(BOB, ['V1']).size).toBe(0);
  });

  it('deletes old transcripts and hands over old media files', () => {
    const state = new AgentState(Store.open(null));
    const old = new Date('2026-01-01T00:00:00Z');
    state.recordMessage(message({ id: 'V1', mediaType: 'audio', text: '' }), queued, old);
    state.recordMessage(message({ id: 'V2', mediaType: 'audio', text: '' }), queued, NOW);
    state.recordMedia(BOB, 'V1', { kind: 'audio', text: 'antigo', file: '/media/V1.ogg' });
    state.recordMedia(BOB, 'V2', { kind: 'audio', text: 'novo', file: '/media/V2.ogg' });

    const cutoff = new Date('2026-06-01T00:00:00Z');
    state.pruneText(cutoff);
    expect(state.mediaTexts(BOB, ['V1', 'V2'])).toEqual(new Map([['V2', 'novo']]));
    expect(state.takeMediaFiles(cutoff)).toEqual(['/media/V1.ogg']);
    expect(state.takeMediaFiles(cutoff)).toEqual([]);
  });

  it('keeps highlights in order, with the messages they point at', () => {
    const state = new AgentState(Store.open(null));
    state.recordMessage(message({ id: 'M1', senderName: 'Bob', text: 'oi' }), queued, NOW);
    state.recordMessage(message({ id: 'M2', senderName: 'Bob', text: '', mediaType: 'audio' }), queued, NOW);
    state.recordMedia(BOB, 'M2', { kind: 'audio', text: 'manda o boleto' });
    expect(state.lastHighlightId()).toBe(0);

    const first = state.recordHighlight({ chat: BOB, chatName: 'Bob', ids: ['M1'], text: 'saudação' }, NOW);
    const second = state.recordHighlight({ batchId: 2, chat: BOB, chatName: 'Bob', ids: ['M2', 'GONE'], text: 'boleto' }, NOW);
    expect(state.lastHighlightId()).toBe(second);
    expect(state.recentHighlights(1).map((highlight) => highlight.id)).toEqual([second]);
    expect(state.recentHighlights(5).map((highlight) => highlight.id)).toEqual([first, second]);
    expect(state.highlightsAfter(first)).toEqual([
      { id: second, at: NOW, batchId: 2, chat: BOB, chatName: 'Bob', ids: ['M2', 'GONE'], text: 'boleto', kind: 'messages' },
    ]);
    expect(state.messagesById(BOB, ['M2', 'GONE', 'M1'])).toEqual([
      { id: 'M2', sender: BOB, senderName: 'Bob', fromMe: false, media: 'audio', text: '', mediaText: 'manda o boleto' },
      { id: 'M1', sender: BOB, senderName: 'Bob', fromMe: false, media: '', text: 'oi', mediaText: '' },
    ]);
  });

  it('puts the cost of a day in the stream, between highlights', () => {
    const state = new AgentState(Store.open(null), { saveText: false });
    state.recordHighlight({ chat: BOB, chatName: 'Bob', ids: ['M1'], text: 'boleto' }, NOW);
    const daily = { day: '2026-11-09', calls: 37, inputTokens: 1_250_000, outputTokens: 31_000, cost: 0.4213, currency: 'USD' };
    const id = state.recordDailyCost(daily, NOW);
    expect(state.lastHighlightId()).toBe(id);
    expect(state.recentHighlights(5).map((entry) => entry.kind)).toEqual(['messages', 'daily_cost']);
    expect(state.highlightsAfter(id - 1)).toEqual([{ id, at: NOW, chat: '', chatName: '', ids: [], text: '', kind: 'daily_cost', dailyCost: daily }]);
  });

  it('keeps the commands run_cli ran, with their arguments only while texts are kept', () => {
    const store = Store.open(null);
    const state = new AgentState(store);
    const old = new Date('2026-01-01T00:00:00Z');
    state.recordCommand({ program: 'joplin', rule: 'joplin mknote', command: ['joplin', 'mknote', 'Compras'], status: 'ok', exitCode: 0, durationMs: 812.4 }, old);
    state.recordCommand({ program: 'joplin', rule: '', command: ['joplin', 'rmnote', 'a1'], status: 'refused', durationMs: 0, error: 'denied' }, NOW);
    expect(store.all('SELECT program, rule, args, status, exit_code, duration_ms, error FROM commands ORDER BY id')).toEqual([
      { program: 'joplin', rule: 'joplin mknote', args: '["joplin","mknote","Compras"]', status: 'ok', exit_code: 0, duration_ms: 812, error: null },
      { program: 'joplin', rule: '', args: '["joplin","rmnote","a1"]', status: 'refused', exit_code: null, duration_ms: 0, error: 'denied' },
    ]);
    state.pruneText(new Date('2026-06-01T00:00:00Z'));
    expect(store.all('SELECT args FROM commands ORDER BY id').map((row) => row.args)).toEqual([null, '["joplin","rmnote","a1"]']);

    const quiet = Store.open(null);
    new AgentState(quiet, { saveText: false }).recordCommand({ program: 'joplin', rule: 'joplin ls', command: ['joplin', 'ls'], status: 'ok', durationMs: 1 });
    expect(quiet.get('SELECT args FROM commands')?.args).toBeNull();
  });

  it('keeps the reason of a highlight only while texts are kept', () => {
    const state = new AgentState(Store.open(null), { saveText: false });
    state.recordHighlight({ chat: BOB, chatName: 'Bob', ids: ['M1'], text: 'boleto' }, NOW);
    expect(state.recentHighlights(1)[0]?.text).toBe('');

    const kept = new AgentState(Store.open(null));
    kept.recordHighlight({ chat: BOB, chatName: 'Bob', ids: ['M1'], text: 'boleto' }, new Date('2026-01-01T00:00:00Z'));
    expect(kept.pruneText(new Date('2026-06-01T00:00:00Z'))).toBe(1);
    expect(kept.recentHighlights(1)[0]).toMatchObject({ ids: ['M1'], text: '' });
  });

  it('imports the state.json of earlier versions once', async () => {
    const dir = await tempDir();
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ version: 1, seen: [`${BOB}/M1`, 'bad'], agentSent: ['SENT9'], usage: {} }));
    const state = new AgentState(Store.open(null));
    expect(await state.importLegacy(file, NOW)).toBe(2);
    expect(state.recordMessage(message({ id: 'M1' }), queued, NOW)).toBe(false);
    expect(state.isAgentSent('SENT9')).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.imported`)).toBe(true);
    expect(await state.importLegacy(file, NOW)).toBe(0);
  });

  it('refuses a corrupt state.json', async () => {
    const dir = await tempDir();
    const file = join(dir, 'state.json');
    await writeFile(file, '{nope');
    await expect(new AgentState(Store.open(null)).importLegacy(file)).rejects.toThrow(/state file/);
  });
});

describe('InstructionsStore', () => {
  it('keeps the previous version every time it changes', async () => {
    const dir = await tempDir();
    const store = new InstructionsStore(join(dir, 'instructions.md'), join(dir, 'history'));
    expect(await store.read()).toBe('');
    await store.write('- primeira');
    await store.write('- segunda');
    expect(await store.read()).toBe('- segunda');
    const versions = await readdir(join(dir, 'history'));
    expect(versions).toHaveLength(1);
    expect(await readFile(join(dir, 'history', versions[0] ?? ''), 'utf8')).toBe('- primeira\n');
  });
});
