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
import { AgentState } from '../src/state.js';
import { TaskStore } from '../src/tasks.js';
import { configTemplate } from '../src/templates.js';
import type { ChatInfo } from '../src/wacli.js';
import { BOB, FAMILY, HOME, makeConfig, MemoryLogger, memoryStore, NOW, OTHER_GROUP, tempDir } from './helpers.js';

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
  const { store } = memoryStore();
  const tasks = new TaskStore(new AgentState(store));
  const log = new MemoryLogger();
  let now = NOW;
  const tools = new Map(
    settingsTools({
      config,
      chats: new FakeChats(CHATS),
      costs,
      tasks,
      timezone: 'America/Sao_Paulo',
      log,
      dryRun: options.dryRun ?? false,
      now: () => now,
    }).map((tool) => [tool.name, tool]),
  );
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.call(args);
  };
  const setNow = (date: Date) => {
    now = date;
  };
  return { file, template, config, call, costDays, tasks, log, setNow, names: [...tools.keys()] };
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
      { id: BOB, name: 'Bob', type: 'direct', monitored: false, auto_reply: false },
    ]);
    await call('monitor_chat', { chat_id: BOB });
    expect(JSON.parse(await call('find_chats', { query: 'bob' }))[0].monitored).toBe(true);
    await expect(call('find_chats', { query: ' ' })).rejects.toThrow(ToolCallError);
  });

  it('starts and stops monitoring people and groups, each in its own list', async () => {
    const { call, config } = await setup();
    expect(await call('monitor_chat', { chat_id: FAMILY })).toBe(`Done: monitor "Família" (${FAMILY}). It applies from the next message.`);
    expect(await call('monitor_chat', { chat_id: FAMILY })).toBe(`Already monitoring "Família" (${FAMILY}).`);
    await call('monitor_chat', { chat_id: OTHER_GROUP });
    expect(await call('monitor_chat', { chat_id: BOB })).toBe(`Done: monitor "Bob" (${BOB}). It applies from the next message.`);
    expect((await config.read()).routing).toMatchObject({ groupAllowlist: [FAMILY, OTHER_GROUP], directAllowlist: [BOB] });
    expect(JSON.parse(await call('get_settings'))).toEqual({
      monitored_people: [{ id: BOB, name: 'Bob' }],
      monitored_groups: [
        { id: FAMILY, name: 'Família' },
        { id: OTHER_GROUP, name: 'Família estendida' },
      ],
      all_direct_messages: false,
      auto_reply_chats: [],
    });

    expect(await call('stop_monitoring_chat', { chat_id: FAMILY })).toBe(
      `Done: stop monitoring "Família" (${FAMILY}). It applies from the next message.`,
    );
    await call('stop_monitoring_chat', { chat_id: BOB });
    expect((await config.read()).routing).toMatchObject({ groupAllowlist: [OTHER_GROUP], directAllowlist: [] });
    expect(await call('stop_monitoring_chat', { chat_id: FAMILY })).toBe(`"Família" (${FAMILY}) is not monitored.`);
  });

  it('refuses ids that are not chats, or that the archive does not know', async () => {
    const { call, file, template } = await setup();
    await expect(call('monitor_chat', { chat_id: 'Família' })).rejects.toThrow('"Família" is not a chat id. Find it with find_chats.');
    await expect(call('monitor_chat', { chat_id: 'status@broadcast' })).rejects.toThrow('is not a chat id');
    await expect(call('monitor_chat', { chat_id: '120363999999999999@g.us' })).rejects.toThrow('No chat with id 120363999999999999@g.us');
    await expect(call('set_auto_reply', { chat_id: 'status@broadcast', enabled: true })).rejects.toThrow('is not a chat id');
    expect(await readFile(file, 'utf8')).toBe(template);
  });

  it('turns direct messages and auto-replies on and off', async () => {
    const { call, config } = await setup();
    expect(await call('set_direct_messages', { enabled: true })).toBe('Done: read every one-to-one conversation. It applies from the next message.');
    expect(await call('set_direct_messages', { enabled: true })).toBe('Nothing to change: you already read every one-to-one conversation.');
    await call('set_direct_messages', { enabled: false });
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

  it('schedules a task at a local time, about a chat it knows, and logs it', async () => {
    const { call, tasks, log } = await setup();
    // NOW is Tuesday 2026-11-10 12:00 in São Paulo.
    expect(await call('schedule_task', { at: '2026-11-11 09:00', task: 'Dizer ao Bob que precisa comprar suco', chat_id: BOB })).toBe(
      `Scheduled task 1 for Wed 2026-11-11 09:00 (America/Sao_Paulo), about "Bob" (${BOB}).`,
    );
    expect(await call('schedule_task', { at: '2026-11-10 12:00', task: 'Lembrar do boleto' })).toBe(
      'Scheduled task 2 for Tue 2026-11-10 12:00 (America/Sao_Paulo).',
    );
    expect(tasks.pending()).toEqual([
      expect.objectContaining({ id: 2, dueAt: new Date('2026-11-10T15:00:00Z'), chat: '', task: 'Lembrar do boleto' }),
      expect.objectContaining({ id: 1, dueAt: new Date('2026-11-11T12:00:00Z'), chat: BOB, chatName: 'Bob' }),
    ]);
    expect(log.entries.filter((entry) => entry.message === 'task scheduled').map((entry) => entry.fields)).toEqual([
      { task: 1, due: '2026-11-11 09:00', chat: BOB, chatName: 'Bob' },
      { task: 2, due: '2026-11-10 12:00', chat: undefined, chatName: undefined },
    ]);
  });

  it('refuses times it cannot read, in the past or too far ahead, and chats it does not know', async () => {
    const { call, tasks } = await setup();
    await expect(call('schedule_task', { at: 'amanhã 9h', task: 'x' })).rejects.toThrow(
      '"at" must be a local time as YYYY-MM-DD HH:MM, such as 2026-11-10 12:00.',
    );
    await expect(call('schedule_task', { at: '2026-11-10 11:59', task: 'x' })).rejects.toThrow(
      '2026-11-10 11:59 is in the past: it is now Tue 2026-11-10 12:00 (America/Sao_Paulo).',
    );
    await expect(call('schedule_task', { at: '2028-01-01 09:00', task: 'x' })).rejects.toThrow('at most 366 days ahead');
    await expect(call('schedule_task', { at: '2026-11-11 09:00', task: ' ' })).rejects.toThrow('Say what to do in "task".');
    await expect(call('schedule_task', { at: '2026-11-11 09:00', task: 'x'.repeat(2_001) })).rejects.toThrow('at most 2000 characters');
    await expect(call('schedule_task', { at: '2026-11-11 09:00', task: 'x', chat_id: 'Bob' })).rejects.toThrow('"Bob" is not a chat id');
    await expect(call('schedule_task', { at: '2026-11-11 09:00', task: 'x', chat_id: '5521999999999@s.whatsapp.net' })).rejects.toThrow(
      'No chat with id',
    );
    expect(tasks.pending()).toEqual([]);
  });

  it('lists the tasks waiting and the last ones that finished, and cancels one', async () => {
    const { call, tasks, log, setNow } = await setup();
    await call('schedule_task', { at: '2026-11-11 09:00', task: 'Dizer ao Bob que precisa comprar suco', chat_id: BOB });
    await call('schedule_task', { at: '2026-11-12 18:30', task: 'Lembrar da reunião' });
    await call('schedule_task', { at: '2026-11-10 12:00', task: 'Lembrar do boleto' });
    tasks.start(3, NOW);
    tasks.finish(3, { status: 'done', result: '→ you: Lembrete: boleto' }, NOW);

    expect(JSON.parse(await call('list_tasks'))).toEqual({
      pending: [
        { id: 1, at: 'Wed 2026-11-11 09:00', chat_id: BOB, chat: 'Bob', task: 'Dizer ao Bob que precisa comprar suco' },
        { id: 2, at: 'Thu 2026-11-12 18:30', task: 'Lembrar da reunião' },
      ],
      recent: [{ id: 3, at: 'Tue 2026-11-10 12:00', task: 'Lembrar do boleto', status: 'done', result: '→ you: Lembrete: boleto' }],
    });

    setNow(new Date('2026-11-10T16:00:00Z'));
    expect(await call('cancel_task', { task_id: 2 })).toBe('Done: task 2, for Thu 2026-11-12 18:30, is cancelled.');
    expect(await call('cancel_task', { task_id: 2 })).toBe('Task 2 cannot be cancelled: it is cancelled.');
    expect(await call('cancel_task', { task_id: 3 })).toBe('Task 3 cannot be cancelled: it is done.');
    await expect(call('cancel_task', { task_id: 9 })).rejects.toThrow('There is no task 9.');
    await expect(call('cancel_task', { task_id: '1' })).rejects.toThrow('"task_id" must be the id of a task');
    expect(tasks.pending().map((task) => task.id)).toEqual([1]);
    expect(log.entries.find((entry) => entry.message === 'task cancelled')?.fields).toEqual({ task: 2, chat: undefined, chatName: undefined });
  });

  it('refuses a new task when too many are waiting', async () => {
    const { call, tasks } = await setup();
    for (let index = 0; index < 100; index++) tasks.schedule({ dueAt: new Date('2026-11-11T12:00:00Z'), task: 'x', chat: '', chatName: '' }, NOW);
    await expect(call('schedule_task', { at: '2026-11-11 09:00', task: 'x' })).rejects.toThrow('There are already 100 tasks waiting.');
  });

  it('changes nothing in a dry run', async () => {
    const { call, file, template, tasks } = await setup({ dryRun: true });
    expect(await call('monitor_chat', { chat_id: FAMILY })).toBe(`Dry run: would monitor "Família" (${FAMILY}). Nothing was changed.`);
    expect(await call('set_direct_messages', { enabled: true })).toContain('Dry run: would read every one-to-one conversation');
    expect(await readFile(file, 'utf8')).toBe(template);
    expect(await call('schedule_task', { at: '2026-11-11 09:00', task: 'x', chat_id: BOB })).toBe(
      `Dry run: would schedule the task for Wed 2026-11-11 09:00, about "Bob" (${BOB}). Nothing was scheduled.`,
    );
    expect(tasks.pending()).toEqual([]);
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
