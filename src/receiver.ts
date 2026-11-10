import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from './log.js';
import { errorMessage } from './util.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** The X-Wacli-Signature value wacli computes for a body. */
export function signPayload(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(signPayload(secret, body));
  const received = Buffer.from(header.trim());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface ReceiverOptions {
  host: string;
  /** 0 picks a free port. */
  port: number;
  secret: string;
  path?: string;
  onEvent: (payload: unknown) => void;
  log: Logger;
}

export interface Receiver {
  url: string;
  close(): Promise<void>;
}

/** HTTP endpoint for `wacli sync --webhook`. Only signed payloads reach `onEvent`. */
export function startReceiver(options: ReceiverOptions): Promise<Receiver> {
  const path = options.path ?? '/wacli';
  const { log } = options;

  const server = createServer((request, response) => {
    if (request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        response.writeHead(413, { Connection: 'close' }).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      const body = Buffer.concat(chunks);
      const signature = request.headers['x-wacli-signature'];
      if (!verifySignature(options.secret, body, typeof signature === 'string' ? signature : undefined)) {
        log.warn('rejected a webhook call with an invalid signature');
        response.writeHead(401).end();
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(204).end();
      try {
        options.onEvent(payload);
      } catch (error) {
        log.error('could not handle a webhook event', { error: errorMessage(error) });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const { port } = server.address() as AddressInfo;
      const host = options.host.includes(':') ? `[${options.host}]` : options.host;
      resolve({
        url: `http://${host}:${port}${path}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
