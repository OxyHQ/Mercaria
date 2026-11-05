/**
 * The merchandising rules' HTTP surfaces against a real server (#89,
 * `advanced_merchandising_rules`): who may author a rule, what the plan refuses
 * and with which code, and what the PUBLIC store page reads — including the
 * fallback when the store loses the tool and the free by-id hydration.
 *
 * Store authority, permissions, validation, the plan gate, the controllers and
 * every database write are real; only the foreground session is a stand-in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { listings } from '../../db/schema/catalog.js';
import { entitlementGrants, entitlementUsageCounters } from '../../db/schema/merchantPlans.js';
import { revokeEntitlementGrant } from '../../db/merchantPlans/grantRepository.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { loadStore } from '../../middleware/store-authz.js';
import { entitleStoreForTest } from '../../services/entitlements/__tests__/entitle-store.js';
import { invalidateMerchantEntitlements } from '../../services/entitlements/resolve.js';
import merchandisingRoutes from '../admin/merchandising.js';
import storeMerchandisingRoutes from '../store-merchandising.js';
import storesRoutes from '../stores.js';

const authority = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'viewer' | null }));
vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../middleware/auth.js')>();
  const { overOxyClient } = await import('../../__tests__/over-oxy-client.js');
  const { fakeAccountAccess } = await import('../../__tests__/oxy-account-access-fake.js');
  return {
    ...original,
    oxyClient: overOxyClient(
      original.oxyClient,
      fakeAccountAccess(
        async () => authority.role,
        async () => new Map(),
      ),
    ),
  };
});

const app = express();
app.use(express.json());
// Test-only foreground authentication stand-in.
app.use((req, _res, next) => {
  if (req.headers.authorization === 'Bearer foreground-fixture') {
    req.userId = 'merchandising-fixture-operator';
    req.accessToken = 'foreground-fixture';
    req.sessionId = 'test-session';
  }
  next();
});
app.use('/admin/stores/:storeId/merchandising', loadStore, merchandisingRoutes);
app.use('/stores/:handle/merchandising', storeMerchandisingRoutes);
app.use('/stores', storesRoutes);

let server: Server;
let base: string;
let storeId: string;
let handle: string;
let unentitledStoreId: string;
let listingA: string;
let listingB: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
  authenticated = true,
): Promise<{ status: number; body: { data?: unknown; error?: string } & Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: 'Bearer foreground-fixture' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { data?: unknown; error?: string } & Record<string, unknown>,
  };
}

async function makeStore(label: string): Promise<{ id: string; handle: string }> {
  const suffix = uuidv7();
  const store = await insertStore({
    oxyAccountId: 'merchandising-fixture-account',
    handle: `merch-route-${label}-${suffix}`,
    name: 'Shop',
    description: '',
    brandColor: '#000000',
    defaultCurrency: 'EUR',
  });
  return { id: store.id, handle: store.handle };
}

async function makeListing(id: string, title: string, publishedAgoMs: number): Promise<string> {
  const [row] = await getDb()
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: id,
      title,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      publishedAt: new Date(Date.now() - publishedAgoMs),
      hasInventory: true,
    })
    .returning({ id: listings.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  base = `http://127.0.0.1:${address.port}`;
  const store = await makeStore('a');
  storeId = store.id;
  handle = store.handle;
  unentitledStoreId = (await makeStore('none')).id;
  // B is newer, so the free newest-first order is [B, A].
  listingA = await makeListing(storeId, 'A', 2 * 60 * 60 * 1000);
  listingB = await makeListing(storeId, 'B', 60 * 60 * 1000);
  await entitleStoreForTest(getDb(), {
    storeId,
    capability: 'advanced_merchandising_rules',
    limit: 1,
  });
});

beforeEach(() => {
  authority.role = 'owner';
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const ids = [storeId, unentitledStoreId];
  const db = getDb();
  await db.delete(listings).where(inArray(listings.storeId, ids));
  await db.delete(entitlementUsageCounters).where(inArray(entitlementUsageCounters.storeId, ids));
  await db.delete(entitlementGrants).where(inArray(entitlementGrants.storeId, ids));
  await deleteTestStores(db, ids);
  await closePostgres();
});

const pinA = {
  kind: 'sort',
  title: 'A on top',
  target: 'store',
  sortStrategy: 'newest',
  pinnedListingIds: [] as string[],
};

describe('authoring authority', () => {
  it('refuses anonymous callers, revoked actors and viewer writes; a viewer may read', async () => {
    const rules = `/admin/stores/${storeId}/merchandising/rules`;
    expect((await call('POST', rules, pinA, false)).status).toBe(401);
    authority.role = null;
    expect((await call('GET', rules)).status).toBe(403);
    authority.role = 'viewer';
    expect((await call('POST', rules, pinA)).status).toBe(403);
    expect(
      (await call('POST', `/admin/stores/${storeId}/merchandising/preview`, pinA)).status,
    ).toBe(403);
    const read = await call('GET', rules);
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual([]);
  });

  it('refuses unknown fields rather than stripping them — there is no boost to configure', async () => {
    const rules = `/admin/stores/${storeId}/merchandising/rules`;
    for (const body of [
      { ...pinA, boost: 10 },
      { ...pinA, surface: 'search' },
      { ...pinA, kind: 'ranking' },
      { ...pinA, pinnedListingIds: Array.from({ length: 25 }, () => uuidv7()) },
    ]) {
      expect((await call('POST', rules, body)).status).toBe(400);
    }
  });

  it('answers 403 PLAN_CAPABILITY_REQUIRED for a store without the tool', async () => {
    const created = await call(
      'POST',
      `/admin/stores/${unentitledStoreId}/merchandising/rules`,
      pinA,
    );
    expect(created.status).toBe(403);
    expect(created.body.error).toBe('PLAN_CAPABILITY_REQUIRED');
    // Reading is never gated.
    expect(
      (await call('GET', `/admin/stores/${unentitledStoreId}/merchandising/rules`)).status,
    ).toBe(200);
  });
});

describe('the store page reads what applies, and nothing when the plan ends', () => {
  it('applies a pinned order, answers 403 PLAN_LIMIT_REACHED at the ceiling, and falls back after revocation', async () => {
    const rules = `/admin/stores/${storeId}/merchandising/rules`;

    // Before any rule: nothing applies and the page keeps its free order.
    const empty = await call('GET', `/stores/${handle}/merchandising`, undefined, false);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({
      storeSorted: false,
      sortedCollectionIds: [],
      spotlights: [],
    });

    const created = await call('POST', rules, { ...pinA, pinnedListingIds: [listingA] });
    expect(created.status).toBe(201);
    const rule = created.body.data as { id: string; status: string; applying: boolean };
    expect(rule.status).toBe('live');
    expect(rule.applying).toBe(true);

    const limited = await call('POST', rules, { ...pinA, title: 'Second' });
    expect(limited.status).toBe(403);
    expect(limited.body.error).toBe('PLAN_LIMIT_REACHED');

    const summary = await call('GET', `/stores/${handle}/merchandising`, undefined, false);
    expect(summary.body.data).toMatchObject({ storeSorted: true });
    const page = await call(
      'GET',
      `/stores/${handle}/merchandising/listings?page=1&limit=10`,
      undefined,
      false,
    );
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({
      applied: true,
      listingIds: [listingA, listingB],
      total: 2,
    });

    // The free hydration answers in the order named, store-scoped and active-only.
    const foreign = uuidv7();
    const hydrated = await call(
      'GET',
      `/stores/${handle}/listings?ids=${listingA},${listingB},${foreign}`,
      undefined,
      false,
    );
    expect(hydrated.status).toBe(200);
    expect(
      (hydrated.body.data as { listings: { id: string }[] }).listings.map((l) => l.id),
    ).toEqual([listingA, listingB]);
    expect((await call('GET', `/stores/${handle}/listings`, undefined, false)).status).toBe(400);

    // The plan ends: the page applies nothing; the rule is still there to read.
    const grants = await getDb()
      .select({ id: entitlementGrants.id })
      .from(entitlementGrants)
      .where(eq(entitlementGrants.storeId, storeId));
    for (const grant of grants) {
      await revokeEntitlementGrant(getDb(), {
        id: grant.id,
        revokedByOxyUserId: 'test-operator',
        revocationReason: 'test: the plan ended',
      });
    }
    invalidateMerchantEntitlements(storeId);

    const after = await call('GET', `/stores/${handle}/merchandising`, undefined, false);
    expect(after.body.data).toEqual({
      storeSorted: false,
      sortedCollectionIds: [],
      spotlights: [],
    });
    const fallback = await call(
      'GET',
      `/stores/${handle}/merchandising/listings`,
      undefined,
      false,
    );
    expect(fallback.body.data).toMatchObject({ applied: false, listingIds: [] });
    const kept = await call('GET', rules);
    expect(
      (kept.body.data as { id: string; applying: boolean }[]).map((r) => [r.id, r.applying]),
    ).toEqual([[rule.id, false]]);

    // Editing is the tool's work and is refused; deleting never is.
    const edit = await call('PATCH', `${rules}/${rule.id}`, { title: 'Edited' });
    expect(edit.status).toBe(403);
    expect(edit.body.error).toBe('PLAN_CAPABILITY_REQUIRED');
    expect((await call('DELETE', `${rules}/${rule.id}`)).status).toBe(200);
    expect((await call('GET', rules)).body.data).toEqual([]);
  });

  it('answers 404 for an unknown store handle', async () => {
    expect(
      (await call('GET', `/stores/no-such-store-${uuidv7()}/merchandising`, undefined, false))
        .status,
    ).toBe(404);
  });
});
