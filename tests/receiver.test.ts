import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { type Receiver, signPayload, startReceiver, verifySignature } from '../src/receiver.js';

const SECRET = 'test-secret';

describe('webhook signatures', () => {
  it('matches the format wacli sends', () => {
    expect(signPayload(SECRET, '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('accepts the right signature and rejects anything else', () => {
    const body = Buffer.from('{"ID":"1"}');
    expect(verifySignature(SECRET, body, signPayload(SECRET, body))).toBe(true);
    expect(verifySignature(SECRET, body, signPayload('other-secret', body))).toBe(false);
    expect(verifySignature(SECRET, body, 'sha256=short')).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
  });
});

describe('startReceiver', () => {
  let receiver: Receiver | undefined;
  const events: unknown[] = [];

  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
    events.length = 0;
  });

  const start = async () => {
    receiver = await startReceiver({
      host: '127.0.0.1',
      port: 0,
      secret: SECRET,
      onEvent: (payload) => events.push(payload),
      log: silentLogger,
    });
    return receiver.url;
  };

  const post = (url: string, body: string, signature?: string) =>
    fetch(url, {
      method: 'POST',
      body,
      headers: signature === undefined ? {} : { 'X-Wacli-Signature': signature },
    });

  it('listens on localhost and delivers signed payloads', async () => {
    const url = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wacli$/);
    const body = JSON.stringify({ ID: 'ABC', Chat: '1@s.whatsapp.net' });
    const response = await post(url, body, signPayload(SECRET, body));
    expect(response.status).toBe(204);
    expect(events).toEqual([{ ID: 'ABC', Chat: '1@s.whatsapp.net' }]);
  });

  it('rejects unsigned and badly signed payloads', async () => {
    const url = await start();
    expect((await post(url, '{}')).status).toBe(401);
    expect((await post(url, '{}', signPayload('wrong', '{}'))).status).toBe(401);
    expect(events).toHaveLength(0);
  });

  it('rejects invalid JSON, other paths and other methods', async () => {
    const url = await start();
    expect((await post(url, 'not json', signPayload(SECRET, 'not json'))).status).toBe(400);
    expect((await fetch(url.replace('/wacli', '/other'), { method: 'POST' })).status).toBe(404);
    expect((await fetch(url)).status).toBe(405);
    expect(events).toHaveLength(0);
  });
});
