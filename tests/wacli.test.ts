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
    try {
      await expect
        .poll(() => log.entries.some((entry) => entry.message.includes('sync --follow')), { timeout: 10_000 })
        .toBe(true);
    } finally {
      // Never leave the fake wacli running, even when the assertion fails.
      await supervisor.stop();
    }
    expect(log.has('warn', 'wacli sync stopped, restarting')).toBe(false);
  });

  it('restarts wacli when it exits, and reports why', async () => {
    const dir = await tempDir();
    const command = await fakeCommand(
      dir,
      'wacli',
      `console.log('Connected.');
console.error('error: not authenticated; run wacli auth');
process.exit(3);`,
    );
    const log = new MemoryLogger();
    const exits: { code: number | null; lastLine: string }[] = [];
    const supervisor = new SyncSupervisor(new Wacli(command, ''), ['sync'], log, {
      onExit: ({ code, lastLine }) => exits.push({ code, lastLine }),
    });
    supervisor.start();
    try {
      await expect.poll(() => exits.length, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      await supervisor.stop();
    }
    expect(exits[0]).toEqual({ code: 3, lastLine: 'error: not authenticated; run wacli auth' });
    expect(log.has('warn', 'wacli sync stopped, restarting')).toBe(true);
  });

  it('says when wacli has stayed up', async () => {
    const dir = await tempDir();
    const command = await fakeCommand(dir, 'wacli', 'setInterval(() => {}, 1000);');
    let healthy = 0;
    const supervisor = new SyncSupervisor(new Wacli(command, ''), ['sync'], new MemoryLogger(), {
      onHealthy: () => {
        healthy += 1;
      },
      healthyAfterMs: 50,
    });
    supervisor.start();
    try {
      await expect.poll(() => healthy, { timeout: 10_000 }).toBe(1);
    } finally {
      await supervisor.stop();
    }
  });
});

describe('Wacli.messageText', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reads one message read-only, and returns null when it cannot', async () => {
    const dir = await tempDir();
    process.env.FAKE_LOG = join(dir, 'args.json');
    const command = await fakeCommand(
      dir,
      'wacli',
      `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_LOG, JSON.stringify(args));
if (args.includes('--id=M1')) console.log(JSON.stringify({ success: true, data: { Text: '', MediaCaption: 'foto da festa' }, error: null }));
else console.log(JSON.stringify({ success: false, data: null, error: 'message not found' }));`,
    );
    const wacli = new Wacli(command, '');
    expect(await wacli.messageText(BOB, 'M1')).toBe('foto da festa');
    expect(JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'))).toEqual([
      '--read-only',
      'messages',
      'show',
      `--chat=${BOB}`,
      '--id=M1',
      '--json',
    ]);
    expect(await wacli.messageText(BOB, 'NOPE')).toBeNull();
  });
});
