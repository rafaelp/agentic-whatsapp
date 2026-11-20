import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNotifier } from '../src/notify.js';
import { createPusher, describePush, PUSHOVER_URL, PUSHOVER_VALIDATE_URL, pushSetup, sendPushover } from '../src/push.js';
import { makeConfig, MemoryLogger, tempDir } from './helpers.js';

const USER = 'u'.repeat(30);
const TOKEN = 'a'.repeat(30);
const pushConfig = (push: Record<string, unknown> = {}) => makeConfig({ push: { pushover_user: USER, pushover_token: TOKEN, ...push } }).push;

/** A fetch that records each request and answers with `answer`. */
function fakeFetch(answer: () => Response | Promise<Response> = () => Response.json({ status: 1 })) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    requests.push({ url, body: new URLSearchParams(init.body as URLSearchParams) });
    return answer();
  };
  return { requests, fetchImpl };
}

describe('sendPushover', () => {
  it('posts the keys, title, text and priority to Pushover', async () => {
    const { requests, fetchImpl } = fakeFetch();
    const result = await sendPushover(pushConfig({ priority: 1, sound: 'magic' }), { title: 'Ane', text: 'Lembrete: pagar o boleto' }, fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(PUSHOVER_URL);
    expect(Object.fromEntries(requests[0]?.body ?? [])).toEqual({
      token: TOKEN,
      user: USER,
      title: 'Ane',
      message: 'Lembrete: pagar o boleto',
      priority: '1',
      sound: 'magic',
    });
  });

  it('cuts long text at Pushover limits without splitting an emoji', async () => {
    const { requests, fetchImpl } = fakeFetch();
    await sendPushover(pushConfig(), { title: 'Ane', text: `${'x'.repeat(1022)}🔔🔔🔔` }, fetchImpl);
    const message = requests[0]?.body.get('message') ?? '';
    expect([...message]).toHaveLength(1024);
    expect(message.endsWith('x🔔…')).toBe(true);
    expect(requests[0]?.body.has('sound')).toBe(false);
  });

  it('says why Pushover refused, and never throws', async () => {
    const refused = fakeFetch(() => Response.json({ status: 0, errors: ['user key is invalid'] }, { status: 400 }));
    expect(await sendPushover(pushConfig(), { title: 'Ane', text: 'oi' }, refused.fetchImpl)).toEqual({
      ok: false,
      error: 'Pushover answered 400: user key is invalid',
    });
    const offline = fakeFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.pushover.net')));
    expect(await sendPushover(pushConfig(), { title: 'Ane', text: 'oi' }, offline.fetchImpl)).toEqual({
      ok: false,
      error: 'getaddrinfo ENOTFOUND api.pushover.net',
    });
  });
});

describe('createPusher', () => {
  it('is absent without Pushover keys', () => {
    expect(createPusher(makeConfig().push, new MemoryLogger())).toBeUndefined();
  });

  it('logs each push, without its text or keys', async () => {
    const log = new MemoryLogger();
    const { fetchImpl } = fakeFetch(() => new Response('nope', { status: 500 }));
    const push = createPusher(pushConfig(), log, fetchImpl);
    await push?.({ title: 'Ane', text: 'segredo' });
    expect(log.entries.find((entry) => entry.message === 'push failed')?.fields).toEqual({ error: 'Pushover answered 500' });

    const ok = fakeFetch();
    await createPusher(pushConfig(), log, ok.fetchImpl)?.({ title: 'Ane', text: 'segredo' });
    expect(log.entries.find((entry) => entry.message === 'push sent')?.fields).toEqual({ title: 'Ane' });
    expect(JSON.stringify(log.entries)).not.toContain('segredo');
  });

  it('also sends service alerts when the notifier gets it', async () => {
    const { requests, fetchImpl } = fakeFetch();
    const notify = createNotifier(new MemoryLogger(), false, createPusher(pushConfig(), new MemoryLogger(), fetchImpl));
    notify('Ane: WhatsApp sync is failing', '3 times in a row.');
    await new Promise((done) => setImmediate(done));
    expect(requests.map((request) => request.body.get('title'))).toEqual(['Ane: WhatsApp sync is failing']);
  });
});

describe('describePush', () => {
  it('says what goes as a push, or how to turn it on', () => {
    expect(describePush(makeConfig().push)).toBe('off: set pushover_user and pushover_token in [push] to get pushes');
    expect(describePush(pushConfig())).toBe('Pushover, for scheduled tasks; priority 0');
    expect(describePush(pushConfig({ send: ['tasks', 'alerts'], priority: 1, sound: 'magic' }))).toBe(
      'Pushover, for scheduled tasks, service alerts; priority 1, sound magic',
    );
  });
});

describe('pushSetup', () => {
  const FILE = '[agent]\nname = "Ane"\n\n[push]\n# What goes as a push.\nsend = ["tasks"]\n';

  /** A config file in a temporary folder, and a person who gives these answers in turn. */
  async function setup(answers: string[], file = FILE) {
    const dir = await tempDir();
    await writeFile(join(dir, 'config.toml'), file);
    const config = makeConfig({}, dir);
    const asked: { question: string; secret: boolean }[] = [];
    const written: string[] = [];
    const io = {
      ask: async (question: string, options: { secret?: boolean } = {}) => {
        asked.push({ question, secret: options.secret === true });
        return answers.shift() ?? '';
      },
      write: (line: string) => void written.push(line),
    };
    return { dir, config, io, asked, written, read: () => readFile(join(dir, 'config.toml'), 'utf8') };
  }

  it('checks the keys with Pushover, saves them in [push] keeping the rest, and sends a test push', async () => {
    const { dir, config, io, asked, written, read } = await setup([USER, TOKEN]);
    const { requests, fetchImpl } = fakeFetch(() => Response.json({ status: 1, devices: ['iphone'] }));
    expect(await pushSetup(config, io, fetchImpl)).toBe(true);
    expect(asked).toEqual([
      { question: 'User key: ', secret: false },
      { question: 'API token: ', secret: true },
    ]);
    expect(requests.map((request) => request.url)).toEqual([PUSHOVER_VALIDATE_URL, PUSHOVER_URL]);
    expect(Object.fromEntries(requests[0]?.body ?? [])).toEqual({ token: TOKEN, user: USER });
    expect(await read()).toBe(`[agent]\nname = "Ane"\n\n[push]\n# What goes as a push.\nsend = ["tasks"]\npushover_user = "${USER}"\npushover_token = "${TOKEN}"\n`);
    expect(await readdir(join(dir, 'config-history'))).toHaveLength(1);
    expect(written).toContain('Pushover accepted them; your devices: iphone.');
    expect(written).toContain('Sent a test push: check your phone.');
    expect(written.at(-1)).toBe('Restart the agent to use them: agentic-whatsapp restart');
  });

  it('asks again for a key that does not look like one, and saves nothing Pushover refuses', async () => {
    const { config, io, asked, written, read } = await setup(['abc', USER, TOKEN]);
    const { requests, fetchImpl } = fakeFetch(() => Response.json({ status: 0, errors: ['application token is invalid'] }, { status: 400 }));
    expect(await pushSetup(config, io, fetchImpl)).toBe(false);
    expect(asked).toHaveLength(3);
    expect(written).toContain('A Pushover user key is 30 letters and digits.');
    expect(written.at(-1)).toBe('Pushover refused them, nothing was saved: Pushover answered 400: application token is invalid');
    expect(requests).toHaveLength(1);
    expect(await read()).toBe(FILE);

    const giveUp = await setup(['a', 'b', 'c']);
    expect(await pushSetup(giveUp.config, giveUp.io, fakeFetch().fetchImpl)).toBe(false);
    expect(giveUp.written.at(-1)).toBe('Nothing was saved.');
  });

  it('keeps the keys already set when Enter is pressed', async () => {
    const file = `[agent]\nname = "Ane"\n\n[push]\npushover_user = "${USER}"\npushover_token = "${TOKEN}"\n`;
    const { dir, io, asked, read } = await setup(['', ''], file);
    const config = makeConfig({ push: { pushover_user: USER, pushover_token: TOKEN } }, dir);
    expect(await pushSetup(config, io, fakeFetch().fetchImpl)).toBe(true);
    expect(asked.map((question) => question.question)).toEqual([
      'User key (Enter keeps the one ending in uuuu): ',
      'API token (Enter keeps the one ending in aaaa): ',
    ]);
    expect(await read()).toBe(file);
  });
});
