/** Exercise the real admin HTTP entry point: filtering must precede pagination/counting. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { stores } from '../../db/schema/stores.js';

const RUN = uuidv7().slice(-12);
const OWNER = `product-filters-${RUN}`;
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = OWNER; req.accessToken = 'fixture-bearer'; next();
  },
  optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  oxyClient: {},
}));
vi.mock('../../services/oxy-account-graph.js', () => ({
  readCallerAccountRole: async (_bearer: string, account: string) => account === OWNER ? 'admin' : null,
  listCallerAccountRoles: async () => new Map([[OWNER, 'admin']]),
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  makeActorRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
let db: Database;
let close: () => Promise<void>;
let server: Server;
let base: string;
const storeIds: string[] = [];
const listingIds: string[] = [];
let target: string;
let draft: string;

beforeAll(async () => {
  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres(); close = postgres.closePostgres;
  for (const [index, owner] of [OWNER, `${OWNER}-other`].entries()) {
    const [store] = await db.insert(stores).values({ oxyAccountId: owner, handle: `filters-${RUN}-${index}`, name: 'Filters test', description: '', brandColor: '#000000' }).returning({ id: stores.id });
    storeIds.push(store.id);
  }
  for (const input of [
    { storeId: storeIds[0], title: 'Alpine jacket', status: 'active' as const, createdAt: new Date('2020-01-01') },
    { storeId: storeIds[0], title: 'Alpine draft', status: 'draft' as const },
    { storeId: storeIds[1], title: 'Alpine foreign', status: 'active' as const },
    ...Array.from({ length: 22 }, (_, i) => ({ storeId: storeIds[0], title: `Ordinary shirt ${i}`, status: 'draft' as const })),
  ]) {
    const [row] = await db.insert(listings).values({ ownerType: 'store', condition: 'new', conditionAssertion: 'seller_declared', description: '', ...input }).returning({ id: listings.id });
    listingIds.push(row.id);
  }
  [target, draft] = listingIds;
  const { createApp } = await import('../../app.js');
  server = await new Promise<Server>(resolve => { const listening = createApp().listen(0, () => resolve(listening)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 300_000);
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (listingIds.length) await db.delete(listings).where(inArray(listings.id, listingIds));
  if (storeIds.length) await db.delete(stores).where(inArray(stores.id, storeIds));
  if (close) await close();
});
async function read(query: string, store = storeIds[0]) {
  const reply = await fetch(`${base}/admin/stores/${store}/products?${query}`);
  return { status: reply.status, body: await reply.json() as { data: { id: string }[]; pagination: { total: number; pages: number } } };
}
describe('admin product search/status', () => {
  it('finds an older product outside the first page and counts the filtered set', async () => {
    const all = await read('page=1&limit=20');
    expect(all.status).toBe(200); expect(all.body.data).toHaveLength(20);
    expect(all.body.data.map(row => row.id)).not.toContain(target);
    const result = await read('search=Alpine&limit=20');
    expect(result.status).toBe(200);
    expect(result.body.data.map(row => row.id).sort()).toEqual([target, draft].sort());
    expect(result.body.pagination).toMatchObject({ total: 2, pages: 1 });
  });
  it('intersects search and status within the authorized store', async () => {
    const result = await read('search=%20Alpine%20&status=active');
    expect(result.status).toBe(200);
    expect(result.body.data.map(row => row.id)).toEqual([target]);
    expect(result.body.pagination.total).toBe(1);
    const draftResult = await read('search=Alpine&status=draft');
    expect(draftResult.body.data.map(row => row.id)).toEqual([draft]);
    expect(draftResult.body.pagination.total).toBe(1);
    expect((await read('search=Alpine', storeIds[1])).status).toBe(403);
  });
  it('distinguishes no matches from an unfiltered catalogue', async () => {
    const result = await read('search=Impossibleword&status=active');
    expect(result.status).toBe(200); expect(result.body.data).toEqual([]);
    expect(result.body.pagination.total).toBe(0);
  });
  it.each(['status=unknown', 'status=active&status=draft', 'search=a&search=b', `search=${'a'.repeat(201)}`])('refuses malformed filters: %s', async query => {
    expect((await read(query)).status).toBe(400);
  });
});
