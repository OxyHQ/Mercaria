/**
 * Integration test for the token-free channel-key ingest router
 * (`/channels/ingest/...`).
 *
 * Spins up a real Express app with the router mounted, exercising the REAL
 * middleware chain (`makeRateLimiter('channels')` → `requireChannelKey` → zod
 * validation → the key-ingest controller). `channel-key.service.verifyKey` is
 * stubbed to model different key states (unknown, store-scoped, connection-bound)
 * and `channel-ingest.service` is mocked so the store/connection resolution +
 * push-in enforcement it performs are simulated per-connection.
 *
 * Asserts: a missing/invalid key is 401; a store-scoped key ingests (200) with
 * the store id taken from the KEY (never the client); a connection-bound key is
 * 403 for any other connection and 200 for its own; a non-push-in connection is
 * rejected (400) and a foreign connection is 404 (both surfaced from the service
 * through the key path); and malformed bodies/params are 400.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MercariaError } from '../../lib/errors/error-codes.js';

const STORE_ID = 'store-1';
const CONNECTION_ID = '1'.repeat(24);
const OTHER_CONNECTION_ID = '2'.repeat(24);
const PUSH_IN_KEY = 'mck_store';
const BOUND_KEY = 'mck_bound';
const NON_PUSH_IN_CONNECTION = '3'.repeat(24);
const FOREIGN_CONNECTION = '4'.repeat(24);

// verifyKey: recognizes two keys; everything else is unknown (→ null → 401).
vi.mock('../../services/channel-key.service.js', () => ({
  verifyKey: vi.fn((raw: string) => {
    if (raw === PUSH_IN_KEY) return Promise.resolve({ keyId: 'k1', storeId: STORE_ID });
    if (raw === BOUND_KEY)
      return Promise.resolve({ keyId: 'k2', storeId: STORE_ID, connectionId: CONNECTION_ID });
    return Promise.resolve(null);
  }),
}));

// ingestProducts/ingestInventory: model the service's store+push-in resolution.
// A non-push-in connection throws a 400; a foreign connection throws a 404.
vi.mock('../../services/channel-ingest.service.js', () => {
  const resolve = (connectionId: string) => {
    if (connectionId === NON_PUSH_IN_CONNECTION) {
      throw new MercariaError({ code: 'VALIDATION_ERROR', message: 'Connection is not a push-in channel' });
    }
    if (connectionId === FOREIGN_CONNECTION) {
      throw new MercariaError({ code: 'NOT_FOUND', message: 'Connection not found' });
    }
  };
  return {
    ingestProducts: vi.fn((_storeId: string, connectionId: string) => {
      resolve(connectionId);
      return Promise.resolve({ results: [] });
    }),
    ingestInventory: vi.fn((_storeId: string, connectionId: string) => {
      resolve(connectionId);
      return Promise.resolve({ results: [] });
    }),
  };
});
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, auth: { error: vi.fn() } },
}));
// The rate limiter is not under test here; a passthrough keeps the test off the
// network (the real limiter runs an optional Oxy token resolve).
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

import channelsIngestRouter from '../channels-ingest.js';
import { ingestProducts } from '../../services/channel-ingest.service.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/channels/ingest', channelsIngestRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const validProducts = {
  products: [
    { externalId: 'woo-1', title: 'T', variants: [{ price: { amount: 100, currency: 'EUR' } }] },
  ],
};
const validInventory = { items: [{ externalId: 'woo-1', available: 3 }] };

async function post(
  path: string,
  auth: { bearer?: string; header?: string } | null,
  body: unknown,
): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth?.header) headers['x-mercaria-channel-key'] = auth.header;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.status;
}

describe('channel-key ingest — authentication', () => {
  it('401s when no key is presented', async () => {
    expect(await post(`/channels/ingest/${CONNECTION_ID}/products`, null, validProducts)).toBe(401);
  });

  it('401s an unknown / invalid key', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/products`, { bearer: 'mck_nope' }, validProducts),
    ).toBe(401);
  });

  it('accepts the key via the X-Mercaria-Channel-Key header', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/products`, { header: PUSH_IN_KEY }, validProducts),
    ).toBe(200);
  });
});

describe('channel-key ingest — a store-scoped key', () => {
  it('ingests products, using the store id from the KEY', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/products`, { bearer: PUSH_IN_KEY }, validProducts),
    ).toBe(200);
    expect(ingestProducts).toHaveBeenCalledWith(STORE_ID, CONNECTION_ID, expect.anything());
  });

  it('ingests inventory', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/inventory`, { bearer: PUSH_IN_KEY }, validInventory),
    ).toBe(200);
  });
});

describe('channel-key ingest — a connection-bound key', () => {
  it('200s for its own connection', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/products`, { bearer: BOUND_KEY }, validProducts),
    ).toBe(200);
  });

  it('403s for any other connection', async () => {
    expect(
      await post(`/channels/ingest/${OTHER_CONNECTION_ID}/products`, { bearer: BOUND_KEY }, validProducts),
    ).toBe(403);
  });
});

describe('channel-key ingest — service rejections surface through the key path', () => {
  it('400s a non-push-in connection', async () => {
    expect(
      await post(`/channels/ingest/${NON_PUSH_IN_CONNECTION}/products`, { bearer: PUSH_IN_KEY }, validProducts),
    ).toBe(400);
  });

  it('404s a foreign / missing connection', async () => {
    expect(
      await post(`/channels/ingest/${FOREIGN_CONNECTION}/products`, { bearer: PUSH_IN_KEY }, validProducts),
    ).toBe(404);
  });
});

describe('channel-key ingest — validation', () => {
  it('400s a malformed connection id', async () => {
    expect(
      await post('/channels/ingest/not-an-objectid/products', { bearer: PUSH_IN_KEY }, validProducts),
    ).toBe(400);
  });

  it('400s an empty products batch', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/products`, { bearer: PUSH_IN_KEY }, { products: [] }),
    ).toBe(400);
  });

  it('400s a negative inventory quantity', async () => {
    expect(
      await post(`/channels/ingest/${CONNECTION_ID}/inventory`, { bearer: PUSH_IN_KEY }, {
        items: [{ externalId: 'woo-1', available: -1 }],
      }),
    ).toBe(400);
  });
});
