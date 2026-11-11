import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  type ChatDirectory,
  SETTINGS_TOOLS,
  serveMcp,
  settingsServer,
  settingsTools,
  type ToolDefinition,
  ToolCallError,
} from '../src/settings-mcp.js';
import { ConfigFile } from '../src/settings.js';
import { configTemplate } from '../src/templates.js';
import type { ChatInfo } from '../src/wacli.js';
import { BOB, FAMILY, HOME, makeConfig, OTHER_GROUP, tempDir } from './helpers.js';

const echo: ToolDefinition = {
  name: 'echo',
  description: 'Says it back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async call(args) {
    if (args.text === 'fail') throw new ToolCallError('asked to fail');
    return `echo: ${String(args.text)}`;
  },
};

async function exchange(lines: string[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output: string[] = [];
  const serving = serveMcp({ name: 'test', version: '1.0.0' }, [echo], { input, write: (line) => output.push(line) });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await serving;
  return output.join('').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

const request = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

describe('serveMcp', () => {
  it('answers initialize, ping and tools/list, and ignores notifications', async () => {
    const answers = await exchange([
      request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agy' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      request(2, 'ping'),
      request(3, 'tools/list'),
    ]);
    expect(answers).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1.0.0' } },
      },
      { jsonrpc: '2.0', id: 2, result: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        result: { tools: [{ name: 'echo', description: 'Says it back', inputSchema: echo.inputSchema }] },
      },
    ]);
  });

  it('runs tools, and reports their failures as tool errors the model can read', async () => {
    const answers = await exchange([
      request(1, 'tools/call', { name: 'echo', arguments: { text: 'oi' } }),
      request(2, 'tools/call', { name: 'echo', arguments: { text: 'fail' } }),
      request(3, 'tools/call', { name: 'nope', arguments: {} }),
      request(4, 'resources/list'),
      '{not json',
    ]);
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'echo: oi' }] } },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'asked to fail' }], isError: true } },
      { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unknown tool: nope' } },
      { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: resources/list' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
  });
});

class FakeChats implements ChatDirectory {
  readonly queries: string[] = [];

  constructor(readonly chats: ChatInfo[]) {}

  async listChats(query: string): Promise<ChatInfo[]> {
    this.queries.push(query);
    return this.chats.filter((chat) => chat.name.toLowerCase().includes(query.toLowerCase()));
  }

  async chat(jid: string): Promise<ChatInfo | null> {
    return this.chats.find((chat) => chat.jid === jid) ?? null;
  }
}

const CHATS: ChatInfo[] = [
  { jid: FAMILY, kind: 'group', name: 'Família' },
  { jid: OTHER_GROUP, kind: 'group', name: 'Família estendida' },
  { jid: BOB, kind: 'direct', name: 'Bob' },
  { jid: 'status@broadcast', kind: 'other', name: 'Família status' },
];

async function setup(options: { dryRun?: boolean } = {}) {
  const dir = await tempDir();
  const file = join(dir, 'config.toml');
  const template = configTemplate({ name: 'Ane', language: 'pt-BR', timezone: 'America/Sao_Paulo', homeChat: HOME });
  await writeFile(file, template);
  const config = new ConfigFile({ configFile: file, stateDir: join(dir, 'state') }, join(dir, 'history'));
  const costDays: number[] = [];
  const costs = async (days: number) => {
    costDays.push(days);
    return { currency: 'USD', periods: { day: { key: '2026-11-10', calls: 3, cost: 0.054292500000000004 } } };
  };
  const tools = new Map(
    settingsTools({ config, chats: new FakeChats(CHATS), costs, dryRun: options.dryRun ?? false }).map((tool) => [tool.name, tool]),
  );
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.call(args);
  };
  return { file, template, config, call, costDays, names: [...tools.keys()] };
}

describe('settingsTools', () => {
  it('offers the tools the settings server allows', async () => {
    expect((await setup()).names).toEqual([...SETTINGS_TOOLS]);
  });

  it('finds chats by name, with whether they are monitored', async () => {
    const { call } = await setup();
    expect(JSON.parse(await call('find_chats', { query: 'família' }))).toEqual([
      { id: FAMILY, name: 'Família', type: 'group', monitored: false, auto_reply: false },
      { id: OTHER_GROUP, name: 'Família estendida', type: 'group', monitored: false, auto_reply: false },
    ]);
    expect(JSON.parse(await call('find_chats', { query: 'bob', type: 'group' }))).toEqual([]);
    expect(JSON.parse(await call('find_chats', { query: 'bob' }))).toEqual([
      { id: BOB, name: 'Bob', type: 'direct', monitored: true, auto_reply: false },
    ]);
    await expect(call('find_chats', { query: ' ' })).rejects.toThrow(ToolCallError);
  });

  it('starts and stops monitoring a group, in the config file', async () => {
    const { call, config } = await setup();
    expect(await call('monitor_group', { group_id: FAMILY })).toBe(`Done: monitor "Família" (${FAMILY}). It applies from the next message.`);
    expect(await call('monitor_group', { group_id: FAMILY })).toBe(`Already monitoring "Família" (${FAMILY}).`);
    await call('monitor_group', { group_id: OTHER_GROUP });
    expect((await config.read()).routing.groupAllowlist).toEqual([FAMILY, OTHER_GROUP]);
    expect(JSON.parse(await call('get_settings'))).toEqual({
      direct_messages: true,
      monitored_groups: [
        { id: FAMILY, name: 'Família' },
        { id: OTHER_GROUP, name: 'Família estendida' },
      ],
      auto_reply_chats: [],
    });

    expect(await call('stop_monitoring_group', { group_id: FAMILY })).toBe(
      `Done: stop monitoring "Família" (${FAMILY}). It applies from the next message.`,
    );
    expect((await config.read()).routing.groupAllowlist).toEqual([OTHER_GROUP]);
    expect(await call('stop_monitoring_group', { group_id: FAMILY })).toBe(`"Família" (${FAMILY}) is not monitored.`);
  });

  it('refuses ids that are not groups, or that the archive does not know', async () => {
    const { call, file, template } = await setup();
    await expect(call('monitor_group', { group_id: 'Família' })).rejects.toThrow('"Família" is not a group id. Find it with find_chats.');
    await expect(call('monitor_group', { group_id: BOB })).rejects.toThrow('is not a group id');
    await expect(call('monitor_group', { group_id: '120363999999999999@g.us' })).rejects.toThrow('No chat with id 120363999999999999@g.us');
    await expect(call('set_auto_reply', { chat_id: 'status@broadcast', enabled: true })).rejects.toThrow('is not a chat id');
    expect(await readFile(file, 'utf8')).toBe(template);
  });

  it('turns direct messages and auto-replies on and off', async () => {
    const { call, config } = await setup();
    expect(await call('set_direct_messages', { enabled: false })).toBe('Done: stop reading one-to-one conversations. It applies from the next message.');
    expect(await call('set_direct_messages', { enabled: false })).toBe("Nothing to change: you already don't read one-to-one conversations.");
    await expect(call('set_direct_messages', { enabled: 'no' })).rejects.toThrow('"enabled" must be true or false.');

    expect(await call('set_auto_reply', { chat_id: BOB, enabled: true })).toBe(
      `Done: reply in "Bob" (${BOB}) without being asked. It applies from the next message.`,
    );
    expect((await config.read()).routing).toMatchObject({ directMessages: false, autoReplyChats: [BOB] });
    await call('set_auto_reply', { chat_id: BOB, enabled: false });
    expect((await config.read()).routing.autoReplyChats).toEqual([]);
    expect(await call('set_auto_reply', { chat_id: BOB, enabled: false })).toBe(`Replies in ${BOB} already need the owner to mention you.`);
  });

  it('gives every cost figure in one call, for 7 days unless asked', async () => {
    const { call, costDays } = await setup();
    expect(JSON.parse(await call('get_costs'))).toEqual({
      currency: 'USD',
      periods: { day: { key: '2026-11-10', calls: 3, cost: 0.054293 } },
    });
    await call('get_costs', { days: 30 });
    expect(costDays).toEqual([7, 30]);
    await expect(call('get_costs', { days: 0 })).rejects.toThrow('"days" must be a whole number from 1 to 90.');
    await expect(call('get_costs', { days: 2.5 })).rejects.toThrow(ToolCallError);
  });

  it('changes nothing in a dry run', async () => {
    const { call, file, template } = await setup({ dryRun: true });
    expect(await call('monitor_group', { group_id: FAMILY })).toBe(`Dry run: would monitor "Família" (${FAMILY}). Nothing was changed.`);
    expect(await call('set_direct_messages', { enabled: false })).toContain('Dry run: would stop reading');
    expect(await readFile(file, 'utf8')).toBe(template);
  });
});

describe('settingsServer', () => {
  it('starts this CLI with the config of the agent, only for the settings tools', () => {
    const config = makeConfig();
    const server = settingsServer(config, { dryRun: true, cli: '/opt/agentic-whatsapp/dist/cli.js' });
    expect(server).toMatchObject({
      name: 'agentic-whatsapp',
      transport: 'stdio',
      command: process.execPath,
      args: ['/opt/agentic-whatsapp/dist/cli.js', 'settings-mcp', `--config=${config.paths.configFile}`, '--dry-run'],
      tools: [...SETTINGS_TOOLS],
    });
    expect(settingsServer(config, { dryRun: false }).args.slice(1)).toEqual(['settings-mcp', `--config=${config.paths.configFile}`]);
  });
});
