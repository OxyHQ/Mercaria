/**
 * Integration test for the channel-ingest router's authorization + validation.
 *
 * Spins up a real Express app with the ingest sub-router mounted behind a stub
 * that injects a store membership of a chosen role (standing in for
 * `authenticateToken` + `loadStore`). The `channel-ingest.service` is mocked, so
 * the test exercises the REAL middleware chain (`makeRateLimiter('channels')` →
 * `requireStorePermission('channels:write')` → zod body validation) without a DB.
 *
 * Asserts staff are blocked (403) on every ingest route, a non-member is blocked
 * (403), admins pass the guard and reach the (mocked) service (200), and the zod
 * schemas reject malformed bodies (400). A literal 401 (missing Oxy token) is
 * enforced upstream by `authenticateToken` at the `/admin` root and is not part of
 * this sub-router.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StoreRole } from '@mercaria/shared-types';

vi.mock('../../../services/channel-ingest.service.js', () => ({
  isKnownConnectorProvider: (id: string) =>
    ['shopify', 'woocommerce', 'etsy', 'prestashop', 'magento'].includes(id),
  connectPushIn: vi.fn().mockResolvedValue({ _id: '1'.repeat(24), storeId: '0'.repeat(24) }),
  ingestProducts: vi.fn().mockResolvedValue({ results: [] }),
  ingestInventory: vi.fn().mockResolvedValue({ results: [] }),
}));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import channelIngestRouter from '../channel-ingest.js';

const STORE_ID = '0'.repeat(24);
const CONNECTION_ID = '1'.repeat(24);
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stub upstream auth + loadStore: role comes from an `x-role` header; the
  // special role `none` injects NO membership (a non-member of the store).
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    const role = req.headers['x-role'] as StoreRole | 'none' | undefined;
    req.store = { _id: STORE_ID } as unknown as typeof req.store;
    if (role !== 'none') {
      req.storeMembership = {
        oxyUserId: 'user-1',
        role: (role ?? 'staff') as StoreRole,
        permissions: [],
        joinedAt: new Date(),
      };
    }
    next();
  });
  app.use('/', channelIngestRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function call(
  path: string,
  role: StoreRole | 'none',
  body?: unknown,
): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'x-role': role, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
  return res.status;
}

const validProducts = {
  products: [{ externalId: 'woo-1', title: 'T', variants: [{ price: { amount: 100, currency: 'EUR' } }] }],
};
const validInventory = { items: [{ externalId: 'woo-1', available: 3 }] };

describe('channel-ingest authz — staff lack channels:write (403)', () => {
  it('403s staff on connect-push', async () => {
    expect(await call('/woocommerce/connect-push', 'staff', { shopDomain: 'shop.example.com' })).toBe(403);
  });
  it('403s staff on ingest products', async () => {
    expect(await call(`/${CONNECTION_ID}/ingest/products`, 'staff', validProducts)).toBe(403);
  });
  it('403s staff on ingest inventory', async () => {
    expect(await call(`/${CONNECTION_ID}/ingest/inventory`, 'staff', validInventory)).toBe(403);
  });
});

describe('channel-ingest authz — a non-member is blocked (403)', () => {
  it('403s a non-member on ingest products', async () => {
    expect(await call(`/${CONNECTION_ID}/ingest/products`, 'none', validProducts)).toBe(403);
  });
});

describe('channel-ingest authz — admins pass the guard (200)', () => {
  it('lets an admin connect-push (reaches the mocked service)', async () => {
    expect(await call('/woocommerce/connect-push', 'admin', { shopDomain: 'shop.example.com' })).toBe(200);
  });
  it('lets an admin ingest products', async () => {
    expect(await call(`/${CONNECTION_ID}/ingest/products`, 'admin', validProducts)).toBe(200);
  });
  it('lets an admin ingest inventory', async () => {
    expect(await call(`/${CONNECTION_ID}/ingest/inventory`, 'admin', validInventory)).toBe(200);
  });
});

describe('channel-ingest validation (admin, past the guard)', () => {
  it('404s an unknown provider on connect-push', async () => {
    expect(await call('/bigcommerce/connect-push', 'admin', {})).toBe(404);
  });
  it('400s an empty products batch', async () => {
    expect(await call(`/${CONNECTION_ID}/ingest/products`, 'admin', { products: [] })).toBe(400);
  });
  it('400s a product variant with an unsupported currency', async () => {
    expect(
      await call(`/${CONNECTION_ID}/ingest/products`, 'admin', {
        products: [{ externalId: 'x', title: 'T', variants: [{ price: { amount: 1, currency: 'XYZ' } }] }],
      }),
    ).toBe(400);
  });
  it('400s an invalid connectionId', async () => {
    expect(await call('/not-an-objectid/ingest/products', 'admin', validProducts)).toBe(400);
  });
  it('400s an inventory item with a negative available', async () => {
    expect(
      await call(`/${CONNECTION_ID}/ingest/inventory`, 'admin', {
        items: [{ externalId: 'woo-1', available: -1 }],
      }),
    ).toBe(400);
  });
});
