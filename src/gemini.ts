import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineConfig } from './config.js';
import { type DecisionMaker, extractJsonObject, parseDecision } from './decision.js';
import { runProcess } from './process.js';
import type { Decision } from './types.js';
import { errorMessage, isRecord, lastLines } from './util.js';

const FINAL_PROMPT = 'Answer with the JSON decision for the input above.';

/** Admin-tier policy that denies every tool: Gemini only reads the prompt and answers. */
export const DENY_ALL_TOOLS_POLICY = `# Written by agentic-whatsapp. The agent must not run any tool.
[[rule]]
toolName = "*"
decision = "deny"
priority = 999
`;

/**
 * Engine `gemini-cli`: Gemini CLI in headless mode. Since June 2026 it only serves
 * API keys and enterprise accounts. It runs in an empty workspace, with its system
 * prompt replaced and every tool denied, so it can only answer with text. The prompt
 * goes through stdin, which keeps message content out of the process list.
 */
export class GeminiCli implements DecisionMaker {
  private readonly dir: string;

  constructor(
    private readonly config: EngineConfig,
    stateDir: string,
    private readonly system: string,
  ) {
    this.dir = join(stateDir, 'gemini');
  }

  get workspace(): string {
    return join(this.dir, 'workspace');
  }

  get systemFile(): string {
    return join(this.dir, 'system.md');
  }

  get policyFile(): string {
    return join(this.dir, 'deny-all-tools.toml');
  }

  async prepare(): Promise<void> {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    await writeFile(this.systemFile, this.system, { mode: 0o600 });
    await writeFile(this.policyFile, DENY_ALL_TOOLS_POLICY, { mode: 0o600 });
  }

  args(): string[] {
    return [
      '--model',
      this.config.model,
      '--output-format',
      'json',
      '--skip-trust',
      '--admin-policy',
      this.policyFile,
      ...this.config.extraArgs,
      '--prompt',
      FINAL_PROMPT,
    ];
  }

  async decide(prompt: string): Promise<Decision> {
    let result;
    try {
      result = await runProcess(this.config.command, this.args(), {
        input: prompt,
        timeoutMs: this.config.timeoutSeconds * 1000,
        cwd: this.workspace,
        env: { ...process.env, GEMINI_SYSTEM_MD: this.systemFile },
      });
    } catch (error) {
      throw new Error(`Could not start ${this.config.command}: ${errorMessage(error)}`);
    }
    if (result.timedOut) throw new Error(`Gemini did not answer within ${this.config.timeoutSeconds}s`);
    return parseDecision(parseCliOutput(result.stdout, result.stderr, result.code));
  }
}

/** Extracts `response` from `gemini --output-format json`. */
export function parseCliOutput(stdout: string, stderr: string, code: number | null): string {
  const json = extractJsonObject(stdout);
  let output: unknown;
  if (json !== null) {
    try {
      output = JSON.parse(json);
    } catch {
      output = undefined;
    }
  }
  if (isRecord(output)) {
    if (output.error !== undefined && output.error !== null) {
      const detail = isRecord(output.error) ? output.error.message : output.error;
      throw new Error(`Gemini returned an error: ${String(detail)}`);
    }
    if (typeof output.response === 'string') return output.response;
  }
  const detail = lastLines(stderr) || lastLines(stdout) || 'no output';
  throw new Error(`Gemini exited with code ${String(code)}: ${detail}`);
}
