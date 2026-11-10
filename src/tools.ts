import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { json, type Row, type Store, text } from './db.js';
import { isNotFound } from './util.js';

/**
 * `commands`: only for batches with a command the owner typed. `all`: for every batch,
 * including messages from other people.
 */
export type ToolScope = 'commands' | 'all';

export interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Tools the model may call; ["*"] allows every tool of the server. */
  tools: string[];
  scope: ToolScope;
  enabled: boolean;
  addedAt: string;
  updatedAt: string;
}

export interface Skill {
  name: string;
  description: string;
  /** Where the skill was added from. */
  source: string;
  scope: ToolScope;
  enabled: boolean;
  addedAt: string;
  updatedAt: string;
  /** The installed copy, which the engine copies into its workspace. */
  dir: string;
}

/** What one model call may use. */
export interface ToolSet {
  mcp: McpServer[];
  skills: Skill[];
}

export function hasTools(tools: ToolSet | undefined): tools is ToolSet {
  return tools !== undefined && (tools.mcp.length > 0 || tools.skills.length > 0);
}

/** Server and skill names end up in agy permission rules and folder names. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOOL_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPES: readonly ToolScope[] = ['commands', 'all'];

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function requireName(name: string, what: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(`${what} names are 1 to 64 letters, digits, "_" or "-", starting with a letter or digit (got ${JSON.stringify(name)})`);
  }
  return name;
}

export function parseScope(value: string): ToolScope {
  if (!SCOPES.includes(value as ToolScope)) throw new ToolError(`The scope is "commands" or "all", got ${JSON.stringify(value)}`);
  return value as ToolScope;
}

export function parseToolList(values: readonly string[]): string[] {
  const tools = [...new Set(values.flatMap((value) => value.split(',')).map((tool) => tool.trim()).filter((tool) => tool !== ''))];
  if (tools.length === 0) throw new ToolError('Name at least one tool, or "*" for all of them');
  if (tools.includes('*')) return ['*'];
  for (const tool of tools) {
    if (!TOOL_PATTERN.test(tool)) throw new ToolError(`Not a valid tool name: ${JSON.stringify(tool)}`);
  }
  return tools;
}

/** Where agy writes the schema of each tool of an MCP server it connected to. */
export function agyMcpDir(server: string, home: string = homedir()): string {
  return join(home, '.gemini', 'antigravity-cli', 'mcp', server);
}

/** Tool names agy has seen on a server, from the schemas it saved. Empty before its first connection. */
export async function seenTools(server: string, home?: string): Promise<string[]> {
  try {
    const files = await readdir(agyMcpDir(server, home));
    return files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

export interface McpInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  tools?: string[];
  scope?: ToolScope;
  enabled?: boolean;
}

/**
 * The skills and MCP servers the agent may use, kept in the database and managed with
 * `agentic-whatsapp skills` and `agentic-whatsapp mcp`. Changes apply to the next model call.
 */
export class ToolRegistry {
  constructor(
    private readonly store: Store,
    /** Installed copies of the skills, one folder each. */
    readonly skillsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The enabled skills and servers a batch may use, by scope. */
  forBatch(ownerCommand: boolean): ToolSet {
    const allowed = (scope: ToolScope) => scope === 'all' || ownerCommand;
    return {
      mcp: this.servers().filter((server) => server.enabled && server.tools.length > 0 && allowed(server.scope)),
      skills: this.skills().filter((skill) => skill.enabled && allowed(skill.scope)),
    };
  }

  servers(): McpServer[] {
    return this.store.all('SELECT * FROM mcp_servers ORDER BY name').map(serverFrom);
  }

  server(name: string): McpServer {
    const row = this.store.get('SELECT * FROM mcp_servers WHERE name = ?', name);
    if (row === undefined) throw new ToolError(`No MCP server named ${JSON.stringify(name)}. List them with: agentic-whatsapp mcp list`);
    return serverFrom(row);
  }

  /** Adds a server, or replaces the one with the same name. */
  saveServer(input: McpInput): McpServer {
    requireName(input.name, 'MCP server');
    if (input.transport === 'http') {
      if (!/^https?:\/\//.test(input.url ?? '')) throw new ToolError('An http server needs an http:// or https:// URL');
    } else if ((input.command ?? '') === '') {
      throw new ToolError('A stdio server needs a command');
    }
    const at = this.now().toISOString();
    this.store.run(
      `INSERT INTO mcp_servers (name, transport, command, args, url, env, headers, tools, scope, enabled, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET transport = excluded.transport, command = excluded.command, args = excluded.args,
         url = excluded.url, env = excluded.env, headers = excluded.headers, tools = excluded.tools, scope = excluded.scope,
         enabled = excluded.enabled, updated_at = excluded.updated_at`,
      input.name,
      input.transport,
      input.transport === 'stdio' ? input.command : '',
      JSON.stringify(input.transport === 'stdio' ? (input.args ?? []) : []),
      input.transport === 'http' ? input.url : '',
      JSON.stringify(input.transport === 'stdio' ? (input.env ?? {}) : {}),
      JSON.stringify(input.transport === 'http' ? (input.headers ?? {}) : {}),
      JSON.stringify(input.tools ?? ['*']),
      input.scope ?? 'commands',
      input.enabled ?? true,
      at,
      at,
    );
    return this.server(input.name);
  }

  setServer(name: string, change: { enabled?: boolean; tools?: string[]; scope?: ToolScope }): McpServer {
    const server = this.server(name);
    this.store.run(
      'UPDATE mcp_servers SET enabled = ?, tools = ?, scope = ?, updated_at = ? WHERE name = ?',
      change.enabled ?? server.enabled,
      JSON.stringify(change.tools ?? server.tools),
      change.scope ?? server.scope,
      this.now().toISOString(),
      name,
    );
    return this.server(name);
  }

  removeServer(name: string): void {
    this.server(name);
    this.store.run('DELETE FROM mcp_servers WHERE name = ?', name);
  }

  skills(): Skill[] {
    return this.store.all('SELECT * FROM skills ORDER BY name').map((row) => skillFrom(row, this.skillsDir));
  }

  skill(name: string): Skill {
    const row = this.store.get('SELECT * FROM skills WHERE name = ?', name);
    if (row === undefined) throw new ToolError(`No skill named ${JSON.stringify(name)}. List them with: agentic-whatsapp skills list`);
    return skillFrom(row, this.skillsDir);
  }

  /**
   * Installs a skill from its folder (or its SKILL.md), copying it so later changes to the
   * original need another `skills add`. Adding a skill with the same name replaces it.
   */
  async addSkill(path: string, options: { scope?: ToolScope; enabled?: boolean } = {}): Promise<Skill> {
    let source = resolve(path);
    const info = await stat(source).catch((error: unknown) => {
      throw new ToolError(isNotFound(error) ? `${path} does not exist` : String(error));
    });
    if (info.isFile()) {
      if (basename(source) !== 'SKILL.md') throw new ToolError('Point to a skill folder, or to its SKILL.md');
      source = dirname(source);
    }
    let content: string;
    try {
      content = await readFile(join(source, 'SKILL.md'), 'utf8');
    } catch {
      throw new ToolError(`${source} has no SKILL.md`);
    }
    const meta = frontmatter(content);
    const name = requireName(meta.name ?? basename(source), 'Skill');
    const description = (meta.description ?? '').trim();
    if (description === '') throw new ToolError(`${join(source, 'SKILL.md')} needs a description in its frontmatter`);

    const dir = join(this.skillsDir, name);
    await rm(dir, { recursive: true, force: true });
    await cp(source, dir, { recursive: true, dereference: true, filter: (file) => !file.split('/').includes('.git') });

    const at = this.now().toISOString();
    this.store.run(
      `INSERT INTO skills (name, description, source, scope, enabled, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, source = excluded.source, scope = excluded.scope,
         enabled = excluded.enabled, updated_at = excluded.updated_at`,
      name,
      description,
      source,
      options.scope ?? 'commands',
      options.enabled ?? true,
      at,
      at,
    );
    return this.skill(name);
  }

  setSkill(name: string, change: { enabled?: boolean; scope?: ToolScope }): Skill {
    const skill = this.skill(name);
    this.store.run(
      'UPDATE skills SET enabled = ?, scope = ?, updated_at = ? WHERE name = ?',
      change.enabled ?? skill.enabled,
      change.scope ?? skill.scope,
      this.now().toISOString(),
      name,
    );
    return this.skill(name);
  }

  async removeSkill(name: string): Promise<void> {
    const skill = this.skill(name);
    this.store.run('DELETE FROM skills WHERE name = ?', name);
    await rm(skill.dir, { recursive: true, force: true });
  }
}

/** The `key: value` lines of a SKILL.md frontmatter, enough for name and description. */
export function frontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) return {};
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field === null) continue;
    fields[field[1] ?? ''] = (field[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

function serverFrom(row: Row): McpServer {
  return {
    name: text(row.name),
    transport: text(row.transport) === 'http' ? 'http' : 'stdio',
    command: text(row.command),
    args: json<string[]>(row.args, []),
    url: text(row.url),
    env: json<Record<string, string>>(row.env, {}),
    headers: json<Record<string, string>>(row.headers, {}),
    tools: json<string[]>(row.tools, []),
    scope: text(row.scope) === 'all' ? 'all' : 'commands',
    enabled: row.enabled === 1,
    addedAt: text(row.added_at),
    updatedAt: text(row.updated_at),
  };
}

function skillFrom(row: Row, skillsDir: string): Skill {
  const name = text(row.name);
  return {
    name,
    description: text(row.description),
    source: text(row.source),
    scope: text(row.scope) === 'all' ? 'all' : 'commands',
    enabled: row.enabled === 1,
    addedAt: text(row.added_at),
    updatedAt: text(row.updated_at),
    dir: join(skillsDir, name),
  };
}
