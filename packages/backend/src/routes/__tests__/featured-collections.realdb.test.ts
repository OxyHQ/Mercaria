import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { uuidv7 } from '@oxy.so/db';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertCollection } from '../../db/merchandising/collectionRepository.js';
import { resetStoreAccessCacheForTests } from '../../services/store-access.service.js';
import { loadStore } from '../../middleware/store-authz.js';
import collectionRoutes from '../admin/collections.js';

const authority = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'viewer' | null }));
vi.mock('../../services/oxy-account-graph.js', () => ({
  readCallerAccountRole: async () => authority.role,
  listCallerAccountRoles: async () => [],
}));

const app = express();
app.use(express.json());
// Test-only foreground authentication stand-in. All store authorization,
// permissions, validation, controller and database writes below are real.
app.use((req, _res, next) => {
  if (req.headers.authorization === 'Bearer foreground-fixture') {
    req.userId = 'featured-fixture-operator';
    req.accessToken = 'foreground-fixture';
  }
  next();
});
app.use('/admin/stores/:storeId/collections', loadStore, collectionRoutes);
let server: Server;
let base: string;
async function call(method: string, body?: unknown, authenticated = true) {
  const response = await fetch(`${base}${path()}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: 'Bearer foreground-fixture' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
let storeId: string;
let collectionId: string;
beforeAll(async () => {
  await connectPostgres();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  base = `http://127.0.0.1:${address.port}`;
  const store = await insertStore({
    oxyAccountId: 'featured-fixture-account',
    handle: uuidv7(),
    name: 'Shop',
    description: '',
    brandColor: '#000000',
    defaultCurrency: 'EUR',
  });
  storeId = store.id;
  collectionId = (
    await insertCollection(
      store.id,
      { title: 'Curated', handle: 'curated', type: 'manual', isPublished: true },
      [],
    )
  ).id;
});
beforeEach(() => {
  authority.role = 'owner';
  resetStoreAccessCacheForTests();
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestStores(getDb(), [storeId]);
  await closePostgres();
});
const path = () => `/admin/stores/${storeId}/collections/featured`;

describe('featured collection authoring HTTP authority', () => {
  it('uses current canonical account permission and preserves the ordered response', async () => {
    const result = await call('PUT', { collectionIds: [collectionId] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { collectionIds: [collectionId] } });
    const read = await call('GET');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ data: { collectionIds: [collectionId] } });
  });
  it('refuses anonymous and revoked actors, and viewer writes', async () => {
    expect((await call('PUT', { collectionIds: [] }, false)).status).toBe(401);
    authority.role = null;
    expect((await call('PUT', { collectionIds: [] })).status).toBe(403);
    authority.role = 'viewer';
    resetStoreAccessCacheForTests();
    expect((await call('PUT', { collectionIds: [] })).status).toBe(403);
  });
  it('rejects duplicate, oversized and unknown body fields instead of accepting a partial selection', async () => {
    for (const body of [
      { collectionIds: [collectionId, collectionId] },
      { collectionIds: Array.from({ length: 7 }, () => uuidv7()) },
      { collectionIds: [], oxyAccountId: 'another-owner' },
    ]) {
      expect((await call('PUT', body)).status).toBe(400);
    }
  });
});
