import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { Store } from './db.js';
import { createLogger, type Logger } from './log.js';
import { costSummary } from './report.js';
import { openLedger } from './service.js';
import { CHAT_JID, ConfigFile, GROUP_JID } from './settings.js';
import { AgentState } from './state.js';
import { MAX_PENDING_TASKS, MAX_TASK_LENGTH, type Task, TaskStore } from './tasks.js';
import { formatLocalTime, parseLocalTime, weekday } from './time.js';
import { type McpServer, SETTINGS_SERVER } from './tools.js';
import { asString, errorMessage, isRecord } from './util.js';
import type { ChatInfo } from './wacli.js';

/** One tool of an MCP server: what tools/list shows, and what tools/call runs. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the text the model gets back; a ToolCallError becomes a tool error it can read. */
  call(args: Record<string, unknown>): Promise<string>;
}

/** A failed call the model can act on, such as an unknown chat. */
export class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallError';
  }
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * A minimal MCP server over stdio, one JSON-RPC message per line: initialize, ping,
 * tools/list and tools/call. Calls run one at a time, in order. Resolves when the input ends.
 */
export async function serveMcp(
  info: { name: string; version: string },
  tools: readonly ToolDefinition[],
  io: { input: NodeJS.ReadableStream; write: (line: string) => void },
): Promise<void> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const send = (message: Record<string, unknown>) => io.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

  const handle = async (line: string): Promise<void> => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!isRecord(message) || typeof message.method !== 'string') return;
    const { id, method } = message;
    // Notifications, such as notifications/initialized, need no answer.
    if (id === undefined || id === null) return;
    const params = isRecord(message.params) ? message.params : {};
    switch (method) {
      case 'initialize':
        send({
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: info,
          },
        });
        return;
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({
          id,
          result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        });
        return;
      case 'tools/call': {
        const tool = byName.get(asString(params.name));
        if (tool === undefined) {
          send({ id, error: { code: -32602, message: `Unknown tool: ${asString(params.name)}` } });
          return;
        }
        try {
          const text = await tool.call(isRecord(params.arguments) ? params.arguments : {});
          send({ id, result: { content: [{ type: 'text', text }] } });
        } catch (error) {
          send({ id, result: { content: [{ type: 'text', text: errorMessage(error) }], isError: true } });
        }
        return;
      }
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  let queue = Promise.resolve();
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  for await (const line of lines) {
    queue = queue.then(() => handle(line));
  }
  await queue;
}

/** The tools of the built-in settings server, in the order the model sees them. */
export const SETTINGS_TOOLS = [
  'get_settings',
  'find_chats',
  'monitor_chat',
  'stop_monitoring_chat',
  'set_direct_messages',
  'set_auto_reply',
  'get_costs',
  'schedule_task',
  'list_tasks',
  'cancel_task',
] as const;

/** What the settings tools need from wacli: the local archive, read-only. */
export interface ChatDirectory {
  listChats(query: string, limit: number): Promise<ChatInfo[]>;
  chat(jid: string): Promise<ChatInfo | null>;
}

export interface SettingsToolsDeps {
  config: ConfigFile;
  chats: ChatDirectory;
  /** Every cost figure for the last `days` days, as costSummary in src/report.ts gives them. */
  costs: (days: number) => Promise<Record<string, unknown>>;
  /** The scheduled tasks, which the running agent does when they are due. */
  tasks: TaskStore;
  /** agent.timezone: task times are given and shown in it. */
  timezone: string;
  /** The agent log, for the tasks scheduled and cancelled. */
  log: Logger;
  /** Say what would change, and change nothing. */
  dryRun: boolean;
  now?: () => Date;
}

const MAX_FOUND = 20;
const MAX_COST_DAYS = 90;
/** How far ahead a task can be scheduled. */
const MAX_TASK_DAYS = 366;
/** Finished tasks list_tasks shows. */
const RECENT_TASKS = 10;

/** Costs to a millionth, enough for the cheapest call, and fewer tokens for the model to read. */
const roundCosts = (key: string, value: unknown) => (key === 'cost' && typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value);

/**
 * The agent's own settings, as MCP tools: which groups it reads, whether it reads direct
 * messages, and where it may reply without being asked. They edit [routing] in the config
 * file, and the running agent picks the change up with its next message. The task tools
 * schedule work for later in the database, where the running agent finds it when it is due.
 */
export function settingsTools(deps: SettingsToolsDeps): ToolDefinition[] {
  const { config, chats, costs, tasks, timezone, log, dryRun } = deps;
  const now = deps.now ?? (() => new Date());
  /** "Thu 2026-11-12 09:00", in the owner's time zone. */
  const when = (date: Date) => `${weekday(date, timezone)} ${formatLocalTime(date, timezone)}`;
  const taskJson = (task: Task) => ({
    id: task.id,
    at: when(task.dueAt),
    chat_id: task.chat || undefined,
    chat: task.chat === '' ? undefined : task.chatName || null,
    task: task.task || null,
    status: task.status === 'pending' ? undefined : task.status,
    result: task.result || undefined,
    error: task.status === 'cancelled' ? undefined : task.error || undefined,
  });
  const label = (chat: ChatInfo | null, jid: string) => (chat === null || chat.name === '' ? jid : `"${chat.name}" (${jid})`);
  const known = async (jid: string, pattern: RegExp, what: string): Promise<ChatInfo> => {
    if (!pattern.test(jid)) throw new ToolCallError(`${JSON.stringify(jid)} is not a ${what} id. Find it with find_chats.`);
    const chat = await chats.chat(jid);
    if (chat === null) throw new ToolCallError(`No chat with id ${jid} in the WhatsApp archive. Find it with find_chats.`);
    return chat;
  };
  const done = (change: string) => (dryRun ? `Dry run: would ${change}. Nothing was changed.` : `Done: ${change}. It applies from the next message.`);
  const named = async (jids: readonly string[]) =>
    Promise.all(jids.map(async (jid) => ({ id: jid, name: (await chats.chat(jid).catch(() => null))?.name ?? '' })));

  return [
    {
      name: 'get_settings',
      description:
        'Shows your current settings: the chats you monitor (people and groups whose messages you read), whether ' +
        'you read every one-to-one conversation anyway, and the chats where you may reply without being asked.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async call() {
        const { routing } = await config.read();
        return JSON.stringify({
          monitored_people: await named(routing.directAllowlist),
          monitored_groups: await named(routing.groupAllowlist),
          all_direct_messages: routing.directMessages,
          auto_reply_chats: await named(routing.autoReplyChats),
        });
      },
    },
    {
      name: 'find_chats',
      description:
        'Finds WhatsApp chats by name, to get the id the other tools take. Says for each one whether you monitor ' +
        'it and whether you may reply there without being asked.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Part of the chat name' },
          type: { type: 'string', enum: ['group', 'direct'], description: 'Only groups, or only one-to-one chats' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async call(args) {
        const query = asString(args.query).trim();
        if (query === '') throw new ToolCallError('Give part of the chat name in "query".');
        const type = asString(args.type);
        const { routing } = await config.read();
        const found = (await chats.listChats(query, MAX_FOUND * 2))
          .filter((chat) => chat.kind !== 'other' && (type === '' || chat.kind === type))
          .slice(0, MAX_FOUND);
        return JSON.stringify(
          found.map((chat) => ({
            id: chat.jid,
            name: chat.name,
            type: chat.kind,
            monitored:
              chat.kind === 'group'
                ? routing.groupAllowlist.includes(chat.jid)
                : routing.directMessages || routing.directAllowlist.includes(chat.jid),
            auto_reply: routing.autoReplyChats.includes(chat.jid),
          })),
        );
      },
    },
    {
      name: 'monitor_chat',
      description:
        'Starts reading the messages of a chat, a person or a group, so your instructions apply to it. Without ' +
        'this you never see the messages of a chat, whatever the instructions say, except where the owner mentions you.',
      inputSchema: {
        type: 'object',
        properties: { chat_id: { type: 'string', description: 'The chat id from find_chats' } },
        required: ['chat_id'],
        additionalProperties: false,
      },
      async call(args) {
        const jid = asString(args.chat_id).trim();
        const chat = await known(jid, CHAT_JID, 'chat');
        const { routing } = await config.read();
        const group = GROUP_JID.test(jid);
        const list = group ? routing.groupAllowlist : routing.directAllowlist;
        if (list.includes(jid)) return `Already monitoring ${label(chat, jid)}.`;
        if (!dryRun) await config.updateRouting(group ? { groupAllowlist: [...list, jid] } : { directAllowlist: [...list, jid] });
        return done(`monitor ${label(chat, jid)}`);
      },
    },
    {
      name: 'stop_monitoring_chat',
      description: 'Stops reading the messages of a chat. You still see the messages where the owner mentions you.',
      inputSchema: {
        type: 'object',
        properties: { chat_id: { type: 'string', description: 'The chat id, from get_settings or find_chats' } },
        required: ['chat_id'],
        additionalProperties: false,
      },
      async call(args) {
        const jid = asString(args.chat_id).trim();
        if (!CHAT_JID.test(jid)) throw new ToolCallError(`${JSON.stringify(jid)} is not a chat id. See the monitored chats with get_settings.`);
        const { routing } = await config.read();
        const chat = await chats.chat(jid).catch(() => null);
        const group = GROUP_JID.test(jid);
        const list = group ? routing.groupAllowlist : routing.directAllowlist;
        if (!list.includes(jid)) return `${label(chat, jid)} is not monitored.`;
        const rest = list.filter((item) => item !== jid);
        if (!dryRun) await config.updateRouting(group ? { groupAllowlist: rest } : { directAllowlist: rest });
        const note = !group && routing.directMessages ? ' You still read it, because you read every one-to-one conversation.' : '';
        return `${done(`stop monitoring ${label(chat, jid)}`)}${note}`;
      },
    },
    {
      name: 'set_direct_messages',
      description:
        'Reads every one-to-one conversation (enabled: true), or only the people you monitor (enabled: false). ' +
        'Turn it on only when the owner asks for all of them.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
        additionalProperties: false,
      },
      async call(args) {
        if (typeof args.enabled !== 'boolean') throw new ToolCallError('"enabled" must be true or false.');
        const { routing } = await config.read();
        const what = args.enabled ? 'read every one-to-one conversation' : 'read only the one-to-one conversations you monitor';
        if (routing.directMessages === args.enabled) return `Nothing to change: you already ${what}.`;
        if (!dryRun) await config.updateRouting({ directMessages: args.enabled });
        return done(what);
      },
    },
    {
      name: 'set_auto_reply',
      description:
        'Lets you reply to other people in a chat without being asked (enabled: true), or only where the owner ' +
        'mentions you (enabled: false). Turn it on only when the owner asks for that chat by name.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat id from find_chats' },
          enabled: { type: 'boolean' },
        },
        required: ['chat_id', 'enabled'],
        additionalProperties: false,
      },
      async call(args) {
        const jid = asString(args.chat_id).trim();
        if (typeof args.enabled !== 'boolean') throw new ToolCallError('"enabled" must be true or false.');
        const { routing } = await config.read();
        const listed = routing.autoReplyChats.includes(jid);
        if (!args.enabled) {
          if (!listed) return `Replies in ${jid} already need the owner to mention you.`;
          if (!dryRun) await config.updateRouting({ autoReplyChats: routing.autoReplyChats.filter((item) => item !== jid) });
          return done(`reply in ${jid} only when the owner mentions you`);
        }
        const chat = await known(jid, CHAT_JID, 'chat');
        if (listed) return `You may already reply in ${label(chat, jid)} without being asked.`;
        if (!dryRun) await config.updateRouting({ autoReplyChats: [...routing.autoReplyChats, jid] });
        return done(`reply in ${label(chat, jid)} without being asked`);
      },
    },
    {
      name: 'get_costs',
      description:
        'Everything about what you cost, in one call: the model, its prices and the currency; calls, input, ' +
        'output, cached and thinking tokens and cost for today, this week (Monday to Sunday), this month and all ' +
        'time, with the limits set for each; and the last days broken down by day, by chat (the most expensive ' +
        'first), by model and by purpose (decisions, images, audio). "billing" says whether the costs are billed ' +
        'or only what the tokens would cost on the Gemini API.',
      inputSchema: {
        type: 'object',
        properties: {
          days: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_COST_DAYS,
            description: 'How many days the breakdowns cover, today included (default 7)',
          },
        },
        additionalProperties: false,
      },
      async call(args) {
        const days = args.days === undefined ? 7 : args.days;
        if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_COST_DAYS) {
          throw new ToolCallError(`"days" must be a whole number from 1 to ${MAX_COST_DAYS}.`);
        }
        return JSON.stringify(await costs(days), roundCosts);
      },
    },
    {
      name: 'schedule_task',
      description:
        'Schedules something for you to do later, at a given time: a message to someone, a reminder for the owner, ' +
        'anything you can do with your tools. When it is due you get the task as an owner command, with the chat it ' +
        'is about, where a reply then goes.',
      inputSchema: {
        type: 'object',
        properties: {
          at: { type: 'string', description: `When, in local time (${timezone}), as YYYY-MM-DD HH:MM` },
          task: {
            type: 'string',
            description:
              'What to do then, complete enough to do without this conversation, and without the date or time: who, ' +
              'what and how, in the language of the owner. E.g. "Send Carol a message saying she needs to buy juice".',
          },
          chat_id: {
            type: 'string',
            description: 'The chat the task is about, from find_chats, such as the person to message. Leave it out for a task for the owner.',
          },
        },
        required: ['at', 'task'],
        additionalProperties: false,
      },
      async call(args) {
        const at = asString(args.at).trim();
        const dueAt = parseLocalTime(at, timezone);
        const current = now();
        if (dueAt === undefined) {
          throw new ToolCallError(`"at" must be a local time as YYYY-MM-DD HH:MM, such as ${formatLocalTime(current, timezone)}.`);
        }
        // The current minute still counts, so "in a minute" works when the clock turns meanwhile.
        if (dueAt.getTime() < current.getTime() - (current.getTime() % 60_000)) {
          throw new ToolCallError(`${at} is in the past: it is now ${when(current)} (${timezone}).`);
        }
        if (dueAt.getTime() > current.getTime() + MAX_TASK_DAYS * 86_400_000) {
          throw new ToolCallError(`A task can be scheduled at most ${MAX_TASK_DAYS} days ahead.`);
        }
        const task = asString(args.task).trim();
        if (task === '') throw new ToolCallError('Say what to do in "task".');
        if (task.length > MAX_TASK_LENGTH) throw new ToolCallError(`"task" can have at most ${MAX_TASK_LENGTH} characters.`);
        const jid = asString(args.chat_id).trim();
        const chat = jid === '' ? undefined : await known(jid, CHAT_JID, 'chat');
        if (tasks.pending().length >= MAX_PENDING_TASKS) {
          throw new ToolCallError(`There are already ${MAX_PENDING_TASKS} tasks waiting. Cancel some first.`);
        }
        const where = chat === undefined ? '' : `, about ${label(chat, jid)}`;
        if (dryRun) return `Dry run: would schedule the task for ${when(dueAt)}${where}. Nothing was scheduled.`;
        const scheduled = tasks.schedule({ dueAt, task, chat: jid, chatName: chat?.name ?? '' }, current);
        log.info('task scheduled', {
          task: scheduled.id,
          due: formatLocalTime(dueAt, timezone),
          chat: jid || undefined,
          chatName: chat?.name || undefined,
        });
        return `Scheduled task ${scheduled.id} for ${when(dueAt)} (${timezone})${where}.`;
      },
    },
    {
      name: 'list_tasks',
      description:
        'Lists the scheduled tasks still to do, the next one first, with their id, time, chat and what they say, and ' +
        `the last ${RECENT_TASKS} that ran, failed, were missed or were cancelled, with what came of them.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async call() {
        return JSON.stringify({ pending: tasks.pending().map(taskJson), recent: tasks.finished(RECENT_TASKS).map(taskJson) });
      },
    },
    {
      name: 'cancel_task',
      description: 'Cancels a scheduled task that has not run yet, by its id from list_tasks.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'integer', description: 'The id of the task, from list_tasks' } },
        required: ['task_id'],
        additionalProperties: false,
      },
      async call(args) {
        const id = args.task_id;
        if (typeof id !== 'number' || !Number.isInteger(id)) throw new ToolCallError('"task_id" must be the id of a task, from list_tasks.');
        const task = tasks.get(id);
        if (task === undefined) throw new ToolCallError(`There is no task ${id}. See the tasks with list_tasks.`);
        if (task.status !== 'pending') return `Task ${id} cannot be cancelled: it is ${task.status}.`;
        if (dryRun) return `Dry run: would cancel task ${id}. Nothing was changed.`;
        if (tasks.cancel(id, now()) === undefined) return `Task ${id} cannot be cancelled: it has just started.`;
        log.info('task cancelled', { task: id, chat: task.chat || undefined, chatName: task.chatName || undefined });
        return `Done: task ${id}, for ${when(task.dueAt)}, is cancelled.`;
      },
    },
  ];
}

/** How the model is told about the settings tools, in <tools>. */
const SETTINGS_DESCRIPTION =
  'your own settings, what you cost, and the tasks the owner scheduled for later. When the owner asks about costs, tokens or limits, call get_costs once ' +
  'and answer from it. You only read the chats you monitor, plus the owner\'s commands: your instructions alone ' +
  'cannot make you read a person or a group. When an owner command asks you to follow, monitor or watch a chat, ' +
  'or gives a rule about someone you do not monitor, find the chat with find_chats and use monitor_chat. When more ' +
  'than one chat matches, ask the owner which one instead of guessing. Change settings only when an owner command ' +
  'asks, and tell the owner what changed with a notify. When an owner command asks for something at a later time, ' +
  'such as "tomorrow at 9 tell Carol…" or "remind me in two hours…", schedule it with schedule_task, with the chat ' +
  'it is about from find_chats, and tell the owner when it will run. Check the day of the week schedule_task gives back';

/**
 * The built-in settings server as agy starts it: this same CLI, `settings-mcp`, with the
 * config file of the running agent. It is offered only for commands the owner typed in the
 * home chat.
 */
export function settingsServer(config: Config, options: { dryRun: boolean; cli?: string }): McpServer {
  const cli = options.cli ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  return {
    name: SETTINGS_SERVER,
    transport: 'stdio',
    command: process.execPath,
    args: [cli, 'settings-mcp', `--config=${config.paths.configFile}`, ...(options.dryRun ? ['--dry-run'] : [])],
    url: '',
    env: {},
    headers: {},
    tools: [...SETTINGS_TOOLS],
    scope: 'commands',
    enabled: true,
    addedAt: '',
    updatedAt: '',
    description: SETTINGS_DESCRIPTION,
  };
}

/** `agentic-whatsapp settings-mcp`: the settings server on stdin and stdout, until agy closes it. */
export async function serveSettings(config: Config, options: { dryRun: boolean; version: string; chats: ChatDirectory }): Promise<void> {
  const { paths } = config;
  const store = Store.open(paths.database);
  const tasks = new TaskStore(new AgentState(store, { saveText: config.storage.saveText }), { saveText: config.storage.saveText });
  // The agent rotates its log; this process only appends to it.
  const log = createLogger({ stderr: false, file: { path: paths.agentLog, maxBytes: Number.POSITIVE_INFINITY, keep: 1 } });
  const costs = async (days: number) => {
    const opened = openLedger(config);
    try {
      return costSummary(config, opened?.ledger, new Date(), { days, maxGroups: MAX_FOUND });
    } finally {
      opened?.store.close();
    }
  };
  const file = new ConfigFile(
    { configFile: paths.configFile, stateDir: paths.stateDir, logDir: paths.logDir },
    join(paths.stateDir, 'config-history'),
  );
  try {
    await serveMcp(
      { name: SETTINGS_SERVER, version: options.version },
      settingsTools({ config: file, chats: options.chats, costs, tasks, timezone: config.agent.timezone, log, dryRun: options.dryRun }),
      { input: process.stdin, write: (line) => process.stdout.write(line) },
    );
  } finally {
    store.close();
  }
}
