import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstructionsStore } from '../src/instructions.js';
import { AgentState } from '../src/state.js';
import { HOME, tempDir } from './helpers.js';

describe('AgentState', () => {
  it('reports each message only once', async () => {
    const state = await AgentState.load(null);
    expect(state.markSeen('chat/1')).toBe(true);
    expect(state.markSeen('chat/1')).toBe(false);
  });

  it('enforces the daily call limit and resets it the next day', async () => {
    const state = await AgentState.load(null);
    expect(state.tryConsumeCall('2026-11-10', 2)).toBe(true);
    expect(state.tryConsumeCall('2026-11-10', 2)).toBe(true);
    expect(state.tryConsumeCall('2026-11-10', 2)).toBe(false);
    expect(state.markCapNotified('2026-11-10')).toBe(true);
    expect(state.markCapNotified('2026-11-10')).toBe(false);
    expect(state.tryConsumeCall('2026-11-11', 2)).toBe(true);
    expect(state.callsToday('2026-11-11')).toBe(1);
  });

  it('recognizes recent outgoing texts for ten minutes', async () => {
    const state = await AgentState.load(null);
    state.noteOutgoing(HOME, 'resumo ', 0);
    expect(state.isRecentOutgoing(HOME, 'resumo', 60_000)).toBe(true);
    expect(state.isRecentOutgoing('other@g.us', 'resumo', 60_000)).toBe(false);
    expect(state.isRecentOutgoing(HOME, 'resumo', 11 * 60_000)).toBe(false);
  });

  it('persists seen messages, sent IDs and usage', async () => {
    const dir = await tempDir();
    const file = join(dir, 'state', 'state.json');
    const state = await AgentState.load(file);
    state.markSeen('chat/1');
    state.markAgentSent('SENT1');
    state.tryConsumeCall('2026-11-10', 10);
    await state.save();

    const reloaded = await AgentState.load(file);
    expect(reloaded.markSeen('chat/1')).toBe(false);
    expect(reloaded.isAgentSent('SENT1')).toBe(true);
    expect(reloaded.callsToday('2026-11-10')).toBe(1);
  });

  it('starts empty from a missing file and refuses a corrupt one', async () => {
    const dir = await tempDir();
    const missing = await AgentState.load(join(dir, 'none.json'));
    expect(missing.callsToday('2026-11-10')).toBe(0);

    const corrupt = join(dir, 'corrupt.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(corrupt, '{nope'));
    await expect(AgentState.load(corrupt)).rejects.toThrow(/state file/);
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
    const { readdir } = await import('node:fs/promises');
    const versions = await readdir(join(dir, 'history'));
    expect(versions).toHaveLength(1);
    expect(await readFile(join(dir, 'history', versions[0] ?? ''), 'utf8')).toBe('- primeira\n');
  });
});
