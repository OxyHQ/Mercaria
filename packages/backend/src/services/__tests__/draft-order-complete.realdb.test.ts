/**
 * The POS sale — `completeDraftOrder` — against a REAL MongoDB replica set.
 *
 * ## Why this file exists
 *
 * `draft-order.service.test.ts` mocks the `Order` model, and a mocked
 * `Order.create` accepts ANY document — including one the real schema rejects.
 * That blind spot hid a total, production-breaking bug: `completeDraftOrder` built
 * its `Order.create` payload without an `orderNumber`, which
 * `models/order.ts` declares `required: true` and indexes UNIQUE. Every POS sale
 * would have thrown `Order validation failed: orderNumber: Path `orderNumber` is
 * required.` on a real mongod — while the mocked suite stayed green, because the
 * mock never runs a validator.
 *
 * Every other order-creating path (`checkout.service`, `connector-sync.service`)
 * mints one with `nextOrderNumber()`; the POS path was the only one that did not.
 *
 * The tests below therefore assert against the REAL Mongoose model, on a real
 * server, through the real service — the only combination that can tell a valid
 * document from an invalid one.
 *
 * A replica SET rather than a standalone, because the sale's convergence property
 * rests on the unique `idempotencyKey`/`orderNumber` indexes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Types } from 'mongoose';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { stores } from '../../db/schema/stores.js';
import { listings } from '../../db/schema/catalog.js';
import { locations } from '../../db/schema/stores.js';
import { insertListing } from '../../db/catalog/listingRepository.js';
import { insertVariants } from '../../db/catalog/variantRepository.js';
import { findLevel, insertLevels } from '../../db/catalog/inventoryLevelRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';

/**
 * This test spans BOTH databases, and that is what the migration looks like
 * mid-flight rather than an accident of the fixture.
 *
 * The POS draft order and the Order it converts into are still Mongo. Its
 * STORE, LOCATION, LISTING, VARIANT and STOCK are not — the stores and catalogue
 * domains are ported, so `resolveDefaultLocationId`, `inventory.commit` and
 * `order-hydration.service` all read Postgres. The scenario seeds the store on
 * BOTH sides under the SAME id, which is exactly what the Fase 4 backfill
 * produces since it copies `_id` verbatim.
 */
let pg: Database;

/** Postgres store ids this file seeded, dropped between tests. The Postgres
 *  database is shared with every other realdb file in the suite, so this file
 *  cleans up after ITSELF rather than truncating the table. */
const seededStoreIds: string[] = [];

const uri = process.env.MERCARIA_TEST_MONGODB_URI;

/** The store settlement currency used throughout — FAIR needs no FX provider. */
const CURRENCY = 'FAIR';
/** The POS operator taking the sale. */
const ACTOR_OXY_USER_ID = 'oxy-user-pos-operator';
/** Unit price of the seeded variant, in minor units. */
const UNIT_PRICE_AMOUNT = 2500;
/** Stock seeded at the register location. */
const SEEDED_AVAILABLE = 10;

let Store: typeof import('../../models/store.js').Store;
let Location: typeof import('../../models/location.js').Location;
let DraftOrder: typeof import('../../models/draft-order.js').DraftOrder;
let Order: typeof import('../../models/order.js').Order;
let Counter: typeof import('../../models/counter.js').Counter;
let completeDraftOrder: typeof import('../draft-order.service.js').completeDraftOrder;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  await mongoose.connect(uri, { dbName: 'mercaria-draft-complete-test' });

  ({ Store } = await import('../../models/store.js'));
  ({ Location } = await import('../../models/location.js'));
  ({ DraftOrder } = await import('../../models/draft-order.js'));
  ({ Order } = await import('../../models/order.js'));
  ({ Counter } = await import('../../models/counter.js'));
  ({ completeDraftOrder } = await import('../draft-order.service.js'));

  // The unique `orderNumber` and `idempotencyKey` indexes are half of what is
  // under test here; Mongoose builds them lazily.
  await Promise.all([Order.syncIndexes(), DraftOrder.syncIndexes()]);

  pg = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await closePostgres();
});

beforeEach(async () => {
  for (const storeId of seededStoreIds.splice(0)) {
    // `listings.store_id` is RESTRICT, so the listings — and their cascading
    // variants and inventory levels — go before the locations and the store.
    await pg.delete(listings).where(eq(listings.storeId, storeId));
    await pg.delete(locations).where(eq(locations.storeId, storeId));
    await pg.delete(stores).where(eq(stores.id, storeId));
  }
  await Promise.all([
    Store.deleteMany({}),
    Location.deleteMany({}),
    DraftOrder.deleteMany({}),
    Order.deleteMany({}),
    Counter.deleteMany({}),
  ]);
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
 * line. Every id is a String on the documents that reference it, matching the
 * repo's cross-collection convention.
 */
async function seedScenario(quantity = 2): Promise<Scenario> {
  const store = await Store.create({
    handle: `pos-store-${new Types.ObjectId().toHexString()}`,
    name: 'POS Test Store',
    brandColor: '#123456',
    defaultCurrency: CURRENCY,
    members: [{ oxyUserId: ACTOR_OXY_USER_ID, role: 'owner' }],
  });
  const storeId = String(store._id);

  // The same store, on the Postgres side, under the same id. `order-hydration`
  // reads it from there; without this row the completed order hydrates with no
  // merchant summary and the assertion below fails for a reason that has
  // nothing to do with the draft-order logic under test.
  seededStoreIds.push(storeId);
  await pg.insert(stores).values({
    id: storeId,
    handle: store.handle,
    name: store.name,
    description: '',
    brandColor: store.brandColor,
    defaultCurrency: CURRENCY,
  });

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
  const draft = await DraftOrder.create({
    storeId,
    locationId,
    createdByOxyUserId: ACTOR_OXY_USER_ID,
    status: 'open',
    currency: CURRENCY,
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
    discountCodes: [],
    appliedDiscounts: [],
    taxLines: [],
    totals: {
      subtotal: { amount: lineTotal, currency: CURRENCY },
      discountTotal: { amount: 0, currency: CURRENCY },
      tax: { amount: 0, currency: CURRENCY },
      shipping: { amount: 0, currency: CURRENCY },
      grandTotal: { amount: lineTotal, currency: CURRENCY },
    },
  });

  return { storeId, locationId, listingId, variantId, draftId: String(draft._id) };
}

describe('completeDraftOrder writes an order a REAL server accepts', () => {
  it('takes the sale — the order carries the required, unique orderNumber', async () => {
    /**
     * The assertion a mocked `Order.create` cannot make. Without an `orderNumber`
     * in the payload this rejects with a Mongoose ValidationError before writing
     * anything, and every POS sale 500s.
     */
    const { storeId, draftId } = await seedScenario();

    const dto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    expect(dto.orderNumber).toMatch(/^MRC-\d{6}$/);
    // The customer-facing sequence, NOT the draft one: a POS sale is a real paid
    // order, listed and receipted beside every storefront order.
    expect(dto.orderNumber.startsWith('MRC-DRAFT-')).toBe(false);
    expect(dto.status).toBe('paid');
    expect(dto.sourceChannel).toBe('pos');

    // And it is what the SERVER stored, not just what hydration reported.
    const persisted = await Order.findById(dto.id).lean();
    expect(persisted?.orderNumber).toBe(dto.orderNumber);
  });

  it('mints a distinct number per sale, from the shared order sequence', async () => {
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
    // Both drew from the SAME `order` counter the storefront checkout uses — the
    // POS must not open a parallel numbering space customers would see.
    expect(firstDto.orderNumber).toBe('MRC-000001');
    expect(secondDto.orderNumber).toBe('MRC-000002');
    const counter = await Counter.findById('order').lean();
    expect(counter?.seq).toBe(2);
    expect(await Counter.findById('draftOrder').lean()).toBeNull();
  });

  it('is idempotent: a repeated complete returns the same order, minting no number', async () => {
    const { storeId, draftId } = await seedScenario();

    const firstDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);
    const repeatDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    expect(repeatDto.id).toBe(firstDto.id);
    expect(repeatDto.orderNumber).toBe(firstDto.orderNumber);
    expect(await Order.countDocuments({})).toBe(1);
    // The `convertedOrderId` short-circuit returns before any allocation, so the
    // sequence must not have advanced.
    const counter = await Counter.findById('order').lean();
    expect(counter?.seq).toBe(1);
  });

  it('converges on the prior order after a crash between create and mark-converted', async () => {
    /**
     * The retry the `idempotencyKey` index exists for: the order was created but
     * the process died before `draft.convertedOrderId` was written, so the retry
     * gets past the short-circuit and reaches `Order.create` again. It must
     * collide on `draft:<id>` and converge — a second order number allocated for
     * the doomed insert is a harmless gap in the sequence, a SECOND ORDER is not.
     */
    const quantity = 2;
    const { storeId, locationId, variantId, draftId } = await seedScenario(quantity);
    const firstDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    await DraftOrder.updateOne(
      { _id: draftId },
      { $set: { status: 'open' }, $unset: { convertedOrderId: '' } },
    );

    const retryDto = await completeDraftOrder(storeId, draftId, {}, ACTOR_OXY_USER_ID);

    expect(retryDto.id).toBe(firstDto.id);
    expect(retryDto.orderNumber).toBe(firstDto.orderNumber);
    expect(await Order.countDocuments({})).toBe(1);
    // The doomed insert's reservation was rolled back, so stock reflects exactly
    // ONE sale — a retry that leaked its reservation would show 6 available.
    const level = await findLevel(variantId, locationId);
    expect(level?.available).toBe(SEEDED_AVAILABLE - quantity);
    expect(level?.committed).toBe(0);
  });
});
