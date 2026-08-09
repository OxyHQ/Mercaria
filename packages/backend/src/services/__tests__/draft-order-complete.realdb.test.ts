/**
 * The POS sale — `completeDraftOrder` — against a REAL Postgres database.
 *
 * ## Why this file exists
 *
 * `draft-order.service.test.ts` mocks the order repository, and a mocked insert
 * accepts ANY input — including one the real table rejects. That blind spot hid a
 * total, production-breaking bug: `completeDraftOrder` built its create payload
 * without an `orderNumber`, which is NOT NULL and UNIQUE. Every POS sale would
 * have failed on a real server while the mocked suite stayed green, because a
 * mock enforces no constraint.
 *
 * Every other order-creating path (`checkout.service`, `connector-sync.service`)
 * mints one from the sequence; the POS path was the only one that did not.
 *
 * The tests below therefore run the real service against real tables — the only
 * combination that can tell an acceptable row from an unacceptable one. Three
 * further properties only a server can answer are checked here too: the
 * `orders_idempotency_key_key` convergence after a crash, the transactional
 * all-or-nothing of an order and its five child relations, and that the rolled
 * back reservation really returned the stock.
 *
 * ## The payment is part of what is under test
 *
 * A POS sale records a `manual_pos` payment and lets that payment's outbox
 * handler move the order to `paid` — one path from "a payment succeeded" to "its
 * orders are paid", shared with every other rail. The handoff runs here for real
 * rather than against a mocked payment service, so what these tests assert is
 * that it actually completes, which no mock can tell you.
 *
 * ## The order numbers are compared, never pinned
 *
 * `order_number_seq` is one sequence in a database SHARED with every other
 * realdb file in the suite, and vitest runs those files in parallel workers. An
 * assertion that the first sale is `MRC-000001` would therefore pass or fail on
 * which file happened to run first — the classic environment-property-read-as-a-
 * code-property. What is actually under test is that each sale draws a DISTINCT,
 * ascending number from the customer-facing sequence, so that is what is asserted.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/**
 * The paid transition fires a best-effort buyer/seller notification. No Redis
 * runs in the suite, so a producer left unstubbed executes its handler INLINE
 * and awaits it — writing notification rows and reaching for Oxy's push
 * transport, neither of which any assertion here reads. Stubbing the producers
 * keeps the file about the sale.
 */
vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowInventoryAlert: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { locations, stores } from '../../db/schema/stores.js';
import { listings } from '../../db/schema/catalog.js';
import { orders } from '../../db/schema/orders.js';
import { reviewEligibilities } from '../../db/schema/reviews.js';
import { draftOrders } from '../../db/schema/pos.js';
import { insertListing } from '../../db/catalog/listingRepository.js';
import { insertVariants } from '../../db/catalog/variantRepository.js';
import { findLevel, insertLevels } from '../../db/catalog/inventoryLevelRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertDraftOrder, replaceDraftPricing } from '../../db/pos/draftOrderRepository.js';
import { completeDraftOrder } from '../draft-order.service.js';

let pg: Database;

/**
 * Store ids this file seeded, dropped after each test. The database is shared
 * with every other realdb file in the suite, so this file cleans up after ITSELF
 * rather than truncating anything.
 */
const seededStoreIds: string[] = [];

/** The store settlement currency used throughout — FAIR needs no FX provider. */
const CURRENCY = 'FAIR';
/** The POS operator taking the sale. */
const ACTOR_OXY_USER_ID = 'oxy-user-pos-operator';
/** Unit price of the seeded variant, in minor units. */
const UNIT_PRICE_AMOUNT = 2500;
/** Stock seeded at the register location. */
const SEEDED_AVAILABLE = 10;

beforeAll(async () => {
  pg = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  for (const storeId of seededStoreIds.splice(0)) {
    // `orders.store_id` and `listings.store_id` are both RESTRICT, so the orders
    // (with their cascading children) and the listings (with their cascading
    // variants and inventory levels) go before the locations and the store.
    // `draft_orders.location_id` is RESTRICT too, so the drafts go before the
    // locations and — because a completed draft points at its order — before the
    // orders as well.
    //
    // `review_eligibilities.order_id` is RESTRICT since #76 — the eligibility IS
    // the purchase evidence a review points at, so it must be able to BLOCK an
    // order's disappearance rather than vanish with it. Nothing in production
    // deletes an order; a test that does has to clear the evidence first.
    await pg.delete(draftOrders).where(eq(draftOrders.storeId, storeId));
    await pg.execute(
      sql`delete from ${reviewEligibilities}
          where order_id in (select id from ${orders} where store_id = ${storeId})`,
    );
    await pg.delete(orders).where(eq(orders.storeId, storeId));
    await pg.delete(listings).where(eq(listings.storeId, storeId));
    await pg.delete(locations).where(eq(locations.storeId, storeId));
    await pg.delete(stores).where(eq(stores.id, storeId));
  }
});

/** The ids of one seeded register scenario. */
interface Scenario {
  storeId: string;
  locationId: string;
  listingId: string;
  variantId: string;
  draftId: string;
}

/**
 * Seed the minimum `completeDraftOrder` actually loads: a store with a default
 * currency, a register location, one active store-owned listing with one tracked
 * variant, that variant's stock at the register, and an OPEN draft holding one
 * line.
 */
async function seedScenario(quantity = 2): Promise<Scenario> {
  // The WHOLE uuid in the handle, not a prefix: v7 is time-ordered, so two ids
  // minted in the same millisecond share their leading characters and a truncated
  // suffix collides with `stores_handle_key`.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `pos-store-${suffix}`,
      name: 'POS Test Store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: CURRENCY,
    },
    [{ oxyUserId: ACTOR_OXY_USER_ID, role: 'owner', permissions: ['store:manage'] }],
  );
  const storeId = store.id;
  seededStoreIds.push(storeId);

  const location = await insertLocation(storeId, {
    name: 'Register',
    type: 'retail',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
    address: {
      recipientName: 'POS Test Store',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
  });
  const locationId = location.id;

  const listing = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId,
      title: 'Register Item',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      conditionSourceLabel: null,
      conditionAcknowledgedAt: null,
      status: 'active',
      categoryId: null,
      categorySlugs: [],
      tags: [],
      priceRangeMinAmount: UNIT_PRICE_AMOUNT,
      priceRangeMinCurrency: CURRENCY,
      priceRangeMaxAmount: UNIT_PRICE_AMOUNT,
      priceRangeMaxCurrency: CURRENCY,
      hasInventory: true,
      variantCount: 1,
      longitude: null,
      latitude: null,
      vendor: null,
      productType: null,
      handle: null,
      seoTitle: null,
      seoDescription: null,
      sourceConnectionId: null,
      sourceProvider: null,
      sourceExternalId: null,
      sourceExternalUpdatedAt: null,
      overriddenFields: [],
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      publishedAt: new Date(),
    },
    [],
    [],
  );
  const listingId = listing.id;

  const [variant] = await insertVariants(listingId, [
    {
      title: 'Default Title',
      priceAmount: UNIT_PRICE_AMOUNT,
      priceCurrency: CURRENCY,
      inventoryTracked: true,
      inventoryAvailable: SEEDED_AVAILABLE,
      position: 0,
      optionValues: [],
    },
  ]);
  const variantId = variant.id;

  await insertLevels([
    { variantId, listingId, locationId, available: SEEDED_AVAILABLE, committed: 0 },
  ]);

  const lineTotal = UNIT_PRICE_AMOUNT * quantity;
  const zero = { amount: 0, currency: CURRENCY } as const;
  const draft = await insertDraftOrder({
    storeId,
    createdByOxyUserId: ACTOR_OXY_USER_ID,
    locationId,
    currency: CURRENCY,
    totals: {
      subtotal: zero,
      discountTotal: zero,
      tax: zero,
      shipping: zero,
      grandTotal: zero,
    },
  });

  await replaceDraftPricing(draft.id, {
    lineItems: [
      {
        listingId,
        variantId,
        title: 'Register Item',
        variantTitle: 'Default Title',
        unitPrice: { amount: UNIT_PRICE_AMOUNT, currency: CURRENCY },
        quantity,
        optionValues: [],
      },
    ],
    appliedDiscounts: [],
    taxLines: [],
    totals: {
      subtotal: { amount: lineTotal, currency: CURRENCY },
      discountTotal: zero,
      tax: zero,
      shipping: zero,
      grandTotal: { amount: lineTotal, currency: CURRENCY },
    },
  });

  return { storeId, locationId, listingId, variantId, draftId: draft.id };
}

/** How many orders this store holds — the "never double-created" assertion. */
async function countStoreOrders(storeId: string): Promise<number> {
  const [row] = await pg
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.storeId, storeId));
  return row?.n ?? 0;
}

/** The numeric portion of an `MRC-000123` order number. */
function orderNumberSeq(orderNumber: string): number {
  return Number(orderNumber.slice('MRC-'.length));
}

describe('completeDraftOrder writes an order a REAL server accepts', () => {
  it('takes the sale — the order carries the required, unique orderNumber', async () => {
    /**
     * The assertion a mocked insert cannot make. Without an `orderNumber` in the
     * payload this fails the NOT NULL constraint before writing anything, and
     * every POS sale 500s.
     */
    const { storeId, draftId } = await seedScenario();

    const dto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    expect(dto.orderNumber).toMatch(/^MRC-\d{6}$/);
    // The customer-facing sequence, NOT a POS-only one: a POS sale is a real paid
    // order, listed and receipted beside every storefront order.
    expect(dto.orderNumber.startsWith('MRC-DRAFT-')).toBe(false);
    expect(dto.status).toBe('paid');
    expect(dto.sourceChannel).toBe('pos');

    // And it is what the SERVER stored, not just what hydration reported —
    // including the line, which is a child ROW now and would be silently absent
    // if the aggregate insert had half-committed.
    const [persisted] = await pg
      .select({ orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(eq(orders.id, dto.id));
    expect(persisted?.orderNumber).toBe(dto.orderNumber);
    expect(persisted?.status).toBe('paid');
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].quantity).toBe(2);
  });

  it('mints a distinct, ascending number per sale from the shared order sequence', async () => {
    const first = await seedScenario();
    const firstDto = await completeDraftOrder(first.storeId, first.draftId, {}, ACTOR_OXY_USER_ID);

    const second = await seedScenario();
    const secondDto = await completeDraftOrder(
      second.storeId,
      second.draftId,
      {},
      ACTOR_OXY_USER_ID,
    );

    expect(secondDto.orderNumber).not.toBe(firstDto.orderNumber);
    // Ascending rather than pinned to `MRC-000001`/`MRC-000002` — see the file
    // header: the sequence is shared with every other realdb file in the suite.
    expect(orderNumberSeq(secondDto.orderNumber)).toBeGreaterThan(
      orderNumberSeq(firstDto.orderNumber),
    );
  });

  it('creates no parallel POS numbering sequence', async () => {
    // `nextDraftOrderNumber` had zero call sites, so `0001_counter_sequences.sql`
    // deliberately created only two sequences. This is what notices if a later
    // migration adds a third and the POS quietly starts using it — customers
    // would see two numbering spaces on their receipts.
    //
    // Restricted to the sequences the MIGRATIONS create: drizzle's own ledger
    // table brings an identity sequence of its own, which is not a numbering
    // decision this project made.
    const rows = await pg.execute<{ relname: string }>(
      sql`select relname from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'S' and n.nspname = 'public'
          order by relname`,
    );
    expect(rows.map((row) => row.relname)).toEqual(['order_number_seq', 'rma_number_seq']);
  });

  it('is idempotent: a repeated complete returns the same order, minting no number', async () => {
    const { storeId, draftId } = await seedScenario();

    const firstDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);
    const repeatDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    expect(repeatDto.id).toBe(firstDto.id);
    expect(repeatDto.orderNumber).toBe(firstDto.orderNumber);
    expect(await countStoreOrders(storeId)).toBe(1);
  });

  it('converges on the prior order after a crash between create and mark-converted', async () => {
    /**
     * The retry the `orders_idempotency_key_key` index exists for: the order was
     * created but the process died before the draft was marked converted, so the
     * retry gets past the short-circuit and reaches the insert again. It must
     * collide on `draft:<id>` and converge — a second order number allocated for
     * the doomed insert is a harmless gap in the sequence, a SECOND ORDER is not.
     */
    const quantity = 2;
    const { storeId, locationId, variantId, draftId } = await seedScenario(quantity);
    const firstDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    // Both columns move together: `draft_orders_converted_order_check` states
    // that a `completed` draft has an order and a non-completed one does not, so
    // clearing only one of them is not a state the table can hold.
    await pg
      .update(draftOrders)
      .set({ status: 'open', convertedOrderId: null })
      .where(eq(draftOrders.id, draftId));

    const retryDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    expect(retryDto.id).toBe(firstDto.id);
    expect(retryDto.orderNumber).toBe(firstDto.orderNumber);
    expect(await countStoreOrders(storeId)).toBe(1);
    // The doomed insert's reservation was rolled back, so stock reflects exactly
    // ONE sale — a retry that leaked its reservation would show 6 available.
    const level = await findLevel(variantId, locationId);
    expect(level?.available).toBe(SEEDED_AVAILABLE - quantity);
    expect(level?.committed).toBe(0);
  });
});
