import { join } from 'node:path';
import type { Config, PushConfig } from './config.js';
import type { Logger } from './log.js';
import { ConfigFile } from './settings.js';
import { errorMessage, isRecord } from './util.js';

export const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
export const PUSHOVER_VALIDATE_URL = 'https://api.pushover.net/1/users/validate.json';
/** Pushover user keys and API tokens: 30 letters and digits. */
export const PUSHOVER_KEY = /^[A-Za-z0-9]{30}$/;
/** Pushover's limits; longer text is cut. */
const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;
const TIMEOUT_MS = 10_000;

export interface PushMessage {
  title: string;
  text: string;
}

export type PushResult = { ok: true } | { ok: false; error: string };

/** Sends a push to the owner's phone; never throws, failures are logged. */
export type Pusher = (message: PushMessage) => Promise<void>;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Sends one notification through Pushover and says whether it was accepted. */
export async function sendPushover(config: PushConfig, message: PushMessage, fetchImpl: Fetch = fetch): Promise<PushResult> {
  const body = new URLSearchParams({
    token: config.token,
    user: config.user,
    title: cut(message.title, MAX_TITLE),
    message: cut(message.text, MAX_MESSAGE) || '(empty)',
    priority: String(config.priority),
  });
  if (config.sound !== '') body.set('sound', config.sound);
  const answer = await post(PUSHOVER_URL, body, fetchImpl);
  return answer.ok ? { ok: true } : answer;
}

/** Checks a user key and API token with Pushover; on success, the user's devices. */
export async function validatePushover(
  keys: { user: string; token: string },
  fetchImpl: Fetch = fetch,
): Promise<{ ok: true; devices: string[] } | { ok: false; error: string }> {
  const answer = await post(PUSHOVER_VALIDATE_URL, new URLSearchParams({ token: keys.token, user: keys.user }), fetchImpl);
  if (!answer.ok) return answer;
  const devices = isRecord(answer.body) && Array.isArray(answer.body.devices) ? answer.body.devices.filter((item) => typeof item === 'string') : [];
  return { ok: true, devices };
}

async function post(url: string, body: URLSearchParams, fetchImpl: Fetch): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      // Not JSON: the status says enough.
    }
    if (response.ok) return { ok: true, body: answer };
    // Pushover explains a refusal in `errors`; the request, with the keys, is never repeated.
    const errors = isRecord(answer) && Array.isArray(answer.errors) ? answer.errors.filter((item) => typeof item === 'string') : [];
    return { ok: false, error: `Pushover answered ${response.status}${errors.length === 0 ? '' : `: ${errors.join('; ')}`}` };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** The pusher of `[push]`, or undefined when it has no Pushover keys. */
export function createPusher(config: PushConfig, log: Logger, fetchImpl: Fetch = fetch): Pusher | undefined {
  if (!config.enabled) return undefined;
  return async (message) => {
    const result = await sendPushover(config, message, fetchImpl);
    if (result.ok) log.info('push sent', { title: message.title });
    else log.warn('push failed', { error: result.error });
  };
}

/** What `check` says about `[push]`. */
export function describePush(config: PushConfig): string {
  if (!config.enabled) return 'off: set pushover_user and pushover_token in [push] to get pushes';
  const what = { tasks: 'scheduled tasks', notify: 'everything sent to you', alerts: 'service alerts' };
  const sends = config.send.length === 0 ? 'nothing (push.send is empty)' : config.send.map((kind) => what[kind]).join(', ');
  return `Pushover, for ${sends}; priority ${config.priority}${config.sound === '' ? '' : `, sound ${config.sound}`}`;
}

/** How `push-setup` talks to the person; replaced in tests. */
export interface SetupIo {
  ask: (question: string, options?: { secret?: boolean }) => Promise<string>;
  write: (line: string) => void;
}

/**
 * `agentic-whatsapp push-setup`: asks for the Pushover user key and API token, checks them with
 * Pushover, writes them to [push] and sends a test push. Nothing is written unless Pushover
 * accepts them. Returns whether it saved them.
 */
export async function pushSetup(config: Config, io: SetupIo, fetchImpl: Fetch = fetch): Promise<boolean> {
  io.write('Pushover sends what Ane tells you to your phone, with the Pushover app signed in there.');
  io.write('Your user key is at the top of https://pushover.net once you sign in.');
  io.write('For the API token, create an application, named after Ane for example, at https://pushover.net/apps/build.');
  const user = await askKey(io, 'user key', config.push.user, false);
  if (user === undefined) return false;
  const token = await askKey(io, 'API token', config.push.token, true);
  if (token === undefined) return false;

  const valid = await validatePushover({ user, token }, fetchImpl);
  if (!valid.ok) {
    io.write(`Pushover refused them, nothing was saved: ${valid.error}`);
    return false;
  }
  io.write(`Pushover accepted them${valid.devices.length === 0 ? '' : `; your devices: ${valid.devices.join(', ')}`}.`);
  const { paths } = config;
  const file = new ConfigFile({ configFile: paths.configFile, stateDir: paths.stateDir, logDir: paths.logDir }, join(paths.stateDir, 'config-history'));
  const saved = await file.updatePushKeys({ user, token });
  io.write(`Saved in [push] of ${file.file}.`);

  const sent = await sendPushover(saved.push, { title: saved.agent.name, text: 'Pushes from agentic-whatsapp reach you.' }, fetchImpl);
  io.write(sent.ok ? 'Sent a test push: check your phone.' : `The test push failed: ${sent.error}`);
  io.write(`Now: ${describePush(saved.push)}. push.send in the config file sets what goes as a push.`);
  io.write('Restart the agent to use them: agentic-whatsapp restart');
  return true;
}

/** Asks for a key until it looks like one; Enter keeps the current one. Undefined after 3 tries. */
async function askKey(io: SetupIo, name: string, current: string, secret: boolean): Promise<string | undefined> {
  const keep = current === '' ? '' : ` (Enter keeps the one ending in ${current.slice(-4)})`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await io.ask(`${name.charAt(0).toUpperCase()}${name.slice(1)}${keep}: `, { secret })).trim();
    if (answer === '' && current !== '') return current;
    if (PUSHOVER_KEY.test(answer)) return answer;
    io.write(`A Pushover ${name} is 30 letters and digits.`);
  }
  io.write('Nothing was saved.');
  return undefined;
}

function cut(text: string, max: number): string {
  // By characters, so an emoji is never split.
  const characters = [...text.trim()];
  return characters.length <= max ? characters.join('') : `${characters.slice(0, max - 1).join('')}…`;
}
