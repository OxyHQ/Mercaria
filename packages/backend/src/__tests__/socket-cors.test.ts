/**
 * The socket server admits exactly the browsers the HTTP CORS layer admits —
 * `createOxySocketCors` over the ONE origin list in `lib/allowed-origins.ts` —
 * on BOTH transports: `cors` for long-polling, and `allowRequest`, the only
 * check a WebSocket upgrade gets. A handshake with no Origin (a native app) is
 * not a browser cross-origin request and is admitted; `middleware.socket()`
 * authenticates every connection either way.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  oxyClient: { middleware: { socket: () => (_socket: unknown, next: () => void) => next() } },
}));
vi.mock('../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../lib/redis.js', () => ({ getSocketAdapterClients: () => null }));
vi.mock('../db/stores/storeRepository.js', () => ({ findStoreById: vi.fn() }));

const { initSocket } = await import('../socket.js');

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer();
  initSocket(server);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function handshake(origin?: string): Promise<Response> {
  return fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: origin === undefined ? {} : { Origin: origin },
  });
}

describe('socket origins', () => {
  it('admits an allowed browser origin, echoed exactly and not credentialed', async () => {
    const res = await handshake('https://dashboard.mercaria.co');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dashboard.mercaria.co');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('refuses the handshake from any other browser origin', async () => {
    const res = await handshake('https://evil.example');
    expect(res.status).toBe(403);
  });

  it('admits a client that sends no Origin (a native app)', async () => {
    expect((await handshake()).status).toBe(200);
  });
});
