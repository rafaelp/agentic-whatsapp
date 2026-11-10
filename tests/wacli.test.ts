import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope, SyncSupervisor, Wacli } from '../src/wacli.js';
import { BOB, fakeCommand, MemoryLogger, tempDir } from './helpers.js';

describe('parseEnvelope', () => {
  it('reads the last JSON envelope', () => {
    expect(parseEnvelope('warning: x\n{"success":true,"data":{"id":"A"},"error":null}\n')).toEqual({
      success: true,
      data: { id: 'A' },
      error: null,
    });
    expect(parseEnvelope('{"success":false,"data":null,"error":"not authenticated"}')).toEqual({
      success: false,
      data: null,
      error: 'not authenticated',
    });
    expect(parseEnvelope('plain text')).toBeNull();
  });
});

describe('Wacli', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const recordingWacli = async (stdout: string) => {
    const dir = await tempDir();
    const log = join(dir, 'args.json');
    process.env.FAKE_LOG = log;
    process.env.FAKE_STDOUT = stdout;
    const command = await fakeCommand(
      dir,
      'wacli',
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.FAKE_STDOUT + '\\n');`,
    );
    return { command, args: async () => JSON.parse(await readFile(log, 'utf8')) as string[] };
  };

  it('sends text with flag=value arguments and returns the message ID', async () => {
    const fake = await recordingWacli('{"success":true,"data":{"sent":true,"to":"x","id":"3EB0AA"},"error":null}');
    const wacli = new Wacli(fake.command, '/tmp/store');
    expect(await wacli.sendText(BOB, '-oi\nlinha 2')).toBe('3EB0AA');
    expect(await fake.args()).toEqual([
      '--store=/tmp/store',
      'send',
      'text',
      `--to=${BOB}`,
      '--message=-oi\nlinha 2',
      '--no-preview',
      '--json',
    ]);
  });

  it('lists the messages of a chat', async () => {
    const fake = await recordingWacli('{"success":true,"data":{"messages":[{"MsgID":"1"}],"fts":true},"error":null}');
    const wacli = new Wacli(fake.command, '');
    expect(await wacli.listMessages(BOB, 5)).toEqual([{ MsgID: '1' }]);
    expect(await fake.args()).toEqual(['messages', 'list', `--chat=${BOB}`, '--limit=5', '--json']);
  });

  it('raises the error wacli reports', async () => {
    const fake = await recordingWacli('{"success":false,"data":null,"error":"recipient not found"}');
    await expect(new Wacli(fake.command, '').sendText(BOB, 'oi')).rejects.toThrow(/recipient not found/);
  });
});

describe('SyncSupervisor', () => {
  it('runs wacli with the given arguments and stops it', async () => {
    const dir = await tempDir();
    const command = await fakeCommand(
      dir,
      'wacli',
      `console.log('Connected. ' + process.argv.slice(2).join(' '));
setInterval(() => {}, 1000);`,
    );
    const log = new MemoryLogger();
    const supervisor = new SyncSupervisor(new Wacli(command, ''), ['sync', '--follow'], log);
    supervisor.start();
    await expect
      .poll(() => log.entries.some((entry) => entry.message.includes('sync --follow')), { timeout: 10_000 })
      .toBe(true);
    await supervisor.stop();
    expect(log.has('warn', 'wacli sync stopped, restarting')).toBe(false);
  });

  it('restarts wacli when it exits', async () => {
    const dir = await tempDir();
    const command = await fakeCommand(dir, 'wacli', 'process.exit(3);');
    const log = new MemoryLogger();
    const supervisor = new SyncSupervisor(new Wacli(command, ''), ['sync'], log);
    supervisor.start();
    await expect.poll(() => log.has('warn', 'wacli sync stopped, restarting'), { timeout: 10_000 }).toBe(true);
    await supervisor.stop();
  });
});
