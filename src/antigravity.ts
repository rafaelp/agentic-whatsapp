import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EngineConfig } from './config.js';
import {
  type Attempt,
  DECISION_SCHEMA,
  type DecideOptions,
  type DecisionMaker,
  decisionFromValue,
  parseDecision,
} from './decision.js';
import { runProcess } from './process.js';
import { agyMcpDir, hasTools, type McpServer, type ToolSet } from './tools.js';
import type { Decision } from './types.js';
import { NO_USAGE, addUsage, type Usage } from './usage.js';
import { asString, errorMessage, isRecord, lastLines, writeFileAtomic } from './util.js';

export interface SessionSettings {
  agentMode: string;
  toolPermission: string;
  allowNonWorkspaceAccess: boolean;
  disableSlashCommands: boolean;
  useG1Credits: boolean;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
}

/**
 * Settings for one agy run only (agy never saves them). Antigravity has no switch to
 * turn tools off, so: every permission namespace is denied, `strict` requires an
 * approval for any other tool action (which headless mode cannot give), slash
 * commands are disabled, and paid AI credits are never spent once the quota runs out.
 */
export const SESSION_SETTINGS: SessionSettings = {
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

/** The agy tool that calls a tool of an MCP server. */
export const MCP_TOOL = 'call_mcp_tool';

/**
 * Tools that SESSION_SETTINGS makes agy refuse (checked against agy 1.5.3). The model
 * may try them and gets a permission error back; if one ever completes, the answer is
 * discarded. Any tool outside these two sets discards the answer as soon as it starts.
 */
export const POLICY_DENIED_TOOLS = new Set(['read_file', 'write_file', 'run_command']);

/**
 * Settings for a run that may use the owner's skills and MCP tools (checked against agy
 * 1.5.4). `strict` refuses allowed MCP tools too, so this uses `request-review`: the allow
 * rules go through, and anything else that needs an approval is refused, since headless
 * mode cannot give one. Commands, writes and URLs stay denied. Reads cannot be, because
 * agy reads skills and the schemas of MCP tools as files and a deny rule beats any allow
 * rule: the watchdog limits reads to those, and the MCP config, which can hold
 * credentials, is denied by name.
 */
export function toolSessionSettings(tools: ToolSet, mcpConfigFile: string): SessionSettings {
  const deny = ['write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', `read_file(${mcpConfigFile})`];
  if (tools.mcp.length === 0) deny.push('mcp(*)');
  return { ...SESSION_SETTINGS, toolPermission: 'request-review', permissions: { allow: mcpGrants(tools.mcp), ask: [], deny } };
}

/** agy permission rules for the allowed tools: mcp(<server>/<tool>), or mcp(<server>/*). */
export function mcpGrants(servers: readonly McpServer[]): string[] {
  return servers.flatMap((server) =>
    server.tools.includes('*') ? [`mcp(${server.name}/*)`] : server.tools.map((tool) => `mcp(${server.name}/${tool})`),
  );
}

/** The `.agents/mcp_config.json` agy reads in its workspace. */
export function mcpConfig(servers: readonly McpServer[]): { mcpServers: Record<string, unknown> } {
  const entries = servers.map((server) => {
    if (server.transport === 'http') {
      const headers = Object.keys(server.headers).length > 0 ? { headers: server.headers } : {};
      return [server.name, { url: server.url, ...headers }];
    }
    const env = Object.keys(server.env).length > 0 ? { env: server.env } : {};
    return [server.name, { command: server.command, args: server.args, ...env }];
  });
  return { mcpServers: Object.fromEntries(entries) };
}

export class ToolUseError extends Error {
  constructor(
    readonly tool: string,
    message = `Antigravity used a tool (${tool}), so its answer was discarded`,
  ) {
    super(message);
    this.name = 'ToolUseError';
  }
}

/** Decides, for one tool step of the event stream, whether the run may go on. */
type Guard = (tool: string, step: Record<string, unknown>) => boolean;

const noToolGuard: Guard = (tool, step) =>
  TURN_TOOLS.has(tool) || (POLICY_DENIED_TOOLS.has(tool) && step.state !== 'DONE');

/**
 * Engine `antigravity`: Antigravity CLI (`agy`) in headless mode, signed in with a
 * personal Google account, so it runs on the Google AI subscription.
 *
 * The prompt goes through stdin (stream-json), which keeps message content out of the
 * process list, and the decision is enforced with --json-schema. Some tools, such as
 * web search, cannot be denied by any setting, so the event stream is watched: a tool
 * that could have an effect kills the run and its answer is discarded. That happens
 * once at most per decision: the second attempt tells the model why the first failed.
 *
 * Without tools, agy runs in an empty workspace with everything denied. With the owner's
 * skills and MCP servers, it runs in a second workspace that holds only those, and the
 * watchdog lets through just their MCP tools and reads of their files.
 */
export class AntigravityCli implements DecisionMaker {
  private readonly dir: string;
  private readonly home: string;
  private synced: string | undefined;
  private toolsRealpath = '';

  constructor(
    private readonly config: EngineConfig,
    stateDir: string,
    private readonly system: string,
    options: { home?: string } = {},
  ) {
    this.dir = join(stateDir, 'antigravity');
    this.home = options.home ?? homedir();
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

  /** The workspace of runs with tools: only the enabled skills and the MCP config. */
  get toolsWorkspace(): string {
    return join(this.dir, 'workspace-tools');
  }

  get toolSettingsFile(): string {
    return join(this.dir, 'tool-settings.json');
  }

  get mcpConfigFile(): string {
    return join(this.toolsWorkspace, '.agents', 'mcp_config.json');
  }

  get skillsDir(): string {
    return join(this.toolsWorkspace, '.agents', 'skills');
  }

  async prepare(): Promise<void> {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    // The next run with tools writes it again; until then, no stale MCP credentials stay on disk.
    await rm(join(this.toolsWorkspace, '.agents'), { recursive: true, force: true });
    this.synced = undefined;
    await mkdir(this.toolsWorkspace, { recursive: true, mode: 0o700 });
    await writeFile(this.settingsFile, `${JSON.stringify(SESSION_SETTINGS, null, 2)}\n`, { mode: 0o600 });
    await writeFile(this.schemaFile, `${JSON.stringify(DECISION_SCHEMA, null, 2)}\n`, { mode: 0o600 });
  }

  args(withTools = false): string[] {
    return [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--json-schema',
      this.schemaFile,
      '--settings',
      withTools ? this.toolSettingsFile : this.settingsFile,
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

  async decide(prompt: string, options: DecideOptions = {}): Promise<Decision> {
    const tools = hasTools(options.tools) ? options.tools : undefined;
    if (tools !== undefined) await this.syncTools(tools);
    try {
      return await this.attempt(prompt, 1, tools, options.onAttempt);
    } catch (error) {
      if (!(error instanceof ToolUseError)) throw error;
      const advice =
        tools === undefined
          ? 'Do not use any tool: answer directly with the JSON object.'
          : 'Use only the tools listed in <tools>, or none, then answer with the JSON object.';
      return this.attempt(
        `${prompt}\n\nYour previous answer was discarded because you used the tool ${error.tool}. ${advice}`,
        2,
        tools,
        options.onAttempt,
      );
    }
  }

  /**
   * Writes the tools workspace for this set: the MCP config with only these servers, a copy
   * of these skills, and the settings that allow their tools. Skipped when nothing changed.
   */
  async syncTools(tools: ToolSet): Promise<void> {
    const key = JSON.stringify([
      tools.mcp.map((server) => [server.name, server.updatedAt]),
      tools.skills.map((skill) => [skill.name, skill.updatedAt]),
    ]);
    if (key === this.synced) return;
    await mkdir(join(this.toolsWorkspace, '.agents'), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.mcpConfigFile, `${JSON.stringify(mcpConfig(tools.mcp), null, 2)}\n`);
    await rm(this.skillsDir, { recursive: true, force: true });
    await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
    for (const skill of tools.skills) {
      await cp(skill.dir, join(this.skillsDir, skill.name), { recursive: true, dereference: true });
    }
    const settings = toolSessionSettings(tools, this.mcpConfigFile);
    await writeFileAtomic(this.toolSettingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    this.toolsRealpath = await realpath(this.toolsWorkspace);
    this.synced = key;
  }

  private toolGuard(tools: ToolSet): Guard {
    const servers = new Map(tools.mcp.map((server) => [server.name, server.tools]));
    const readable = [
      this.skillsDir,
      join(this.toolsRealpath, '.agents', 'skills'),
      ...tools.mcp.map((server) => agyMcpDir(server.name, this.home)),
    ];
    return (tool, step) => {
      if (TURN_TOOLS.has(tool)) return true;
      const params = toolParams(step);
      if (tool === MCP_TOOL) {
        const allowed = servers.get(asString(params.ServerName));
        return allowed !== undefined && (allowed.includes('*') || allowed.includes(asString(params.ToolName)));
      }
      if (tool === 'read_file') {
        const path = asString(params.Path);
        return path !== '' && readable.some((root) => isInside(resolve(this.toolsWorkspace, path), root));
      }
      return noToolGuard(tool, step);
    };
  }

  private async attempt(
    prompt: string,
    number: number,
    tools: ToolSet | undefined,
    onAttempt: ((attempt: Attempt) => void) | undefined,
  ): Promise<Decision> {
    const startedAt = new Date();
    const guard = tools === undefined ? noToolGuard : this.toolGuard(tools);
    const used = new Set<string>();
    let violation: string | undefined;
    let result: unknown;
    let steps: Usage = NO_USAGE;
    let conversationId: string | undefined;
    let failure: unknown;
    try {
      let run;
      try {
        run = await runProcess(this.config.command, this.args(tools !== undefined), {
          input: this.input(prompt),
          // agy enforces --print-timeout itself; this is the backstop.
          timeoutMs: (this.config.timeoutSeconds + 15) * 1000,
          cwd: tools === undefined ? this.workspace : this.toolsWorkspace,
          onStdoutLine: (line, stop) => {
            const event = parseEvent(line);
            if (event === null) return;
            if (typeof event.conversation_id === 'string') conversationId ??= event.conversation_id;
            if (event.event === 'result') {
              result = event.result;
              return;
            }
            if (event.event !== 'step_update' || !isRecord(event.step_update)) return;
            const step = event.step_update;
            // A killed run has no result, so its tokens are summed from the model steps.
            if (step.state === 'DONE' && isRecord(step.usage)) steps = addUsage(steps, usageFromAgy(step.usage));
            const tool = step.tool_name;
            if (typeof tool !== 'string' || tool === '') return;
            const label = toolLabel(tool, step);
            if (step.state === 'ACTIVE' && !TURN_TOOLS.has(tool)) used.add(label);
            if (guard(tool, step)) return;
            violation ??= label;
            stop();
          },
        });
      } catch (error) {
        throw new Error(`Could not start ${this.config.command}: ${errorMessage(error)}`);
      }

      if (violation !== undefined) throw new ToolUseError(violation);
      if (run.timedOut) throw new Error(`Antigravity did not answer within ${this.config.timeoutSeconds}s`);
      const denied = deniedAction(result);
      if (denied !== undefined) {
        throw new ToolUseError(denied, `Antigravity stopped at a tool it may not use (${denied}), so its answer was discarded`);
      }
      return decisionFromResult(result, run.stderr, run.code);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const reported = isRecord(result) && isRecord(result.usage) ? usageFromAgy(result.usage) : undefined;
      onAttempt?.({
        attempt: number,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        status: failure === undefined ? 'ok' : failure instanceof ToolUseError ? 'tool' : 'failed',
        error: failure === undefined ? undefined : errorMessage(failure),
        usage: reported ?? steps,
        tools: [...used],
        conversationId,
        response: isRecord(result) && typeof result.response === 'string' ? result.response : undefined,
      });
    }
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

/** The `usage` object agy puts on each model step and on the result. */
export function usageFromAgy(value: Record<string, unknown>): Usage {
  const count = (key: string): number => {
    const field = value[key];
    return typeof field === 'number' ? field : 0;
  };
  return {
    inputTokens: count('input_tokens'),
    outputTokens: count('output_tokens'),
    thinkingTokens: count('thinking_tokens'),
    cachedTokens: count('cache_read_tokens'),
  };
}

/**
 * In headless mode, agy ends the turn when a tool needs an approval it cannot ask for,
 * with an empty answer and the tool under `denied_actions`.
 */
function deniedAction(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.denied_actions) || result.denied_actions.length === 0) return undefined;
  const first: unknown = result.denied_actions[0];
  return (isRecord(first) && (asString(first.action) || asString(first.display_name))) || 'a tool';
}

function toolParams(step: Record<string, unknown>): Record<string, unknown> {
  return isRecord(step.tool_info) && isRecord(step.tool_info.parameters) ? step.tool_info.parameters : {};
}

/** "notes/search" for an MCP tool, the agy tool name otherwise. */
function toolLabel(tool: string, step: Record<string, unknown>): string {
  if (tool !== MCP_TOOL) return tool;
  const params = toolParams(step);
  const server = asString(params.ServerName);
  return server === '' ? tool : `${server}/${asString(params.ToolName)}`;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
