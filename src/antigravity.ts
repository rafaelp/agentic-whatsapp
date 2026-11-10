import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineConfig } from './config.js';
import { DECISION_SCHEMA, type DecisionMaker, decisionFromValue, parseDecision } from './decision.js';
import { runProcess } from './process.js';
import type { Decision } from './types.js';
import { errorMessage, isRecord, lastLines } from './util.js';

/**
 * Settings for one agy run only (agy never saves them). Antigravity has no switch to
 * turn tools off, so: every permission namespace is denied, `strict` requires an
 * approval for any other tool action (which headless mode cannot give), slash
 * commands are disabled, and paid AI credits are never spent once the quota runs out.
 */
export const SESSION_SETTINGS = {
  // The standard mode (agy rejects "default"). Overrides an "auto" mode saved in the user's settings.
  agentMode: '',
  toolPermission: 'strict',
  allowNonWorkspaceAccess: false,
  disableSlashCommands: true,
  useG1Credits: false,
  permissions: {
    allow: [],
    ask: [],
    deny: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'mcp(*)'],
  },
};

/** Tools that only end the agent's turn. */
export const TURN_TOOLS = new Set(['finish']);

/**
 * Tools that SESSION_SETTINGS makes agy refuse (checked against agy 1.5.3). The model
 * may try them and gets a permission error back; if one ever completes, the answer is
 * discarded. Any tool outside these two sets discards the answer as soon as it starts.
 */
export const POLICY_DENIED_TOOLS = new Set(['read_file', 'write_file', 'run_command']);

export class ToolUseError extends Error {
  constructor(readonly tool: string) {
    super(`Antigravity used a tool (${tool}), so its answer was discarded`);
    this.name = 'ToolUseError';
  }
}

/**
 * Engine `antigravity`: Antigravity CLI (`agy`) in headless mode, signed in with a
 * personal Google account, so it runs on the Google AI subscription.
 *
 * The prompt goes through stdin (stream-json), which keeps message content out of the
 * process list, and the decision is enforced with --json-schema. Some tools, such as
 * web search, cannot be denied by any setting, so the event stream is watched: a tool
 * that could have an effect kills the run and its answer is discarded. That happens
 * once at most per decision: the second attempt tells the model why the first failed.
 */
export class AntigravityCli implements DecisionMaker {
  private readonly dir: string;

  constructor(
    private readonly config: EngineConfig,
    stateDir: string,
    private readonly system: string,
  ) {
    this.dir = join(stateDir, 'antigravity');
  }

  get workspace(): string {
    return join(this.dir, 'workspace');
  }

  get settingsFile(): string {
    return join(this.dir, 'session-settings.json');
  }

  get schemaFile(): string {
    return join(this.dir, 'decision-schema.json');
  }

  async prepare(): Promise<void> {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    await writeFile(this.settingsFile, `${JSON.stringify(SESSION_SETTINGS, null, 2)}\n`, { mode: 0o600 });
    await writeFile(this.schemaFile, `${JSON.stringify(DECISION_SCHEMA, null, 2)}\n`, { mode: 0o600 });
  }

  args(): string[] {
    return [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--json-schema',
      this.schemaFile,
      '--settings',
      this.settingsFile,
      '--model',
      this.config.model,
      '--print-timeout',
      `${this.config.timeoutSeconds}s`,
      '--disable-slash-commands',
      ...this.config.extraArgs,
    ];
  }

  /** agy has no system prompt override, so the agent's rules open the user turn. */
  input(prompt: string): string {
    return `${JSON.stringify({ event: 'user', message: { content: `${this.system}\n\n${prompt}` } })}\n`;
  }

  async decide(prompt: string): Promise<Decision> {
    try {
      return await this.attempt(prompt);
    } catch (error) {
      if (!(error instanceof ToolUseError)) throw error;
      return this.attempt(
        `${prompt}\n\nYour previous answer was discarded because you used the tool ${error.tool}. ` +
          'Do not use any tool: answer directly with the JSON object.',
      );
    }
  }

  private async attempt(prompt: string): Promise<Decision> {
    let violation: string | undefined;
    let result: unknown;
    let run;
    try {
      run = await runProcess(this.config.command, this.args(), {
        input: this.input(prompt),
        // agy enforces --print-timeout itself; this is the backstop.
        timeoutMs: (this.config.timeoutSeconds + 15) * 1000,
        cwd: this.workspace,
        onStdoutLine: (line, stop) => {
          const event = parseEvent(line);
          if (event === null) return;
          if (event.event === 'result') {
            result = event.result;
            return;
          }
          if (event.event !== 'step_update' || !isRecord(event.step_update)) return;
          const tool = event.step_update.tool_name;
          if (typeof tool !== 'string' || tool === '' || TURN_TOOLS.has(tool)) return;
          if (POLICY_DENIED_TOOLS.has(tool) && event.step_update.state !== 'DONE') return;
          violation ??= tool;
          stop();
        },
      });
    } catch (error) {
      throw new Error(`Could not start ${this.config.command}: ${errorMessage(error)}`);
    }

    if (violation !== undefined) throw new ToolUseError(violation);
    if (run.timedOut) throw new Error(`Antigravity did not answer within ${this.config.timeoutSeconds}s`);
    return decisionFromResult(result, run.stderr, run.code);
  }
}

/** Turns the `result` event of `agy --output-format stream-json` into a decision. */
export function decisionFromResult(result: unknown, stderr: string, code: number | null): Decision {
  if (!isRecord(result)) {
    throw new Error(`Antigravity exited with code ${String(code)} without an answer: ${lastLines(stderr) || 'no output'}`);
  }
  if (result.status !== 'SUCCESS') {
    const error = isRecord(result.error) ? result.error.message : result.error;
    const detail = typeof error === 'string' && error !== '' ? error : lastLines(stderr) || 'no details';
    throw new Error(`Antigravity answered with status ${String(result.status)}: ${detail}`);
  }
  if (isRecord(result.structured_output)) return decisionFromValue(result.structured_output);
  if (typeof result.response === 'string') return parseDecision(result.response);
  throw new Error('Antigravity answered without a decision');
}

function parseEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
