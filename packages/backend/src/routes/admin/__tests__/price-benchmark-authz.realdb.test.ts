/**
 * `/admin/stores/:storeId/price-analytics/*` — the permission, then the plan,
 * against a REAL server.
 *
 * The router is mounted on a real Express app behind a stub standing in for
 * `authenticateToken` + `loadStore` (the role comes from a test header), and
 * everything after it is real: `requireStorePermission('analytics:read')`, the
 * entitlement resolution behind `requireCapability`, and the analytics read.
 *
 *  - a member without `analytics:read` is refused 403 FORBIDDEN, and is told
 *    nothing about the store's plan;
 *  - a member with it, on a store whose plan lacks the tool, is refused 403
 *    PLAN_CAPABILITY_REQUIRED on EVERY route, the export included;
 *  - an entitled store gets the report, the CSV and the trend;
 *  - a store cannot read the trend of another store's listing (404).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { STORE_ROLE_PERMISSIONS, type StoreAccountRole } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { stores } from '../../../db/schema/stores.js';
import { listings, productVariants } from '../../../db/schema/catalog.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import { entitlementGrants } from '../../../db/schema/merchantPlans.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { declaredOfferCondition } from '../../../services/condition/condition-mapping.service.js';
import { entitleStoreForTest } from '../../../services/entitlements/__tests__/entitle-store.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import priceAnalyticsRouter from '../price-benchmark.js';

const RUN = uuidv7().slice(-12);
const DAY = 24 * 60 * 60 * 1_000;

let db: Database;
let server: Server;
let baseUrl: string;

const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

let entitledStore: string;
let unentitledStore: string;
let entitledVariant: string;
let otherStoreVariant: string;

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `spa-authz-${label}-${RUN}`,
      name: `Price analytics authz ${label}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('no store');
  createdStoreIds.push(row.id);
  return row.id;
}

/** A listing with a native offer on a fresh canonical variant; returns the product variant id. */
async function mintMatchedListing(storeId: string, label: string): Promise<string> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Authz product ${label} ${RUN}`,
      normalizedName: `authz product ${label} ${RUN}`,
      slug: `authz-product-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('no product');
  createdProductIds.push(product.id);
  const [canonical] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!canonical) throw new Error('no canonical variant');
  createdVariantIds.push(canonical.id);

  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: `Authz listing ${label} ${RUN}`,
      description: 'under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('no listing');
  createdListingIds.push(listing.id);
  const [variant] = await db
    .insert(productVariants)
    .values({ listingId: listing.id, priceAmount: 2_500, priceCurrency: 'EUR' })
    .returning({ id: productVariants.id });
  if (!variant) throw new Error('no variant');
  const now = new Date();
  await db.insert(offers).values({
    kind: 'native',
    status: 'active',
    ...declaredOfferCondition('new'),
    canonicalVariantId: canonical.id,
    productVariantId: variant.id,
    listingId: listing.id,
    priceAmount: 2_500,
    priceCurrency: 'EUR',
    availability: 'in_stock',
    observedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    staleAt: new Date(now.getTime() + DAY),
  });
  return variant.id;
}

beforeAll(async () => {
  db = await connectPostgres();
  entitledStore = await mintStore('entitled');
  unentitledStore = await mintStore('plain');
  await entitleStoreForTest(db, {
    storeId: entitledStore,
    capability: 'competitive_price_analytics',
  });
  entitledVariant = await mintMatchedListing(entitledStore, 'entitled');
  otherStoreVariant = await mintMatchedListing(unentitledStore, 'plain');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = (req.headers['x-role'] as StoreAccountRole | undefined) ?? 'owner';
    const storeId = req.headers['x-store'] as string;
    req.userId = 'user-1';
    req.store = { id: storeId } as unknown as typeof req.store;
    req.storeAccess = { role, permissions: [...STORE_ROLE_PERMISSIONS[role]] };
    next();
  });
  app.use('/', priceAnalyticsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));
  await db
    .delete(entitlementGrants)
    .where(inArray(entitlementGrants.storeId, safeIds(createdStoreIds)));
  await deleteTestStores(db, safeIds(createdStoreIds));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await closePostgres();
});

async function call(
  path: string,
  storeId: string,
  role: StoreAccountRole = 'owner',
): Promise<{ status: number; type: string; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-role': role, 'x-store': storeId },
  });
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    body: await res.text(),
  };
}

function errorCode(body: string): string | undefined {
  // `sendError`'s envelope: `{ success: false, error: <code>, message }`.
  const parsed = JSON.parse(body) as { error?: string };
  return parsed.error;
}

describe('the permission comes first', () => {
  it('refuses a role without analytics:read, and says nothing about the plan', async () => {
    for (const role of ['viewer', 'editor', 'developer'] as const) {
      expect(STORE_ROLE_PERMISSIONS[role]).not.toContain('analytics:read');
      const result = await call('/listings', entitledStore, role);
      expect(result.status, role).toBe(403);
      expect(errorCode(result.body)).toBe(ErrorCodes.FORBIDDEN);
    }
  });

  it('admits owner, admin and billing on an entitled store', async () => {
    for (const role of ['owner', 'admin', 'billing'] as const) {
      expect((await call('/listings', entitledStore, role)).status, role).toBe(200);
    }
  });
});

describe('then the plan', () => {
  it('refuses every route for a store whose plan lacks the tool', async () => {
    for (const path of [
      '/listings',
      '/listings?format=csv',
      `/listings/${otherStoreVariant}/trend`,
    ]) {
      const result = await call(path, unentitledStore);
      expect(result.status, path).toBe(403);
      expect(errorCode(result.body), path).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    }
  });

  it('serves the report, the CSV and the trend to an entitled store', async () => {
    const json = await call('/listings', entitledStore);
    expect(json.status).toBe(200);
    const parsed = JSON.parse(json.body) as { data: { rows: { productVariantId: string }[] } };
    expect(parsed.data.rows.map((row) => row.productVariantId)).toEqual([entitledVariant]);

    const csv = await call('/listings?format=csv', entitledStore);
    expect(csv.status).toBe(200);
    expect(csv.type).toContain('text/csv');
    expect(csv.body.split('\n')).toHaveLength(2);

    const trend = await call(
      `/listings/${entitledVariant}/trend?windowDays=90&granularity=week`,
      entitledStore,
    );
    expect(trend.status).toBe(200);
  });

  it('refuses a malformed query rather than guessing', async () => {
    expect(
      (await call(`/listings/${entitledVariant}/trend?windowDays=45`, entitledStore)).status,
    ).toBe(400);
    expect((await call('/listings?price=1', entitledStore)).status).toBe(400);
  });

  it("cannot read another store's listing", async () => {
    const result = await call(`/listings/${otherStoreVariant}/trend`, entitledStore);
    expect(result.status).toBe(404);
  });
});
