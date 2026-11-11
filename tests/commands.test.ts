import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommand, type CommandRule, parseCommandRule, ruleMatches } from '../src/command-rules.js';
import { cliCheck, cliDescription, cliServer, cliTools, clip, CommandRunner, type CommandResult } from '../src/commands.js';
import type { CommandRecord } from '../src/state.js';
import { ToolCallError } from '../src/settings-mcp.js';
import { fakeCommand, makeConfig, MemoryLogger, tempDir } from './helpers.js';

const rule = (text: string): CommandRule => {
  const parsed = parseCommandRule(text);
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
};

describe('command rules', () => {
  it('match a program and the words a command starts with', () => {
    expect(ruleMatches(rule('joplin'), ['joplin', 'rmnote', 'x'])).toBe(true);
    expect(ruleMatches(rule('joplin mknote'), ['joplin', 'mknote', 'Compras'])).toBe(true);
    expect(ruleMatches(rule('joplin mknote'), ['joplin', 'mknotes'])).toBe(false);
    expect(ruleMatches(rule('joplin mknote'), ['joplin', '--profile', 'p', 'mknote'])).toBe(false);
    expect(ruleMatches(rule('joplin'), ['/usr/bin/joplin'])).toBe(false);
    expect(ruleMatches(rule('/opt/bin/joplin ls'), ['joplin', 'ls'])).toBe(true);
    expect(ruleMatches(rule('/opt/bin/joplin ls'), ['/opt/bin/joplin', 'ls', '-l'])).toBe(true);
  });

  it('let a deny rule win, and name the most specific allow rule', () => {
    const allow = [rule('joplin'), rule('joplin set')];
    const deny = [rule('joplin rmnote')];
    expect(checkCommand(['joplin', 'set', 'a1', 'body', 'x'], allow, deny)).toEqual({ allowed: true, rule: rule('joplin set') });
    expect(checkCommand(['joplin', 'rmnote', 'a1'], allow, deny)).toEqual({ allowed: false, reason: '[cli] deny has "joplin rmnote"' });
    expect(checkCommand(['rm', '-rf', '/'], allow, deny)).toEqual({
      allowed: false,
      reason: '[cli] allow has no rule for it (it allows "joplin", "joplin set")',
    });
    expect(checkCommand([], allow, deny)).toEqual({ allowed: false, reason: 'the command is empty' });
  });
});

function runner(options: { allow?: string[]; deny?: string[]; dryRun?: boolean; result?: Partial<CommandResult>; found?: boolean } = {}) {
  const config = makeConfig({ cli: { allow: options.allow ?? ['joplin mknote', 'joplin set'], deny: options.deny ?? [], timeout_seconds: 7 } });
  const records: CommandRecord[] = [];
  const runs: { file: string; args: readonly string[]; cwd: string; timeoutMs: number; path: string }[] = [];
  const log = new MemoryLogger();
  const commands = new CommandRunner({
    cli: config.cli,
    cwd: join(config.paths.stateDir, 'cli'),
    record: (record) => records.push(record),
    log,
    dryRun: options.dryRun ?? false,
    resolve: (program) => (options.found === false ? null : `/opt/node/bin/${program}`),
    exec: async (file, args, { cwd, timeoutMs, env }) => {
      runs.push({ file, args, cwd, timeoutMs, path: env.PATH ?? '' });
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, ...options.result };
    },
  });
  return { config, commands, records, runs, log };
}

describe('CommandRunner', () => {
  it('runs an allowed command without a shell, from its own folder first on PATH, and records it', async () => {
    const { config, commands, records, runs, log } = runner();
    const result = await commands.run(['joplin', 'mknote', 'Compras; rm -rf ~']);
    expect(result).toMatchObject({ rule: 'joplin mknote', exitCode: 0, stdout: 'ok' });
    expect(runs).toEqual([
      {
        file: '/opt/node/bin/joplin',
        args: ['mknote', 'Compras; rm -rf ~'],
        cwd: join(config.paths.stateDir, 'cli'),
        timeoutMs: 7_000,
        path: expect.stringMatching(/^\/opt\/node\/bin:/),
      },
    ]);
    expect(records).toEqual([
      expect.objectContaining({ program: 'joplin', rule: 'joplin mknote', command: ['joplin', 'mknote', 'Compras; rm -rf ~'], status: 'ok', exitCode: 0 }),
    ]);
    // The log names the program and the rule, never the arguments.
    expect(log.entries.find((entry) => entry.message === 'command')?.fields).toEqual({ program: 'joplin', rule: 'joplin mknote', exitCode: 0, seconds: 0 });
    expect(JSON.stringify(log.entries)).not.toContain('Compras');
  });

  it('refuses what the rules do not allow, and records the refusal', async () => {
    const { commands, records, runs, log } = runner({ allow: ['joplin'], deny: ['joplin rmnote'] });
    await expect(commands.run(['joplin', 'rmnote', 'a1'])).rejects.toThrow('Not allowed: [cli] deny has "joplin rmnote"');
    await expect(commands.run(['bash', '-c', 'echo'])).rejects.toThrow(ToolCallError);
    expect(runs).toEqual([]);
    expect(records.map((record) => record.status)).toEqual(['refused', 'refused']);
    expect(log.has('warn', 'command refused')).toBe(true);
  });

  it('reports a failed or stuck command, and a program it cannot find', async () => {
    expect(await runner({ result: { exitCode: 2, stderr: 'no such note' } }).commands.run(['joplin', 'set', 'x'])).toMatchObject({ exitCode: 2 });
    const stuck = runner({ result: { exitCode: null, timedOut: true } });
    await stuck.commands.run(['joplin', 'set', 'x']);
    expect(stuck.records[0]?.status).toBe('timeout');
    const missing = runner({ found: false });
    await expect(missing.commands.run(['joplin', 'mknote', 'x'])).rejects.toThrow(/joplin was not found on the agent's PATH/);
    expect(missing.records[0]).toMatchObject({ status: 'failed' });
  });

  it('runs nothing in a dry run', async () => {
    const { commands, records, runs } = runner({ dryRun: true });
    expect(await commands.run(['joplin', 'mknote', 'x'])).toMatchObject({ stdout: 'Dry run: the command was not run.' });
    expect(runs).toEqual([]);
    expect(records[0]?.status).toBe('dry_run');
  });

  it('really runs a program, with stdin closed and in a folder of its own', async () => {
    const dir = await tempDir();
    const program = await fakeCommand(
      dir,
      'echoargs',
      `let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => {
  console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input })); process.exit(3); });`,
    );
    const config = makeConfig({ cli: { allow: [program] } }, dir);
    const records: CommandRecord[] = [];
    const commands = new CommandRunner({ cli: config.cli, cwd: join(dir, 'cli'), record: (record) => records.push(record), log: new MemoryLogger(), dryRun: false });
    const result = await commands.run([program, 'a b', '$(whoami)']);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ args: ['a b', '$(whoami)'], cwd: expect.stringContaining('/cli'), input: '' });
    expect((await stat(join(dir, 'cli'))).mode & 0o777).toBe(0o700);
    expect(records[0]?.status).toBe('failed');
  });
});

describe('run_cli', () => {
  it('takes the command as a list and returns the exit code and output, clipped', async () => {
    const { commands } = runner({ result: { stdout: 'x'.repeat(9_000) } });
    const [tool] = cliTools(commands);
    expect(tool?.name).toBe('run_cli');
    const answer = JSON.parse((await tool?.call({ command: ['joplin', 'mknote', 'Compras'] })) ?? '');
    expect(answer.exit_code).toBe(0);
    expect(answer.stdout).toMatch(/… \(1000 more characters\)$/);
    expect(answer.stderr).toBeUndefined();
    await expect(tool?.call({ command: 'joplin mknote Compras' })).rejects.toThrow('"command" must be a list of strings');
    await expect(tool?.call({ command: [] })).rejects.toThrow(ToolCallError);
    expect(clip('abc', 5)).toBe('abc');
  });
});

describe('cliServer', () => {
  it('starts this CLI with the config of the agent, and tells the model what it may run', () => {
    const config = makeConfig({ cli: { allow: ['/opt/bin/joplin mknote', 'joplin ls'], deny: ['joplin rmnote'] } });
    const server = cliServer(config, { dryRun: false, cli: '/x/cli.js' });
    expect(server).toMatchObject({
      name: 'agentic-whatsapp-cli',
      command: process.execPath,
      args: ['/x/cli.js', 'cli-mcp', `--config=${config.paths.configFile}`],
      tools: ['run_cli'],
    });
    expect(cliDescription(config.cli)).toContain('Allowed, as a command starts: joplin mknote; joplin ls. Never allowed: joplin rmnote.');
    expect(server.description).toContain('never with run_command');
  });
});

describe('cliCheck', () => {
  it('says where each program is, and whether the service can find it', async () => {
    const dir = await tempDir();
    await fakeCommand(dir, 'joplin', '');
    const program = join(dir, 'joplin.mjs');
    const config = makeConfig({ cli: { allow: ['joplin.mjs mknote', 'joplin.mjs ls', 'missing', 'bash'], deny: ['joplin.mjs rmnote'] } });
    expect(cliCheck(config, { path: dir, servicePath: '/usr/bin:/bin' })).toEqual([
      { status: 'ok', detail: '4 allow and 1 deny rule(s), for commands you type in any chat' },
      { status: 'note', detail: `joplin.mjs is at ${program}, outside the service's PATH: run agentic-whatsapp install again` },
      { status: 'fail', detail: 'missing was not found on PATH' },
      { status: 'note', detail: '"bash" lets the agent run any command your user can' },
      { status: 'fail', detail: 'bash was not found on PATH' },
    ]);
    expect(cliCheck(config, { path: dir, servicePath: dir })[1]).toEqual({ status: 'ok', detail: `joplin.mjs: ${program}` });
    expect(cliCheck(makeConfig(), { path: dir })).toEqual([{ status: 'ok', detail: 'off: no [cli] allow rules' }]);
  });
});
