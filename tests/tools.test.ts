import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { mcpCommand, parseMcpAdd, skillsCommand, splitConfigOption } from '../src/manage.js';
import { frontmatter, parseToolList, ToolError, ToolRegistry } from '../src/tools.js';
import { makeConfig, tempDir } from './helpers.js';

/** A skill folder with a SKILL.md and one extra file. */
async function skillFolder(dir: string, name = 'agenda', description = 'Use for questions about the agenda.'): Promise<string> {
  const folder = join(dir, 'source', name);
  await mkdir(join(folder, 'references'), { recursive: true });
  await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n\nCheck the agenda first.\n`);
  await writeFile(join(folder, 'references', 'notes.md'), 'notes');
  return folder;
}

const registry = async () => {
  const dir = await tempDir();
  return { dir, tools: new ToolRegistry(Store.open(null), join(dir, 'skills'), () => new Date('2026-11-10T15:00:00Z')) };
};

describe('ToolRegistry', () => {
  it('adds, changes and removes MCP servers', async () => {
    const { tools } = await registry();
    tools.saveServer({ name: 'notes', transport: 'stdio', command: '/bin/notes', args: ['--db', 'x'], env: { TOKEN: 's' } });
    expect(tools.server('notes')).toMatchObject({ command: '/bin/notes', args: ['--db', 'x'], tools: ['*'], scope: 'commands', enabled: true });
    tools.setServer('notes', { tools: ['search'], scope: 'all', enabled: false });
    expect(tools.server('notes')).toMatchObject({ tools: ['search'], scope: 'all', enabled: false });
    tools.removeServer('notes');
    expect(tools.servers()).toEqual([]);
    expect(() => tools.server('notes')).toThrow(ToolError);
  });

  it('validates servers', async () => {
    const { tools } = await registry();
    expect(() => tools.saveServer({ name: 'bad name', transport: 'stdio', command: 'x' })).toThrow(/names are/);
    expect(() => tools.saveServer({ name: 'web', transport: 'http', url: 'ftp://x' })).toThrow(/http:\/\//);
    expect(() => tools.saveServer({ name: 'local', transport: 'stdio', command: '' })).toThrow(/needs a command/);
  });

  it('installs a copy of a skill from its folder or its SKILL.md', async () => {
    const { dir, tools } = await registry();
    const folder = await skillFolder(dir);
    const skill = await tools.addSkill(folder);
    expect(skill).toMatchObject({ name: 'agenda', description: 'Use for questions about the agenda.', enabled: true, scope: 'commands' });
    expect(await readFile(join(skill.dir, 'references', 'notes.md'), 'utf8')).toBe('notes');

    await writeFile(join(folder, 'SKILL.md'), '---\nname: agenda\ndescription: Updated.\n---\n');
    expect((await tools.addSkill(join(folder, 'SKILL.md'), { scope: 'all' })).description).toBe('Updated.');
    expect(tools.skills()).toHaveLength(1);

    await tools.removeSkill('agenda');
    expect(existsSync(skill.dir)).toBe(false);
    expect(tools.skills()).toEqual([]);
  });

  it('copies the files a skill links to, not the links', async () => {
    const { dir, tools } = await registry();
    const folder = await skillFolder(dir);
    await writeFile(join(dir, 'outside.md'), 'outside');
    await symlink(join(dir, 'outside.md'), join(folder, 'linked.md'));
    const skill = await tools.addSkill(folder);
    expect(await readFile(join(skill.dir, 'linked.md'), 'utf8')).toBe('outside');
  });

  it('refuses a skill without SKILL.md or description', async () => {
    const { dir, tools } = await registry();
    await mkdir(join(dir, 'empty'));
    await expect(tools.addSkill(join(dir, 'empty'))).rejects.toThrow(/no SKILL.md/);
    await expect(tools.addSkill(join(dir, 'missing'))).rejects.toThrow(/does not exist/);
    await writeFile(join(dir, 'empty', 'SKILL.md'), '---\nname: empty\n---\n');
    await expect(tools.addSkill(join(dir, 'empty'))).rejects.toThrow(/needs a description/);
  });

  it('gives a batch only what its scope allows', async () => {
    const { dir, tools } = await registry();
    tools.saveServer({ name: 'notes', transport: 'stdio', command: '/bin/notes' });
    tools.saveServer({ name: 'weather', transport: 'http', url: 'https://example.com/mcp', scope: 'all' });
    tools.saveServer({ name: 'off', transport: 'stdio', command: '/bin/off', enabled: false });
    await tools.addSkill(await skillFolder(dir), { scope: 'all' });

    const command = tools.forBatch(true);
    expect(command.mcp.map((server) => server.name)).toEqual(['notes', 'weather']);
    expect(command.skills.map((skill) => skill.name)).toEqual(['agenda']);
    const message = tools.forBatch(false);
    expect(message.mcp.map((server) => server.name)).toEqual(['weather']);
  });
});

describe('parsing', () => {
  it('reads tool lists', () => {
    expect(parseToolList(['search,get', 'search'])).toEqual(['search', 'get']);
    expect(parseToolList(['search', '*'])).toEqual(['*']);
    expect(() => parseToolList([])).toThrow(/at least one/);
    expect(() => parseToolList(['rm -rf'])).toThrow(/Not a valid tool/);
  });

  it('reads a SKILL.md frontmatter', () => {
    expect(frontmatter('---\nname: x\ndescription: \'Does y\'\nmetadata:\n  a: b\n---\nbody')).toEqual({
      name: 'x',
      description: 'Does y',
      metadata: '',
    });
    expect(frontmatter('no frontmatter')).toEqual({});
  });

  it('parses mcp add like agy mcp add', () => {
    expect(parseMcpAdd(['-e', 'TOKEN=a=b', '--tools', 'search,get', 'notes', 'npx', '-y', 'notes-mcp', '--db', 'x'])).toMatchObject({
      name: 'notes',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'notes-mcp', '--db', 'x'],
      env: { TOKEN: 'a=b' },
      tools: ['search', 'get'],
      scope: 'commands',
      enabled: true,
    });
    expect(parseMcpAdd(['--header', 'Authorization: Bearer t', '--scope=all', '--disabled', 'api', 'https://example.com/mcp'])).toMatchObject({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      scope: 'all',
      enabled: false,
    });
    expect(parseMcpAdd(['--', 'odd', 'cmd']).command).toBe('cmd');
    expect(() => parseMcpAdd(['notes'])).toThrow(/Name the server/);
    expect(() => parseMcpAdd(['--env', 'nope', 'notes', 'cmd'])).toThrow(/KEY=value/);
    expect(() => parseMcpAdd(['--bogus', 'notes', 'cmd'])).toThrow(/Unknown option/);
    expect(() => parseMcpAdd(['--header', 'A: b', 'notes', 'cmd'])).toThrow(/only for http/);
    expect(() => parseMcpAdd(['api', 'https://example.com/mcp', 'extra'])).toThrow(/no arguments/);
  });

  it('takes --config out of mcp and skills arguments, but not out of a server command', () => {
    expect(splitConfigOption('mcp', ['list', '--config', '/c.toml'])).toEqual({ config: '/c.toml', args: ['list'] });
    expect(splitConfigOption('mcp', ['add', '--config=/c.toml', '--env', 'A=1', 'srv', 'cmd', '--config', 'own'])).toEqual({
      config: '/c.toml',
      args: ['add', '--env=A=1', '--', 'srv', 'cmd', '--config', 'own'],
    });
    expect(splitConfigOption('skills', ['add', '--disabled', '/skill'])).toEqual({
      config: undefined,
      args: ['add', '--disabled', '--', '/skill'],
    });
  });
});

describe('mcp and skills commands', () => {
  it('add, list, show and change servers without printing secrets', async () => {
    const dir = await tempDir();
    const config = makeConfig({}, dir);
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'notes-mcp'), '#!/bin/sh\n', { mode: 0o755 });

    const added = await mcpCommand(config, ['add', '--env', 'TOKEN=supersecret', 'notes', 'notes-mcp', '--db', 'x'], { PATH: bin });
    expect(added.join('\n')).toContain(`command    ${join(bin, 'notes-mcp')} --db x`);
    expect(added.join('\n')).toContain('env        TOKEN=••••');
    expect(added.join('\n')).not.toContain('supersecret');

    expect((await mcpCommand(config, ['tools', 'notes', 'search']))[0]).toBe('notes may use search');
    expect((await mcpCommand(config, ['disable', 'notes']))[0]).toBe('notes disabled');
    const list = await mcpCommand(config, ['list']);
    expect(list[0]).toMatch(/^✘ +notes +stdio .*tools: search +scope: commands$/);
    expect((await mcpCommand(config, ['show', 'notes'])).join('\n')).not.toContain('supersecret');
    await mcpCommand(config, ['remove', 'notes']);
    expect((await mcpCommand(config, []))[0]).toMatch(/^No MCP servers/);
    await expect(mcpCommand(config, ['show', 'notes'])).rejects.toThrow(/No MCP server named "notes"/);
    await expect(mcpCommand(config, ['frobnicate'])).rejects.toThrow(/Unknown mcp command/);
  });

  it('warns when the engine cannot use them', async () => {
    const dir = await tempDir();
    const config = makeConfig({ engine: { kind: 'gemini-cli' } }, dir);
    expect((await mcpCommand(config, ['list'])).at(-1)).toMatch(/only work with engine.kind = "antigravity"/);
  });

  it('add, list, scope and remove skills', async () => {
    const dir = await tempDir();
    const config = makeConfig({}, dir);
    const folder = await skillFolder(dir);
    expect((await skillsCommand(config, ['add', '--scope', 'all', folder]))[0]).toBe(`installed skill agenda from ${folder}`);
    expect((await skillsCommand(config, ['list']))[0]).toMatch(/^✔ +agenda +scope: all +Use for questions about the agenda\.$/);
    expect((await skillsCommand(config, ['scope', 'agenda', 'commands']))[0]).toMatch(/scope commands/);
    await expect(skillsCommand(config, ['scope', 'agenda', 'sometimes'])).rejects.toThrow(/"commands" or "all"/);
    await skillsCommand(config, ['remove', 'agenda']);
    expect((await skillsCommand(config, ['list']))[0]).toMatch(/^No skills/);
  });
});
