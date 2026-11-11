import { spawnSync } from 'node:child_process';
import { AntigravityCli } from './antigravity.js';
import type { Config } from './config.js';
import { Store } from './db.js';
import { table } from './report.js';
import { resolveExecutable } from './service.js';
import {
  type McpInput,
  type McpServer,
  parseScope,
  parseToolList,
  seenTools,
  type Skill,
  ToolError,
  ToolRegistry,
  type ToolScope,
} from './tools.js';

const APPLIES = 'Applies from the next message, no restart needed.';

const SCOPE_NOTE: Record<ToolScope, string> = {
  commands: 'commands (only when you ask the agent something)',
  all: 'all (every message, including messages from other people)',
};

export const MCP_USAGE = `Usage: agentic-whatsapp mcp <command>

  list                              List the MCP servers
  add [flags] <name> <commandOrUrl> [args...]
                                    Add or replace a server. Flags come before <name>:
                                      --env KEY=value    environment variable (repeatable)
                                      --header "K: v"    HTTP header (repeatable)
                                      --oauth-client-id ID --oauth-client-secret S
                                                         an http server that signs in with OAuth
                                      --type stdio|http  usually detected from <commandOrUrl>
                                      --tools a,b        tools the agent may call (default: all)
                                      --scope commands|all  when it may use them (default: commands)
                                      --disabled         add it turned off
  login <name>                      Sign in to a server that uses OAuth, once, in agy (/mcp)
  show <name>                       Show a server and the tools Antigravity found on it
  tools <name> <tool...|*>          Set the tools the agent may call
  scope <name> commands|all         Set when the agent may use the server
  enable <name> / disable <name>    Turn a server on or off
  remove <name>                     Delete a server
`;

export const SKILLS_USAGE = `Usage: agentic-whatsapp skills <command>

  list                              List the skills
  add [--scope commands|all] [--disabled] <folder or SKILL.md>
                                    Install a copy of a skill, or replace the one with its name
  show <name>                       Show a skill and its instructions
  scope <name> commands|all         Set when the agent may use the skill
  enable <name> / disable <name>    Turn a skill on or off
  remove <name>                     Delete a skill
`;

const MCP_ADD_FLAGS = {
  withValue: new Set(['--env', '-e', '--header', '-H', '--type', '-t', '--tools', '--scope', '--oauth-client-id', '--oauth-client-secret']),
  booleans: new Set(['--disabled']),
};
const SKILLS_ADD_FLAGS = { withValue: new Set(['--scope']), booleans: new Set(['--disabled']) };

/**
 * Takes `--config <file>` out of the arguments of `mcp` and `skills`. In `add`, only the
 * flags before the name count: what follows is the server's own command line.
 */
export function splitConfigOption(command: 'mcp' | 'skills', args: readonly string[]): { config?: string; args: string[] } {
  const [sub = '', ...rest] = args;
  if (sub === 'add') {
    const known = command === 'mcp' ? MCP_ADD_FLAGS : SKILLS_ADD_FLAGS;
    const { flags, positional } = splitFlags(rest, new Set([...known.withValue, '--config']), known.booleans);
    const kept = Object.entries(flags)
      .filter(([name]) => name !== '--config')
      .flatMap(([name, values]) => values.map((value) => (known.booleans.has(name) ? name : `${name}=${value}`)));
    return { config: flags['--config']?.at(-1), args: [sub, ...kept, '--', ...positional] };
  }
  let config: string | undefined;
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--config') config = args[++index];
    else if (arg.startsWith('--config=')) config = arg.slice('--config='.length);
    else kept.push(arg);
  }
  return { config, args: kept };
}

function openRegistry(config: Config): { store: Store; registry: ToolRegistry } {
  const store = Store.open(config.paths.database);
  return { store, registry: new ToolRegistry(store, config.paths.skillsDir) };
}

function engineNote(config: Config): string[] {
  return config.engine.kind === 'antigravity'
    ? []
    : ['! engine.kind is "gemini-cli": skills and MCP servers only work with engine.kind = "antigravity".'];
}

/** How `mcp login` talks to the person and starts agy; replaced in tests. */
export interface LoginIo {
  write: (line: string) => void;
  /** Runs agy in `cwd` on this terminal and returns its exit code. */
  interactive: (command: string, cwd: string) => number | null;
}

const terminalIo: LoginIo = {
  write: (line) => process.stdout.write(`${line}\n`),
  interactive: (command, cwd) => spawnSync(command, [], { cwd, stdio: 'inherit' }).status,
};

/** `agentic-whatsapp mcp ...`: returns the lines to print. */
export async function mcpCommand(
  config: Config,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: LoginIo = terminalIo,
): Promise<string[]> {
  const [command = 'list', ...rest] = args;
  if (command === 'help' || command === '--help') return [MCP_USAGE];
  const { store, registry } = openRegistry(config);
  try {
    switch (command) {
      case 'list':
        return [...listServers(registry.servers()), ...engineNote(config)];
      case 'add': {
        const input = parseMcpAdd(rest);
        const notes: string[] = [];
        if (input.transport === 'stdio') {
          // The service runs with a short PATH in another folder, so the command is stored by its full path.
          const found = resolveExecutable(input.command ?? '', env.PATH);
          if (found === null) notes.push(`! ${input.command ?? ''} was not found; use its full path if the service cannot start it.`);
          else input.command = found;
        }
        const server = registry.saveServer(input);
        return [
          `saved MCP server ${server.name}`,
          ...describeServer(server, []),
          ...notes,
          server.tools.includes('*') ? `Narrow its tools with: agentic-whatsapp mcp tools ${server.name} <tool...>` : '',
          APPLIES,
          ...engineNote(config),
        ].filter((line) => line !== '');
      }
      case 'show': {
        const server = registry.server(requireArg(rest, 'name'));
        return describeServer(server, await seenTools(server.name));
      }
      case 'login': {
        const server = registry.server(requireArg(rest, 'name'));
        if (server.transport !== 'http') throw new ToolError(`${server.name} is a stdio server: only http servers sign in`);
        if (config.engine.kind !== 'antigravity') throw new ToolError('Signing in to MCP servers needs engine.kind = "antigravity"');
        const engine = new AntigravityCli(config.engine, config.paths.stateDir, '');
        const cwd = await engine.prepareLogin(server);
        io.write(`Starting agy in ${cwd}, the folder where the agent uses ${server.name}.`);
        io.write(`In agy: type /mcp, choose ${server.name}, then Authenticate. Sign in with the browser, paste the`);
        io.write('code back into agy, and quit agy once the server shows "Authed".');
        const code = io.interactive(config.engine.command, cwd);
        return [
          `agy exited${code === 0 || code === null ? '' : ` with code ${code}`}.`,
          `If ${server.name} showed "Authed", the agent can use it from the next message.`,
          `Check with a command in the home chat, then: agentic-whatsapp mcp show ${server.name}`,
        ];
      }
      case 'tools': {
        const [name = '', ...tools] = rest;
        const server = registry.setServer(requireArg([name], 'name'), { tools: parseToolList(tools) });
        return [`${server.name} may use ${toolList(server)}`, APPLIES];
      }
      case 'scope': {
        const [name = '', scope = ''] = rest;
        const server = registry.setServer(requireArg([name], 'name'), { scope: parseScope(scope) });
        return [`${server.name}: scope ${SCOPE_NOTE[server.scope]}`, APPLIES];
      }
      case 'enable':
      case 'disable': {
        const server = registry.setServer(requireArg(rest, 'name'), { enabled: command === 'enable' });
        return [`${server.name} ${server.enabled ? 'enabled' : 'disabled'}`, APPLIES, ...engineNote(config)];
      }
      case 'remove': {
        const name = requireArg(rest, 'name');
        registry.removeServer(name);
        return [`removed ${name}`, APPLIES];
      }
      default:
        throw new ToolError(`Unknown mcp command: ${command}\n\n${MCP_USAGE}`);
    }
  } finally {
    store.close();
  }
}

/** `agentic-whatsapp skills ...`: returns the lines to print. */
export async function skillsCommand(config: Config, args: readonly string[]): Promise<string[]> {
  const [command = 'list', ...rest] = args;
  if (command === 'help' || command === '--help') return [SKILLS_USAGE];
  const { store, registry } = openRegistry(config);
  try {
    switch (command) {
      case 'list':
        return [...listSkills(registry.skills()), ...engineNote(config)];
      case 'add': {
        const { flags, positional } = splitFlags(rest, SKILLS_ADD_FLAGS.withValue, SKILLS_ADD_FLAGS.booleans);
        const skill = await registry.addSkill(requireArg(positional, 'folder'), {
          scope: flags['--scope'] === undefined ? undefined : parseScope(flags['--scope'][0] ?? ''),
          enabled: flags['--disabled'] === undefined,
        });
        return [`installed skill ${skill.name} from ${skill.source}`, ...describeSkill(skill), APPLIES, ...engineNote(config)];
      }
      case 'show': {
        const skill = registry.skill(requireArg(rest, 'name'));
        return describeSkill(skill);
      }
      case 'scope': {
        const [name = '', scope = ''] = rest;
        const skill = registry.setSkill(requireArg([name], 'name'), { scope: parseScope(scope) });
        return [`${skill.name}: scope ${SCOPE_NOTE[skill.scope]}`, APPLIES];
      }
      case 'enable':
      case 'disable': {
        const skill = registry.setSkill(requireArg(rest, 'name'), { enabled: command === 'enable' });
        return [`${skill.name} ${skill.enabled ? 'enabled' : 'disabled'}`, APPLIES, ...engineNote(config)];
      }
      case 'remove': {
        const name = requireArg(rest, 'name');
        await registry.removeSkill(name);
        return [`removed ${name}`, APPLIES];
      }
      default:
        throw new ToolError(`Unknown skills command: ${command}\n\n${SKILLS_USAGE}`);
    }
  } finally {
    store.close();
  }
}

/**
 * Parses `mcp add`, like `agy mcp add`: flags first, then <name> <commandOrUrl> [args...].
 * Everything after <name> belongs to the server, so its own flags need no escaping.
 */
export function parseMcpAdd(args: readonly string[]): McpInput {
  const { flags, positional } = splitFlags(args, MCP_ADD_FLAGS.withValue, MCP_ADD_FLAGS.booleans);
  const [name = '', target = '', ...serverArgs] = positional;
  if (name === '' || target === '') throw new ToolError(`Name the server and its command or URL.\n\n${MCP_USAGE}`);
  const values = (...keys: string[]) => keys.flatMap((key) => flags[key] ?? []);

  const type = values('--type', '-t').at(-1) ?? (/^https?:\/\//.test(target) ? 'http' : 'stdio');
  if (type !== 'stdio' && type !== 'http') throw new ToolError(`--type is "stdio" or "http", got ${JSON.stringify(type)}`);
  if (type === 'http' && serverArgs.length > 0) throw new ToolError('An http server takes no arguments after its URL');

  const env: Record<string, string> = {};
  for (const pair of values('--env', '-e')) {
    const at = pair.indexOf('=');
    const key = at === -1 ? '' : pair.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ToolError(`--env takes KEY=value, got ${JSON.stringify(pair)}`);
    env[key] = pair.slice(at + 1);
  }
  const headers: Record<string, string> = {};
  for (const pair of values('--header', '-H')) {
    const at = pair.indexOf(':');
    const key = at === -1 ? '' : pair.slice(0, at).trim();
    if (key === '') throw new ToolError(`--header takes "Key: value", got ${JSON.stringify(pair)}`);
    headers[key] = pair.slice(at + 1).trim();
  }
  if (type === 'stdio' && Object.keys(headers).length > 0) throw new ToolError('--header is only for http servers');
  if (type === 'http' && Object.keys(env).length > 0) throw new ToolError('--env is only for stdio servers');

  const clientId = values('--oauth-client-id').at(-1);
  const clientSecret = values('--oauth-client-secret').at(-1);
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new ToolError('Give both --oauth-client-id and --oauth-client-secret');
  }
  if (type === 'stdio' && clientId !== undefined) throw new ToolError('OAuth is only for http servers');

  const tools = values('--tools');
  const scope = values('--scope').at(-1);
  return {
    name,
    transport: type,
    command: type === 'stdio' ? target : undefined,
    args: serverArgs,
    url: type === 'http' ? target : undefined,
    env,
    headers,
    tools: tools.length === 0 ? ['*'] : parseToolList(tools),
    scope: scope === undefined ? 'commands' : parseScope(scope),
    enabled: flags['--disabled'] === undefined,
    ...(clientId === undefined || clientSecret === undefined ? {} : { oauth: { clientId, clientSecret } }),
  };
}

/**
 * Splits leading flags from the positional arguments. Flags stop at the first positional
 * argument or at "--". `--flag value` and `--flag=value` both work.
 */
export function splitFlags(
  args: readonly string[],
  withValue: ReadonlySet<string>,
  booleans: ReadonlySet<string>,
): { flags: Record<string, string[]>; positional: string[] } {
  const flags: Record<string, string[]> = {};
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (booleans.has(name) && equals === -1) {
      flags[name] = [...(flags[name] ?? []), 'true'];
    } else if (withValue.has(name)) {
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined) throw new ToolError(`${name} needs a value`);
      flags[name] = [...(flags[name] ?? []), value];
    } else {
      throw new ToolError(`Unknown option: ${arg}`);
    }
  }
  return { flags, positional: args.slice(index) };
}

function requireArg(args: readonly string[], what: string): string {
  const value = args[0] ?? '';
  if (value === '') throw new ToolError(`Missing <${what}>`);
  return value;
}

function toolList(server: McpServer): string {
  return server.tools.includes('*') ? 'all its tools' : server.tools.join(', ');
}

function listServers(servers: readonly McpServer[]): string[] {
  if (servers.length === 0) return ['No MCP servers. Add one with: agentic-whatsapp mcp add <name> <command or URL> [args...]'];
  return table(
    servers.map((server) => [
      server.enabled ? '✔' : '✘',
      server.name,
      server.transport,
      truncate(server.transport === 'http' ? server.url : [server.command, ...server.args].join(' '), 48),
      `tools: ${server.tools.includes('*') ? '*' : server.tools.join(',')}`,
      `scope: ${server.scope}`,
    ]),
    [],
  );
}

function listSkills(skills: readonly Skill[]): string[] {
  if (skills.length === 0) return ['No skills. Add one with: agentic-whatsapp skills add <folder>'];
  return table(
    skills.map((skill) => [skill.enabled ? '✔' : '✘', skill.name, `scope: ${skill.scope}`, truncate(skill.description, 70)]),
    [],
  );
}

/** Secret values never reach the terminal: only their names. */
function masked(values: Record<string, string>): string {
  const keys = Object.keys(values);
  return keys.length === 0 ? '-' : keys.map((key) => `${key}=••••`).join(', ');
}

function describeServer(server: McpServer, seen: readonly string[]): string[] {
  const lines = [
    `  status     ${server.enabled ? 'enabled' : 'disabled'}`,
    `  transport  ${server.transport}`,
    server.transport === 'http' ? `  url        ${server.url}` : `  command    ${[server.command, ...server.args].join(' ')}`,
    server.transport === 'http' ? `  headers    ${masked(server.headers)}` : `  env        ${masked(server.env)}`,
    ...(server.oauth === undefined ? [] : [`  oauth      client ${server.oauth.clientId}, secret ••••; sign in with: agentic-whatsapp mcp login ${server.name}`]),
    `  tools      ${toolList(server)}`,
    `  scope      ${SCOPE_NOTE[server.scope]}`,
  ];
  if (seen.length > 0) lines.push(`  found      ${seen.join(', ')} (on Antigravity's last connection)`);
  return lines;
}

function describeSkill(skill: Skill): string[] {
  return [
    `  status       ${skill.enabled ? 'enabled' : 'disabled'}`,
    `  description  ${skill.description}`,
    `  scope        ${SCOPE_NOTE[skill.scope]}`,
    `  installed    ${skill.dir}`,
    `  source       ${skill.source}`,
  ];
}

function truncate(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join('')}…`;
}
