import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DENY_ALL_TOOLS_POLICY, GeminiCli, parseCliOutput } from '../src/gemini.js';
import { fakeCommand, makeConfig, tempDir } from './helpers.js';

describe('parseCliOutput', () => {
  it('returns the response field', () => {
    expect(parseCliOutput('{"response":"{\\"actions\\":[]}","stats":{}}', '', 0)).toBe('{"actions":[]}');
  });

  it('tolerates log lines around the JSON', () => {
    expect(parseCliOutput('Loaded cached credentials.\n{"response":"ok"}\n', '', 0)).toBe('ok');
  });

  it('raises the error Gemini CLI reports', () => {
    expect(() => parseCliOutput('{"error":{"message":"quota exceeded"}}', '', 1)).toThrow(/quota exceeded/);
  });

  it('raises stderr when there is no JSON', () => {
    expect(() => parseCliOutput('', 'Please set an Auth method', 1)).toThrow(/Please set an Auth method/);
  });
});

describe('GeminiCli', () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dir = await tempDir();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const engine = (overrides: Record<string, unknown>) =>
    makeConfig({ engine: { kind: 'gemini-cli', ...overrides } }, dir).engine;

  it('runs headless with no tools, the replaced system prompt and the prompt on stdin', async () => {
    const command = await fakeCommand(
      dir,
      'gemini',
      `import { readFileSync, writeFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), input, system: process.env.GEMINI_SYSTEM_MD, cwd: process.cwd() }));
process.stdout.write(JSON.stringify({ response: '{"actions":[{"type":"notify","text":"oi"}]}', stats: {} }));`,
    );
    const log = join(dir, 'call.json');
    process.env.FAKE_LOG = log;
    const gemini = new GeminiCli(engine({ command, model: 'gemini-test', extra_args: ['--debug'] }), dir, 'SYSTEM PROMPT');
    await gemini.prepare();

    const decision = await gemini.decide('MENSAGENS');

    expect(decision.actions).toEqual([{ type: 'notify', text: 'oi' }]);
    const call = JSON.parse(await readFile(log, 'utf8'));
    expect(call.input).toBe('MENSAGENS');
    expect(call.args).toEqual([
      '--model',
      'gemini-test',
      '--output-format',
      'json',
      '--skip-trust',
      '--admin-policy',
      gemini.policyFile,
      '--debug',
      '--prompt',
      expect.any(String),
    ]);
    expect(call.system).toBe(gemini.systemFile);
    expect(await readFile(gemini.systemFile, 'utf8')).toBe('SYSTEM PROMPT');
    expect(await readFile(gemini.policyFile, 'utf8')).toBe(DENY_ALL_TOOLS_POLICY);
    expect(call.cwd).toContain(join('gemini', 'workspace'));
  });

  it('reports a timeout', async () => {
    const command = await fakeCommand(dir, 'gemini', 'setTimeout(() => {}, 60_000);');
    const gemini = new GeminiCli({ ...engine({ command }), timeoutSeconds: 0.2 }, dir, 'S');
    await gemini.prepare();
    await expect(gemini.decide('x')).rejects.toThrow(/did not answer/);
  });

  it('reports a command that cannot be started', async () => {
    const gemini = new GeminiCli(engine({ command: join(dir, 'missing-gemini') }), dir, 'S');
    await gemini.prepare();
    await expect(gemini.decide('x')).rejects.toThrow(/Could not start/);
  });
});
