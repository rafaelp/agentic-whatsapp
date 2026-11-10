import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, formatLogLine, parseLogLine, rotate, rotateIfLarge } from '../src/log.js';
import { tempDir } from './helpers.js';

describe('createLogger', () => {
  it('writes every level to the file but only the chosen levels to the terminal', async () => {
    const dir = await tempDir();
    const path = join(dir, 'logs', 'agent.log');
    const terminal: string[] = [];
    const log = createLogger({ write: (line) => terminal.push(line), file: { path, maxBytes: 1024 * 1024, keep: 2 } });
    log.debug('skipped message', { chat: 'a' });
    log.info('queued message', { chat: 'b' });

    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toContain('INFO queued message {"chat":"b"}');
    const file = await readFile(path, 'utf8');
    expect(file).toContain('DEBUG skipped message');
    expect(file).toContain('INFO queued message');
  });

  it('can log to the file only', async () => {
    const dir = await tempDir();
    const path = join(dir, 'agent.log');
    const log = createLogger({ stderr: false, file: { path, maxBytes: 1024, keep: 2 } });
    log.warn('careful');
    expect(await readFile(path, 'utf8')).toContain('WARN careful');
  });

  it('rotates the file when it would grow past its size, keeping a limited number of copies', async () => {
    const dir = await tempDir();
    const path = join(dir, 'agent.log');
    const log = createLogger({ stderr: false, file: { path, maxBytes: 200, keep: 2 } });
    for (let index = 0; index < 20; index++) log.info(`line ${index}`, { padding: 'x'.repeat(40) });

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['agent.log', 'agent.log.1', 'agent.log.2']);
    expect(await readFile(path, 'utf8')).toContain('line 19');
    for (const file of files) expect((await readFile(join(dir, file), 'utf8')).length).toBeLessThanOrEqual(200);
  });
});

describe('rotation helpers', () => {
  it('shifts copies and drops the oldest', async () => {
    const dir = await tempDir();
    const path = join(dir, 'x.log');
    await writeFile(path, 'current');
    await writeFile(`${path}.1`, 'older');
    await writeFile(`${path}.2`, 'oldest');
    rotate(path, 2);
    expect(await readFile(`${path}.1`, 'utf8')).toBe('current');
    expect(await readFile(`${path}.2`, 'utf8')).toBe('older');
    expect((await readdir(dir)).sort()).toEqual(['x.log.1', 'x.log.2']);
  });

  it('only rotates a file that reached its limit', async () => {
    const dir = await tempDir();
    const path = join(dir, 'x.log');
    await writeFile(path, '12345');
    expect(rotateIfLarge(path, 10, 3)).toBe(false);
    expect(rotateIfLarge(path, 5, 3)).toBe(true);
    expect(rotateIfLarge(join(dir, 'missing.log'), 1, 3)).toBe(false);
  });
});

describe('parseLogLine', () => {
  it('reads back what the logger writes', () => {
    const time = new Date('2026-11-10T15:00:00.000Z');
    const line = formatLogLine(time, 'warn', 'wacli: error: {weird} line', { code: 1, nested: { a: [1, 2] } });
    expect(parseLogLine(line)).toEqual({
      time,
      level: 'warn',
      message: 'wacli: error: {weird} line',
      fields: { code: 1, nested: { a: [1, 2] } },
    });
  });

  it('handles lines without fields and rejects other text', () => {
    expect(parseLogLine('2026-11-10T15:00:00.000Z INFO stopped')).toMatchObject({ message: 'stopped', fields: {} });
    expect(parseLogLine('Error: something crashed')).toBeNull();
    expect(parseLogLine('')).toBeNull();
  });
});
