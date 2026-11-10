import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityCli, decisionFromResult, SESSION_SETTINGS } from '../src/antigravity.js';
import { DECISION_SCHEMA } from '../src/decision.js';
import { createEngine } from '../src/engine.js';
import { GeminiCli } from '../src/gemini.js';
import { fakeCommand, makeConfig, tempDir } from './helpers.js';

const success = (structured: unknown) => ({
  conversation_id: 'c1',
  status: 'SUCCESS',
  response: JSON.stringify(structured),
  structured_output: structured,
});

const result = (structured: unknown) => ({ event: 'result', result: success(structured) });
const tool = (name: string, state: string) => ({
  event: 'step_update',
  step_update: { state, step_type: 'tool', tool_name: name },
});
/** Makes the fake agy hang, so only a killed run ends quickly. */
const HANG = { hang: true };

describe('decisionFromResult', () => {
  it('uses the structured output', () => {
    const decision = decisionFromResult(success({ actions: [{ type: 'notify', text: 'oi' }] }), '', 0);
    expect(decision.actions).toEqual([{ type: 'notify', text: 'oi' }]);
  });

  it('falls back to the response text', () => {
    const decision = decisionFromResult({ status: 'SUCCESS', response: '{"actions":[]}' }, '', 0);
    expect(decision.actions).toEqual([]);
  });

  it('raises a failed status with its error', () => {
    expect(() => decisionFromResult({ status: 'ERROR', error: 'quota exhausted' }, '', 1)).toThrow(
      /status ERROR: quota exhausted/,
    );
    expect(() => decisionFromResult({ status: 'ERROR', error: { message: 'unknown model' } }, '', 1)).toThrow(
      /unknown model/,
    );
  });

  it('raises a missing result with stderr', () => {
    expect(() => decisionFromResult(undefined, 'authentication required', 1)).toThrow(/authentication required/);
  });
});

describe('AntigravityCli', () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dir = await tempDir();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  /**
   * A fake agy. Run N prints `attempts[N]` (the last entry repeats) as stream-json
   * events, and every call is recorded in calls.jsonl.
   */
  const fakeAgy = async (attempts: unknown[][], onEnd = '') => {
    process.env.FAKE_DIR = dir;
    process.env.FAKE_ATTEMPTS = JSON.stringify(attempts);
    return fakeCommand(
      dir,
      'agy',
      `import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_DIR;
const input = readFileSync(0, 'utf8');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }) + '\\n');
const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\\n').length;
const attempts = JSON.parse(process.env.FAKE_ATTEMPTS);
const events = attempts[Math.min(calls, attempts.length) - 1] ?? [];
for (const event of events) {
  if (event.hang) setInterval(() => {}, 1000);
  else process.stdout.write(JSON.stringify(event) + '\\n');
}
${onEnd}`,
    );
  };

  const calls = async () =>
    (await readFile(join(dir, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string });

  const engine = (command: string, overrides: Record<string, unknown> = {}) =>
    makeConfig({ engine: { command, model: 'gemini-3.8-flash-low', ...overrides } }, dir).engine;

  const decide = async (command: string, overrides: Record<string, unknown> = {}) => {
    const agy = new AntigravityCli(engine(command, overrides), dir, 'RULES');
    await agy.prepare();
    return { agy, decision: agy.decide('MESSAGES') };
  };

  it('sends the rules and the prompt on stdin and reads the structured result', async () => {
    const command = await fakeAgy([
      [
        { event: 'init', init: { model: 'gemini-3.8-flash-low' } },
        { event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: '{}' } },
        result({ actions: [{ type: 'notify', text: 'Bob pediu o boleto' }] }),
      ],
    ]);
    const { agy, decision } = await decide(command, { extra_args: ['--effort', 'low'] });

    expect((await decision).actions).toEqual([{ type: 'notify', text: 'Bob pediu o boleto' }]);
    const [call] = await calls();
    expect(call?.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--json-schema',
      agy.schemaFile,
      '--settings',
      agy.settingsFile,
      '--model',
      'gemini-3.8-flash-low',
      '--print-timeout',
      '120s',
      '--disable-slash-commands',
      '--effort',
      'low',
    ]);
    expect(call?.input.endsWith('\n')).toBe(true);
    expect(JSON.parse(call?.input ?? '')).toEqual({ event: 'user', message: { content: 'RULES\n\nMESSAGES' } });
    expect(call?.cwd).toContain(join('antigravity', 'workspace'));
  });

  it('writes session settings that deny every tool, and the decision schema', async () => {
    const agy = new AntigravityCli(engine('agy'), dir, 'RULES');
    await agy.prepare();
    const settings = JSON.parse(await readFile(agy.settingsFile, 'utf8'));
    expect(settings).toEqual(SESSION_SETTINGS);
    expect(settings.toolPermission).toBe('strict');
    expect(settings.useG1Credits).toBe(false);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'mcp(*)']),
    );
    expect(JSON.parse(await readFile(agy.schemaFile, 'utf8'))).toEqual(DECISION_SCHEMA);
  });

  it('kills the run at a tool that settings cannot deny, and fails after a second attempt', async () => {
    const command = await fakeAgy([[{ event: 'init', init: {} }, tool('search_web', 'ACTIVE'), HANG]]);
    const started = Date.now();
    const { decision } = await decide(command);
    await expect(decision).rejects.toThrow(/used a tool \(search_web\)/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await calls()).toHaveLength(2);
  });

  it('retries once after a tool call, telling the model why', async () => {
    const command = await fakeAgy([
      [tool('search_web', 'ACTIVE'), HANG],
      [result({ actions: [{ type: 'notify', text: 'segunda tentativa' }] })],
    ]);
    const { decision } = await decide(command);
    expect((await decision).actions).toEqual([{ type: 'notify', text: 'segunda tentativa' }]);
    const second = (await calls())[1];
    expect(second?.input).toContain('previous answer was discarded because you used the tool search_web');
  });

  it('lets the model try a tool that agy refuses, and uses the answer that follows', async () => {
    const command = await fakeAgy([
      [
        tool('read_file', 'ACTIVE'),
        tool('read_file', 'ERROR'),
        tool('run_command', 'ACTIVE'),
        tool('run_command', 'ERROR'),
        result({ actions: [{ type: 'notify', text: 'Carla pediu o boleto' }] }),
      ],
    ]);
    const { decision } = await decide(command);
    expect((await decision).actions).toEqual([{ type: 'notify', text: 'Carla pediu o boleto' }]);
    expect(await calls()).toHaveLength(1);
  });

  it('discards the answer if a tool that agy should refuse completes', async () => {
    const command = await fakeAgy([
      [tool('read_file', 'ACTIVE'), tool('read_file', 'DONE'), result({ actions: [{ type: 'reply', text: 'x' }] })],
    ]);
    const { decision } = await decide(command);
    await expect(decision).rejects.toThrow(/used a tool \(read_file\)/);
  });

  it('lets the agent end its turn with the finish tool', async () => {
    const command = await fakeAgy([[tool('finish', 'ACTIVE'), tool('finish', 'DONE'), result({ actions: [] })]]);
    const { decision } = await decide(command);
    expect((await decision).actions).toEqual([]);
  });

  it('reports a run that ends without a result, without retrying', async () => {
    const command = await fakeAgy([[]], `process.stderr.write('authentication required'); process.exit(1);`);
    const { decision } = await decide(command);
    await expect(decision).rejects.toThrow(/authentication required/);
    expect(await calls()).toHaveLength(1);
  });
});

describe('createEngine', () => {
  it('builds the configured engine', async () => {
    const dir = await tempDir();
    expect(createEngine(makeConfig({}, dir).engine, dir, 'S')).toBeInstanceOf(AntigravityCli);
    expect(createEngine(makeConfig({ engine: { kind: 'gemini-cli' } }, dir).engine, dir, 'S')).toBeInstanceOf(
      GeminiCli,
    );
  });
});
