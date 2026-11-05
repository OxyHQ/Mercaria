/**
 * The paid store-page merchandising rules against a real server (#89,
 * `advanced_merchandising_rules`): rule storage and its CHECKs, the allowance a
 * create takes and a delete gives back, ordering correctness, schedule windows
 * at an injected clock, and the fallback when the store loses the tool.
 *
 * Every instant is RELATIVE to the wall clock at the start of each test (`NOW`) and handed to
 * the code under test as its clock, so no literal can be overtaken by time
 * (`fixture-date-census.test.ts`), and the entitlement grant (which starts a
 * minute before it is written) is in force at every `at` used here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { insertStore } from '../../../db/stores/storeRepository.js';
import { listings } from '../../../db/schema/catalog.js';
import { orders } from '../../../db/schema/orders.js';
import { collections, listingCollections } from '../../../db/schema/merchandising.js';
import {
  merchandisingRulePins,
  merchandisingRules,
} from '../../../db/schema/merchandisingRules.js';
import { insertOrder, nextOrderNumber, type NewOrder } from '../../../db/orders/orderRepository.js';
import {
  insertCollection,
  reconcileAutomatedMembership,
  replaceManualMembership,
} from '../../../db/merchandising/collectionRepository.js';
import { findEntitlementUsage } from '../../../db/merchantPlans/usageRepository.js';
import { entitlementGrants, entitlementUsageCounters } from '../../../db/schema/merchantPlans.js';
import { revokeEntitlementGrant } from '../../../db/merchantPlans/grantRepository.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { invalidateMerchantEntitlements } from '../../entitlements/resolve.js';
import { entitleStoreForTest } from '../../entitlements/__tests__/entitle-store.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import { PlanCapabilityRefusal } from '../../entitlements/enforce.js';
import {
  createMerchandisingRule,
  deleteMerchandisingRuleById,
  listMerchandisingRules,
  previewMerchandisingOrder,
  updateMerchandisingRuleById,
} from '../merchandising-rule.service.js';
import {
  readMerchandisedPage,
  readStorefrontMerchandising,
} from '../storefront-merchandising.service.js';

let db: Database;
/** Re-read per test, so a grant written in the test is always in force at `NOW`. */
let NOW = new Date();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const CAPABILITY = 'advanced_merchandising_rules' as const;
const created: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

beforeEach(() => {
  NOW = new Date();
});

afterAll(async () => {
  if (created.length > 0) {
    // Orders and listings are RESTRICT from the store; rules, pins, collections
    // and memberships cascade.
    await db.delete(orders).where(inArray(orders.storeId, created));
    await db.delete(listings).where(inArray(listings.storeId, created));
    // The grants and usage counters this file wrote are RESTRICT from the store.
    await db
      .delete(entitlementUsageCounters)
      .where(inArray(entitlementUsageCounters.storeId, created));
    await db.delete(entitlementGrants).where(inArray(entitlementGrants.storeId, created));
    await deleteTestStores(db, created);
  }
  await closePostgres();
});

async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore({
    oxyAccountId: `merch-owner-${suffix}`,
    handle: `merch-${suffix}`,
    name: 'Merchandising store',
    description: '',
    brandColor: '#123456',
    defaultCurrency: 'FAIR',
  });
  created.push(store.id);
  return store.id;
}

async function makeListing(
  storeId: string,
  fields: {
    title: string;
    price?: number;
    inStock?: boolean;
    publishedAgo?: number;
    status?: 'active' | 'draft';
  },
): Promise<string> {
  const status = fields.status ?? 'active';
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: fields.title,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status,
      publishedAt: status === 'active' ? ago(fields.publishedAgo ?? DAY) : null,
      hasInventory: fields.inStock ?? true,
      ...(fields.price === undefined
        ? {}
        : { priceRangeMinAmount: fields.price, priceRangeMinCurrency: 'FAIR' as const }),
    })
    .returning({ id: listings.id });
  return row.id;
}

function dual(amount: number) {
  return { shop: { amount, currency: 'FAIR' }, presentment: { amount, currency: 'FAIR' } } as const;
}

/** A paid order of `quantity` units of `listingId`, settled `paidAgo` before NOW. */
async function sell(storeId: string, listingId: string, quantity: number, paidAgo: number) {
  const order: NewOrder = {
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${uuidv7()}`,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    storeId,
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: dual(0),
    totals: {
      subtotal: dual(1000),
      discountTotal: dual(0),
      shipping: dual(0),
      tax: dual(0),
      grandTotal: dual(1000),
    },
    status: 'paid',
    paymentStatus: 'paid',
    paymentPaidAt: ago(paidAgo),
    checkoutGroupId: uuidv7(),
    items: [
      {
        listingId,
        variantId: uuidv7(),
        title: 'Sold',
        variantTitle: 'Default Title',
        optionValues: [],
        unitPrice: dual(1000),
        quantity,
        lineTotal: dual(1000 * quantity),
      },
    ],
    statusHistory: [{ status: 'pending_payment', at: ago(paidAgo), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
  };
  await insertOrder(order);
}

async function makeCollection(
  storeId: string,
  type: 'manual' | 'automated',
  memberIds: string[],
  isPublished = true,
): Promise<string> {
  const collection = await insertCollection(
    storeId,
    { title: `C ${uuidv7()}`, handle: `c-${uuidv7()}`, type, isPublished },
    type === 'automated' ? [{ field: 'title', operator: 'contains', value: 'x' }] : [],
  );
  if (type === 'manual') await replaceManualMembership(collection.id, memberIds);
  else await reconcileAutomatedMembership(collection.id, memberIds);
  return collection.id;
}

async function refusalOf(promise: Promise<unknown>): Promise<PlanCapabilityRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlanCapabilityRefusal) return error;
    throw error;
  }
  throw new Error('expected a plan refusal, and the call succeeded');
}

async function used(storeId: string): Promise<number> {
  const counter = await findEntitlementUsage(db, {
    storeId,
    capabilityKey: CAPABILITY,
    periodKey: 'total',
  });
  return counter?.used ?? 0;
}

/** End every grant of this store — the plan "ends". */
async function revoke(storeId: string): Promise<void> {
  const grants = await db
    .select({ id: entitlementGrants.id })
    .from(entitlementGrants)
    .where(eq(entitlementGrants.storeId, storeId));
  for (const grant of grants) {
    await revokeEntitlementGrant(db, {
      id: grant.id,
      revokedByOxyUserId: 'test-operator',
      revocationReason: 'test: the plan ended',
      at: ago(1000),
    });
  }
  invalidateMerchantEntitlements(storeId);
}

describe('the allowance: one unit per rule, taken on create and given back on delete', () => {
  it('refuses a store without the tool, writing nothing', async () => {
    const storeId = await makeStore();
    const refusal = await refusalOf(
      createMerchandisingRule(storeId, {
        kind: 'sort',
        title: 'Newest',
        target: 'store',
        sortStrategy: 'newest',
      }),
    );
    expect(refusal.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    const rows = await db
      .select()
      .from(merchandisingRules)
      .where(eq(merchandisingRules.storeId, storeId));
    expect(rows).toEqual([]);
  });

  it('takes one unit per create up to the limit, refuses the next, and frees room on delete', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: 2 });
    const draft = { kind: 'sort', title: 'A', target: 'store', sortStrategy: 'newest' } as const;

    const first = await createMerchandisingRule(storeId, draft, { at: NOW });
    await createMerchandisingRule(storeId, { ...draft, title: 'B' }, { at: NOW });
    expect(await used(storeId)).toBe(2);

    const refusal = await refusalOf(createMerchandisingRule(storeId, { ...draft, title: 'C' }));
    expect(refusal.code).toBe(ErrorCodes.PLAN_LIMIT_REACHED);
    expect((await listMerchandisingRules(storeId, { at: NOW })).length).toBe(2);
    expect(await used(storeId)).toBe(2);

    await deleteMerchandisingRuleById(storeId, first.id);
    expect(await used(storeId)).toBe(1);
    // A second delete of the same rule finds nothing and gives nothing back.
    await expect(deleteMerchandisingRuleById(storeId, first.id)).rejects.toThrow(/not found/i);
    expect(await used(storeId)).toBe(1);

    await createMerchandisingRule(storeId, { ...draft, title: 'C' }, { at: NOW });
    expect(await used(storeId)).toBe(2);
  });

  it('a refused create (bad pin) takes no allowance', async () => {
    const storeId = await makeStore();
    const other = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: 5 });
    const foreign = await makeListing(other, { title: 'Not mine' });
    await expect(
      createMerchandisingRule(storeId, {
        kind: 'sort',
        title: 'Pins',
        target: 'store',
        sortStrategy: 'newest',
        pinnedListingIds: [foreign],
      }),
    ).rejects.toThrow(/belong to this store/);
    expect(await used(storeId)).toBe(0);
  });

  it('after the plan ends: list, read and delete still work; create, edit and preview are refused', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: 5 });
    const rule = await createMerchandisingRule(
      storeId,
      { kind: 'sort', title: 'Kept', target: 'store', sortStrategy: 'newest' },
      { at: NOW },
    );
    await revoke(storeId);

    const listed = await listMerchandisingRules(storeId, { at: NOW });
    expect(listed.map((r) => r.id)).toEqual([rule.id]);
    expect(listed[0].status).toBe('live');
    expect(listed[0].applying).toBe(false);

    expect(
      (await refusalOf(updateMerchandisingRuleById(storeId, rule.id, { title: 'Edited' }))).code,
    ).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    expect(
      (
        await refusalOf(
          previewMerchandisingOrder(storeId, { target: 'store', sortStrategy: 'newest' }),
        )
      ).code,
    ).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    expect(
      (
        await refusalOf(
          createMerchandisingRule(storeId, {
            kind: 'sort',
            title: 'New',
            target: 'store',
            sortStrategy: 'newest',
          }),
        )
      ).code,
    ).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);

    await deleteMerchandisingRuleById(storeId, rule.id);
    expect(await listMerchandisingRules(storeId, { at: NOW })).toEqual([]);
  });
});

describe('storage: the row shape is held by the database, not only the service', () => {
  it('refuses a store-wide rule naming a collection, a spotlight without a limit, and a reversed window', async () => {
    const storeId = await makeStore();
    const collectionId = await makeCollection(storeId, 'manual', []);
    const base = {
      storeId,
      title: 'Raw',
      enabled: true,
      inStockFirst: false,
    };
    const attempts = [
      { ...base, kind: 'sort', target: 'store', collectionId, sortStrategy: 'newest' },
      { ...base, kind: 'spotlight', target: 'collection', collectionId },
      { ...base, kind: 'spotlight', target: 'store', spotlightItemLimit: 4 },
      { ...base, kind: 'sort', target: 'store', sortStrategy: 'best_selling' },
      { ...base, kind: 'sort', target: 'store', sortStrategy: 'newest', bestSellingWindowDays: 7 },
      {
        ...base,
        kind: 'sort',
        target: 'store',
        sortStrategy: 'newest',
        startsAt: NOW,
        endsAt: ago(HOUR),
      },
      { ...base, kind: 'sort', target: 'store', sortStrategy: 'newest', title: '   ' },
    ] as const;
    for (const values of attempts) {
      await expect(
        db.insert(merchandisingRules).values(values as typeof merchandisingRules.$inferInsert),
      ).rejects.toThrow();
    }
  });

  it('deleting the collection detaches the rule and keeps its allowance until the merchant deletes it', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: 5 });
    const listing = await makeListing(storeId, { title: 'In it' });
    const collectionId = await makeCollection(storeId, 'manual', [listing]);
    const rule = await createMerchandisingRule(
      storeId,
      {
        kind: 'sort',
        title: 'Pinned',
        target: 'collection',
        collectionId,
        sortStrategy: 'newest',
        pinnedListingIds: [listing],
      },
      { at: NOW },
    );
    expect(rule.status).toBe('live');

    await db.delete(collections).where(eq(collections.id, collectionId));
    const [detached] = await listMerchandisingRules(storeId, { at: NOW });
    expect(detached.status).toBe('detached');
    expect(detached.collectionId).toBeNull();
    expect(detached.target).toBe('collection');
    expect(detached.applying).toBe(false);
    expect(await used(storeId)).toBe(1);

    await deleteMerchandisingRuleById(storeId, rule.id);
    expect(await used(storeId)).toBe(0);
    const pins = await db
      .select()
      .from(merchandisingRulePins)
      .where(eq(merchandisingRulePins.ruleId, rule.id));
    expect(pins).toEqual([]);
  });
});

describe('ordering correctness', () => {
  it('orders best-selling by units in the window, pins on top, in-stock first, and never shows a draft', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: null });
    const slow = await makeListing(storeId, { title: 'Slow', publishedAgo: 1 * DAY });
    const fast = await makeListing(storeId, { title: 'Fast', publishedAgo: 5 * DAY });
    const old = await makeListing(storeId, { title: 'Old seller', publishedAgo: 9 * DAY });
    const soldOut = await makeListing(storeId, { title: 'Sold out', inStock: false });
    const pinned = await makeListing(storeId, { title: 'Pinned', publishedAgo: 20 * DAY });
    const draft = await makeListing(storeId, { title: 'Draft', status: 'draft' });

    await sell(storeId, fast, 5, 2 * DAY);
    await sell(storeId, slow, 1, 1 * DAY);
    // Outside a 7-day window, inside a 30-day one.
    await sell(storeId, old, 50, 20 * DAY);
    await sell(storeId, soldOut, 100, 1 * DAY);

    const order = async (
      windowDays: number,
      inStockFirst: boolean,
      pins: string[] = [],
    ): Promise<string[]> =>
      (
        await previewMerchandisingOrder(
          storeId,
          {
            target: 'store',
            sortStrategy: 'best_selling',
            bestSellingWindowDays: windowDays,
            inStockFirst,
            pinnedListingIds: pins,
          },
          { at: NOW },
        )
      ).items.map((item) => item.listingId);

    const seven = await order(7, false);
    expect(seven.slice(0, 3)).toEqual([soldOut, fast, slow]);
    // Unsold in the window: newest-first tie-break.
    expect(seven.slice(3)).toEqual([old, pinned]);
    expect(seven).not.toContain(draft);

    expect((await order(30, false)).slice(0, 2)).toEqual([soldOut, old]);
    expect((await order(7, true)).slice(0, 2)).toEqual([fast, slow]);
    expect((await order(7, true)).at(-1)).toBe(soldOut);
    // Pins first, in pin order, then the strategy — and a draft pin has nothing to reorder.
    expect((await order(7, true, [pinned, draft, slow])).slice(0, 3)).toEqual([pinned, slow, fast]);

    const preview = await previewMerchandisingOrder(
      storeId,
      { target: 'store', sortStrategy: 'best_selling', bestSellingWindowDays: 7 },
      { at: NOW },
    );
    expect(preview.total).toBe(5);
    expect(preview.items.find((item) => item.listingId === fast)?.unitsSold).toBe(5);
  });

  it('orders by price both ways, and restricts a collection to its own members', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: null });
    const cheap = await makeListing(storeId, { title: 'Cheap', price: 100 });
    const mid = await makeListing(storeId, { title: 'Mid', price: 500 });
    const dear = await makeListing(storeId, { title: 'Dear', price: 900 });
    const outside = await makeListing(storeId, { title: 'Outside', price: 50 });
    const collectionId = await makeCollection(storeId, 'automated', [cheap, mid, dear]);

    const ids = async (sortStrategy: 'price_asc' | 'price_desc') =>
      (
        await previewMerchandisingOrder(
          storeId,
          { target: 'collection', collectionId, sortStrategy },
          { at: NOW },
        )
      ).items.map((item) => item.listingId);
    expect(await ids('price_asc')).toEqual([cheap, mid, dear]);
    expect(await ids('price_desc')).toEqual([dear, mid, cheap]);
    expect(await ids('price_asc')).not.toContain(outside);
  });

  it("never writes the automated collection's memberships: every position stays NULL", async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: null });
    const a = await makeListing(storeId, { title: 'A' });
    const b = await makeListing(storeId, { title: 'B' });
    const collectionId = await makeCollection(storeId, 'automated', [a, b]);
    await createMerchandisingRule(
      storeId,
      {
        kind: 'sort',
        title: 'Pin B',
        target: 'collection',
        collectionId,
        sortStrategy: 'newest',
        pinnedListingIds: [b],
      },
      { at: NOW },
    );
    const page = await readMerchandisedPage(
      storeId,
      { collectionId, page: 1, limit: 10 },
      { at: NOW },
    );
    expect(page.applied).toBe(true);
    expect(page.listingIds[0]).toBe(b);
    const memberships = await db
      .select({ position: listingCollections.position })
      .from(listingCollections)
      .where(eq(listingCollections.collectionId, collectionId));
    expect(memberships).toHaveLength(2);
    expect(memberships.every((row) => row.position === null)).toBe(true);
  });
});

describe('schedules are evaluated at the injected clock', () => {
  it('a scheduled override supersedes the default inside its window and hands back after it', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: null });
    const cheap = await makeListing(storeId, { title: 'Cheap', price: 100, publishedAgo: 3 * DAY });
    const dear = await makeListing(storeId, { title: 'Dear', price: 900, publishedAgo: 1 * DAY });

    const always = await createMerchandisingRule(
      storeId,
      { kind: 'sort', title: 'Newest', target: 'store', sortStrategy: 'newest' },
      { at: NOW },
    );
    const sale = await createMerchandisingRule(
      storeId,
      {
        kind: 'sort',
        title: 'Weekend sale',
        target: 'store',
        sortStrategy: 'price_asc',
        startsAt: ahead(HOUR).toISOString(),
        endsAt: ahead(3 * HOUR).toISOString(),
      },
      { at: NOW },
    );

    const at = async (when: Date) => ({
      statuses: Object.fromEntries(
        (await listMerchandisingRules(storeId, { at: when })).map((r) => [r.id, r.status]),
      ),
      page: (
        await readMerchandisedPage(
          storeId,
          { collectionId: null, page: 1, limit: 10 },
          { at: when },
        )
      ).listingIds,
    });

    const before = await at(NOW);
    expect(before.statuses).toEqual({ [always.id]: 'live', [sale.id]: 'scheduled' });
    expect(before.page).toEqual([dear, cheap]);

    const during = await at(ahead(2 * HOUR));
    expect(during.statuses).toEqual({ [always.id]: 'superseded', [sale.id]: 'live' });
    expect(during.page).toEqual([cheap, dear]);

    // `endsAt` is exclusive.
    const after = await at(ahead(3 * HOUR));
    expect(after.statuses).toEqual({ [always.id]: 'live', [sale.id]: 'ended' });
    expect(after.page).toEqual([dear, cheap]);
  });

  it('a spotlight shelf goes live at its start and comes down at its end; paused rules never apply', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: null });
    const first = await makeListing(storeId, { title: 'First' });
    const second = await makeListing(storeId, { title: 'Second' });
    const third = await makeListing(storeId, { title: 'Third' });
    const drop = await makeCollection(storeId, 'manual', [third, first, second]);
    const hidden = await makeCollection(storeId, 'manual', [first], false);

    const spotlight = await createMerchandisingRule(
      storeId,
      {
        kind: 'spotlight',
        title: 'The drop',
        target: 'collection',
        collectionId: drop,
        spotlightItemLimit: 2,
        startsAt: ahead(HOUR).toISOString(),
        endsAt: ahead(2 * HOUR).toISOString(),
      },
      { at: NOW },
    );
    // An unpublished collection is never shown on the page, whatever the rule says.
    await createMerchandisingRule(
      storeId,
      {
        kind: 'spotlight',
        title: 'Hidden',
        target: 'collection',
        collectionId: hidden,
        spotlightItemLimit: 2,
      },
      { at: NOW },
    );

    expect((await readStorefrontMerchandising(storeId, { at: NOW })).spotlights).toEqual([]);
    const live = await readStorefrontMerchandising(storeId, { at: ahead(90 * 60 * 1000) });
    expect(live.spotlights).toEqual([
      // The collection's own (manual) order, cut at the item limit.
      { ruleId: spotlight.id, title: 'The drop', collectionId: drop, listingIds: [third, first] },
    ]);
    expect(
      (await readStorefrontMerchandising(storeId, { at: ahead(2 * HOUR) })).spotlights,
    ).toEqual([]);

    await updateMerchandisingRuleById(storeId, spotlight.id, { enabled: false }, { at: NOW });
    expect(
      (await readStorefrontMerchandising(storeId, { at: ahead(90 * 60 * 1000) })).spotlights,
    ).toEqual([]);
  });
});

describe('fallback when the store is not entitled', () => {
  it('the storefront applies nothing once the plan ends, and everything again when it returns — nothing is deleted', async () => {
    const storeId = await makeStore();
    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: 3 });
    const a = await makeListing(storeId, { title: 'A', publishedAgo: 2 * DAY });
    const b = await makeListing(storeId, { title: 'B', publishedAgo: 1 * DAY });
    const collectionId = await makeCollection(storeId, 'manual', [a, b]);
    await createMerchandisingRule(
      storeId,
      {
        kind: 'sort',
        title: 'Pin A',
        target: 'store',
        sortStrategy: 'newest',
        pinnedListingIds: [a],
      },
      { at: NOW },
    );
    await createMerchandisingRule(
      storeId,
      {
        kind: 'spotlight',
        title: 'Shelf',
        target: 'collection',
        collectionId,
        spotlightItemLimit: 4,
      },
      { at: NOW },
    );

    const entitled = await readStorefrontMerchandising(storeId, { at: NOW });
    expect(entitled.storeSorted).toBe(true);
    expect(entitled.spotlights).toHaveLength(1);
    expect(
      (await readMerchandisedPage(storeId, { collectionId: null, page: 1, limit: 10 }, { at: NOW }))
        .listingIds,
    ).toEqual([a, b]);

    await revoke(storeId);
    expect(await readStorefrontMerchandising(storeId, { at: NOW })).toEqual({
      storeSorted: false,
      sortedCollectionIds: [],
      spotlights: [],
    });
    const fallback = await readMerchandisedPage(
      storeId,
      { collectionId: null, page: 1, limit: 10 },
      { at: NOW },
    );
    expect(fallback).toMatchObject({ applied: false, listingIds: [] });
    // Nothing was deleted, and the free manual order is untouched.
    expect((await listMerchandisingRules(storeId, { at: NOW })).length).toBe(2);
    const positions = await db
      .select({ listingId: listingCollections.listingId, position: listingCollections.position })
      .from(listingCollections)
      .where(eq(listingCollections.collectionId, collectionId));
    expect(new Map(positions.map((row) => [row.listingId, row.position]))).toEqual(
      new Map([
        [a, 0],
        [b, 1],
      ]),
    );

    await entitleStoreForTest(db, { storeId, capability: CAPABILITY, limit: 3 });
    expect((await readStorefrontMerchandising(storeId, { at: NOW })).storeSorted).toBe(true);
  });
});
