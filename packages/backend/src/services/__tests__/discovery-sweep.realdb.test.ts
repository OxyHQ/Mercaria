/**
 * The counting passes and the sweep, against a real server.
 *
 * The arithmetic is the whole point: excluding a status and forgetting one
 * look identical inside a `WHERE`, so each is asserted by a fixture that would
 * move the number if it were wrong. Likewise the ancestor-chain test — a sweep
 * that wrote only the leaf category passes every single-category assertion
 * and fails exactly that one.
 *
 * ## Scoping, because this database is SHARED
 *
 * `countListingSales`/`countListingViews` read `order_items`/`analytics_events`
 * GLOBALLY (no category scope exists yet at that layer), so every fixture's
 * assertion looks up its OWN listing id rather than asserting on the full
 * result set. The sweep tests mint a fresh, never-reused category chain per
 * case, so no other file's listing can ever land in one of THESE scopes — the
 * one scope that is genuinely shared is the root (`''`), which every counted
 * subject in the whole database belongs to; nothing here asserts on its
 * CONTENTS, only on whether this file's own subject is present in it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { ANALYTICS_ENVELOPE_VERSION, ORDER_STATUSES, type OrderStatus } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { orderItems, orders } from '../../db/schema/orders.js';
import { analyticsEvents } from '../../db/schema/analytics.js';
import { discoverySignals, discoverySweepCursors } from '../../db/schema/discovery.js';
import { stores } from '../../db/schema/stores.js';
import { insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import {
  countListingSales,
  countListingViews,
} from '../../db/discovery/discoveryCountRepository.js';
import { DISCOVERY_SWEEP_JOB, runDiscoverySweepOnce } from '../discovery/sweep.js';

let db: Database;
const ownedListingIds: string[] = [];
const ownedOrderIds: string[] = [];
const ownedEventIds: string[] = [];
const ownedCategoryIds: string[] = [];
const ownedStoreIds: string[] = [];

/** Yesterday — inside any window this suite asks for. */
function recently(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

/** Ninety days ago — outside a `windowDays: 30` window. */
function longAgo(): Date {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
}

async function makeListing(
  overrides: { categoryId?: string; storeId?: string; status?: 'active' | 'draft' } = {},
): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: overrides.storeId ? 'store' : 'user',
      oxyUserId: overrides.storeId ? null : `realdb-discovery-seller-${uuidv7()}`,
      storeId: overrides.storeId ?? null,
      title: 'Realdb counted thing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      categoryId: overrides.categoryId ?? null,
      status: overrides.status ?? 'draft',
    })
    .returning({ id: listings.id });
  ownedListingIds.push(listing.id);
  return listing.id;
}

/** A minimal native store row — the store-rollup fixtures' owner. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const [row] = await db
    .insert(stores)
    .values({
      handle: `discovery-sweep-${suffix}`,
      name: 'Discovery sweep store',
      description: '',
      brandColor: '#123456',
    })
    .returning({ id: stores.id });
  ownedStoreIds.push(row.id);
  return row.id;
}

/** A one-line order for `listingId`, in `status`, at `createdAt`. */
async function makeOrder(input: {
  listingId: string;
  quantity: number;
  status: OrderStatus;
  createdAt?: Date;
}): Promise<string> {
  const orderId = uuidv7();
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `DISC-${orderId.slice(-10)}`,
    buyerOxyUserId: `realdb-discovery-buyer-${uuidv7()}`,
    sellerType: 'user',
    sellerOxyUserId: `realdb-discovery-order-seller-${uuidv7()}`,
    shippingAddressLine1: '1 Test St',
    shippingAddressCity: 'Barcelona',
    shippingAddressPostalCode: '08001',
    shippingAddressCountry: 'ES',
    shippingAddressRecipientName: 'Test Buyer',
    shippingMethod: 'standard',
    shippingLabel: 'Standard',
    shippingCostShopAmount: 0,
    shippingCostShopCurrency: 'EUR',
    shippingCostPresentmentAmount: 0,
    shippingCostPresentmentCurrency: 'EUR',
    totalsSubtotalShopAmount: 1000,
    totalsSubtotalShopCurrency: 'EUR',
    totalsSubtotalPresentmentAmount: 1000,
    totalsSubtotalPresentmentCurrency: 'EUR',
    totalsDiscountTotalShopAmount: 0,
    totalsDiscountTotalShopCurrency: 'EUR',
    totalsDiscountTotalPresentmentAmount: 0,
    totalsDiscountTotalPresentmentCurrency: 'EUR',
    totalsShippingShopAmount: 0,
    totalsShippingShopCurrency: 'EUR',
    totalsShippingPresentmentAmount: 0,
    totalsShippingPresentmentCurrency: 'EUR',
    totalsTaxShopAmount: 0,
    totalsTaxShopCurrency: 'EUR',
    totalsTaxPresentmentAmount: 0,
    totalsTaxPresentmentCurrency: 'EUR',
    totalsGrandTotalShopAmount: 1000,
    totalsGrandTotalShopCurrency: 'EUR',
    totalsGrandTotalPresentmentAmount: 1000,
    totalsGrandTotalPresentmentCurrency: 'EUR',
    status: input.status,
    createdAt: input.createdAt ?? new Date(),
  });
  ownedOrderIds.push(orderId);
  await db.insert(orderItems).values({
    id: uuidv7(),
    orderId,
    listingId: input.listingId,
    variantId: uuidv7(),
    title: 'A thing',
    variantTitle: 'Default',
    quantity: input.quantity,
    unitPriceShopAmount: 1000,
    unitPriceShopCurrency: 'EUR',
    unitPricePresentmentAmount: 1000,
    unitPricePresentmentCurrency: 'EUR',
    lineTotalShopAmount: 1000 * input.quantity,
    lineTotalShopCurrency: 'EUR',
    lineTotalPresentmentAmount: 1000 * input.quantity,
    lineTotalPresentmentCurrency: 'EUR',
  });
  return orderId;
}

/** A `product_page_view` (or other discovery) event naming `listingId`. */
async function makeEvent(input: {
  listingId: string;
  eventType: 'product_page_view' | 'offer_impression';
}): Promise<void> {
  const at = new Date();
  const [event] = await db
    .insert(analyticsEvents)
    .values({
      envelopeVersion: ANALYTICS_ENVELOPE_VERSION,
      eventType: input.eventType,
      eventClass: 'discovery',
      occurredAt: at,
      receivedAt: at,
      actorKind: 'anonymous',
      clientSurface: 'storefront_web',
      trafficClass: 'human',
      consentState: 'not_required',
      collectionMode: 'full',
      listingId: input.listingId,
      expiresAt: new Date(at.getTime() + 90 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: analyticsEvents.id });
  ownedEventIds.push(event.id);
}

/** A category chain, unique to this run: `insertCategory` derives its ancestry. */
async function makeCategoryChain(depth: number): Promise<string[]> {
  const ids: string[] = [];
  let parentId: string | undefined;
  for (let level = 0; level < depth; level += 1) {
    const suffix = uuidv7();
    const category = await insertCategory({
      key: `discovery-sweep-${suffix}`,
      name: `Discovery sweep ${suffix}`,
      slug: `discovery-sweep-${suffix}`,
      parentId,
    });
    ids.push(category.id);
    ownedCategoryIds.push(category.id);
    parentId = category.id;
  }
  return ids;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  // Captured before anything below clears the arrays: every subject THIS
  // FILE ran through the sweep also earns an UNCONDITIONAL row in the shared
  // root scope ('') alongside its ancestor-chain scopes, and `discovery_signals`
  // carries no FK to either a listing or a store (polymorphic subject), so
  // neither the listing/store delete below nor the category-scoped delete
  // reaches that root row. Deleting by subject id below does, because it is
  // not scoped to a category at all.
  const subjectIds = [...ownedListingIds, ...ownedStoreIds];

  if (ownedEventIds.length > 0) {
    await db.delete(analyticsEvents).where(inArray(analyticsEvents.id, ownedEventIds));
    ownedEventIds.length = 0;
  }
  if (ownedOrderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, ownedOrderIds));
    ownedOrderIds.length = 0;
  }
  if (subjectIds.length > 0) {
    await db.delete(discoverySignals).where(inArray(discoverySignals.subjectId, subjectIds));
  }
  if (ownedListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, ownedListingIds));
    ownedListingIds.length = 0;
  }
  if (ownedCategoryIds.length > 0) {
    // No FK ties a `discovery_signals` row to a category — it is a
    // polymorphic scope key — so nothing but this scoped delete cleans it up.
    // Kept alongside the subject-id delete above as a second net: this one
    // clears rows in a category this file minted for ANY subject, the one
    // above clears rows for a SUBJECT this file created in ANY scope
    // (root included).
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, ownedCategoryIds));
  }
  if (ownedStoreIds.length > 0) {
    await deleteTestStores(db, ownedStoreIds);
    ownedStoreIds.length = 0;
  }
  // Categories are left standing — nothing deletes a category (`restrict`
  // everywhere), and this is a throwaway per-run database.
  await db.delete(discoverySweepCursors).where(inArray(discoverySweepCursors.id, [DISCOVERY_SWEEP_JOB]));
});

afterAll(async () => {
  await closePostgres();
});

describe('countListingSales', () => {
  it('counts a paid order and ignores a pending one', async () => {
    const listingId = await makeListing();
    await makeOrder({ listingId, quantity: 1, status: 'paid' });
    await makeOrder({ listingId, quantity: 1, status: 'pending_payment' });

    const counted = await countListingSales(recently());
    const mine = counted.find((row) => row.listingId === listingId);
    expect(mine?.unitsSold).toBe(1);
  });

  it('moves the number for exactly the five counted statuses', async () => {
    // One order per status, all for one listing, each of quantity 1. Five of
    // the eight statuses are sales, so the sum is 5 — dropping one of the real
    // five OR admitting a sixth both break this, which a single-status test
    // would not.
    const listingId = await makeListing();
    for (const status of ORDER_STATUSES) {
      await makeOrder({ listingId, quantity: 1, status });
    }

    const counted = await countListingSales(recently());
    const mine = counted.find((row) => row.listingId === listingId);
    expect(mine?.unitsSold).toBe(5);
    expect(mine?.orderCount).toBe(5);
  });

  it('ignores an order older than the window', async () => {
    const listingId = await makeListing();
    await makeOrder({ listingId, quantity: 1, status: 'paid', createdAt: longAgo() });

    const counted = await countListingSales(recently());
    expect(counted.find((row) => row.listingId === listingId)).toBeUndefined();
  });
});

describe('countListingViews', () => {
  it('counts product_page_view events and nothing else', async () => {
    const listingId = await makeListing();
    await makeEvent({ listingId, eventType: 'product_page_view' });
    await makeEvent({ listingId, eventType: 'product_page_view' });
    await makeEvent({ listingId, eventType: 'offer_impression' });

    const counted = await countListingViews(recently());
    expect(counted.find((row) => row.listingId === listingId)?.viewCount).toBe(2);
  });
});

describe('runDiscoverySweepOnce', () => {
  it('writes a row for every ancestor of the listing category, and for the root', async () => {
    // A three-level chain: root '' + grandparent + parent + leaf = four rows
    // for one listing. A sweep that wrote only the leaf passes every
    // single-category assertion and fails exactly this one.
    //
    // The root scope ('') is shared by every counted subject in the whole
    // database, and `selectTopByUnion` keeps only the top `topNPerCategory`
    // (60) by `unitsSold` there — so a quantity of 1 would make this
    // assertion's outcome depend on how many OTHER subjects happen to be
    // live in the root scope's top 60 at the same moment, the same shape of
    // flake fixed in `discovery-feed.realdb.test.ts` (07989dd6). A sentinel
    // quantity no real fixture would plausibly reach keeps this listing
    // unconditionally the top seller in every scope it touches, root
    // included, so the assertion is decided entirely by a row this file owns.
    const SENTINEL_QUANTITY = 2_000_000_000;
    const [grandparentId, parentId, leafId] = await makeCategoryChain(3);
    const listingId = await makeListing({ categoryId: leafId, status: 'active' });
    await makeOrder({ listingId, quantity: SENTINEL_QUANTITY, status: 'paid' });

    const outcome = await runDiscoverySweepOnce();
    expect(outcome).toBeDefined();

    const rows = await db
      .select({ categoryId: discoverySignals.categoryId })
      .from(discoverySignals)
      .where(inArray(discoverySignals.subjectId, [listingId]));
    expect(rows.map((r) => r.categoryId).sort()).toEqual(
      ['', grandparentId, parentId, leafId].sort(),
    );
  });

  it('sums two listings of the same store into one store row per scope', async () => {
    // Dedup's other half: two DIFFERENT listings, same store, same scope. A
    // sweep that wrote one store row per contributing listing rather than
    // summing them would hit the unique index on `(store, category, window)`.
    const [categoryId] = await makeCategoryChain(1);
    const storeId = await makeStore();
    const listingA = await makeListing({ categoryId, storeId, status: 'active' });
    const listingB = await makeListing({ categoryId, storeId, status: 'active' });
    await makeOrder({ listingId: listingA, quantity: 3, status: 'paid' });
    await makeOrder({ listingId: listingB, quantity: 2, status: 'paid' });

    await runDiscoverySweepOnce();

    // Scoped to THIS category, not the root: the store also gets a root-scope
    // row (every counted subject does), which is a second, equally legitimate
    // row for a DIFFERENT scope — not the duplicate under test here.
    const storeRows = await db
      .select({
        unitsSold: discoverySignals.unitsSold,
        orderCount: discoverySignals.orderCount,
      })
      .from(discoverySignals)
      .where(and(eq(discoverySignals.subjectId, storeId), eq(discoverySignals.categoryId, categoryId)));
    expect(storeRows).toHaveLength(1);
    expect(storeRows[0]?.unitsSold).toBe(5);
    expect(storeRows[0]?.orderCount).toBe(2);
  });

  it('returns undefined while another task holds the lease', async () => {
    // Take the lease out from under it by hand, then tick.
    await db
      .insert(discoverySweepCursors)
      .values({
        id: DISCOVERY_SWEEP_JOB,
        leaseOwner: 'someone-else',
        leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .onConflictDoUpdate({
        target: discoverySweepCursors.id,
        set: {
          leaseOwner: 'someone-else',
          leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

    expect(await runDiscoverySweepOnce()).toBeUndefined();
  });
});
