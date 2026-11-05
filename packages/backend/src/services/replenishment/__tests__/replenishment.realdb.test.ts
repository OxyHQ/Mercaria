/**
 * Replenishment planning against a real server (#89 `replenishment_planning`):
 * which order lines count as a sale, which location a sale belongs to, that one
 * store never sees another's, that refunds subtract, that the variant universe
 * is the store's tracked, plannable variants — and the plan gate: computing and
 * configuring need the capability, reading saved settings and removing an
 * override never do.
 *
 * Every store, listing, variant and order is minted by this file, and every
 * assertion reads a plan of a store this file owns.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { OrderStatus, ReplenishmentPlan } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { inventoryLevels, listings, productVariants } from '../../../db/schema/catalog.js';
import { orderItems, orders } from '../../../db/schema/orders.js';
import { locations, stores } from '../../../db/schema/stores.js';
import { replenishmentVariantOverrides } from '../../../db/schema/replenishment.js';
import { insertRefund } from '../../../db/orders/refundRepository.js';
import { putReplenishmentOverride } from '../../../db/replenishment/replenishmentRepository.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import { PlanCapabilityRefusal } from '../../entitlements/enforce.js';
import {
  entitleStoreForTest,
  ensureCapabilityAvailable,
} from '../../entitlements/__tests__/entitle-store.js';
import {
  computeReplenishmentPlan,
  readReplenishmentSettings,
  removeReplenishmentOverride,
  setReplenishmentOverride,
  updateReplenishmentSettings,
} from '../plan.service.js';
import { averageDailyDemand, projectStock, roundTo } from '../forecast.js';

let db: Database;
const RUN = uuidv7().slice(-12);
const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

beforeAll(async () => {
  db = await connectPostgres();
  await ensureCapabilityAvailable(db, 'replenishment_planning');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `replenish-${RUN}-${label}`,
      name: `Replenish ${label}`,
      description: '',
      brandColor: '#101010',
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('store insert returned no row');
  return row.id;
}

async function mintLocation(storeId: string, name: string, isDefault: boolean): Promise<string> {
  const [row] = await db
    .insert(locations)
    .values({ storeId, name, isDefault })
    .returning({ id: locations.id });
  if (!row) throw new Error('location insert returned no row');
  return row.id;
}

async function mintListing(
  storeId: string,
  status: 'active' | 'archived' = 'active',
): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: `Planned thing ${uuidv7().slice(-6)}`,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status,
    })
    .returning({ id: listings.id });
  if (!row) throw new Error('listing insert returned no row');
  return row.id;
}

async function mintVariant(
  listingId: string,
  title: string,
  options: { tracked?: boolean; createdAt?: Date } = {},
): Promise<string> {
  const [row] = await db
    .insert(productVariants)
    .values({
      listingId,
      title,
      sku: `SKU-${RUN}-${title}`,
      inventoryTracked: options.tracked ?? true,
      createdAt: options.createdAt ?? daysAgo(400),
    })
    .returning({ id: productVariants.id });
  if (!row) throw new Error('variant insert returned no row');
  return row.id;
}

async function stock(input: {
  variantId: string;
  listingId: string;
  locationId: string;
  available: number;
  committed?: number;
}): Promise<void> {
  await db.insert(inventoryLevels).values({ committed: 0, ...input });
}

const EUR = (amount: number) => ({
  shop: { amount, currency: 'EUR' as const },
  presentment: { amount, currency: 'EUR' as const },
});

/** One order of `storeId` with one line, in `status`, placed `createdAt`. */
async function sell(input: {
  storeId: string;
  listingId: string;
  variantId: string;
  quantity: number;
  status: OrderStatus;
  createdAt: Date;
  locationId?: string;
}): Promise<string> {
  const orderId = uuidv7();
  const total = 1000 * input.quantity;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `RPL-${orderId.slice(-12)}`,
    buyerOxyUserId: `realdb-replenish-buyer-${RUN}`,
    sellerType: 'store',
    storeId: input.storeId,
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
    totalsSubtotalShopAmount: total,
    totalsSubtotalShopCurrency: 'EUR',
    totalsSubtotalPresentmentAmount: total,
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
    totalsGrandTotalShopAmount: total,
    totalsGrandTotalShopCurrency: 'EUR',
    totalsGrandTotalPresentmentAmount: total,
    totalsGrandTotalPresentmentCurrency: 'EUR',
    status: input.status,
    createdAt: input.createdAt,
  });
  await db.insert(orderItems).values({
    orderId,
    listingId: input.listingId,
    variantId: input.variantId,
    title: 'A planned thing',
    variantTitle: 'Default',
    quantity: input.quantity,
    unitPriceShopAmount: 1000,
    unitPriceShopCurrency: 'EUR',
    unitPricePresentmentAmount: 1000,
    unitPricePresentmentCurrency: 'EUR',
    lineTotalShopAmount: total,
    lineTotalShopCurrency: 'EUR',
    lineTotalPresentmentAmount: total,
    lineTotalPresentmentCurrency: 'EUR',
    ...(input.locationId ? { locationId: input.locationId } : {}),
  });
  return orderId;
}

async function refund(input: {
  storeId: string;
  orderId: string;
  variantId: string;
  quantity: number;
  status: 'refunded' | 'rejected';
  restock: boolean;
}): Promise<void> {
  await insertRefund(
    {
      orderId: input.orderId,
      storeId: input.storeId,
      type: 'refund',
      status: input.status,
      totalRefunded: EUR(1000 * input.quantity),
      lineItems: [
        {
          variantId: input.variantId,
          quantity: input.quantity,
          amount: EUR(1000 * input.quantity),
          restock: input.restock,
        },
      ],
    },
    db,
  );
}

function rowFor(plan: ReplenishmentPlan, variantId: string) {
  return plan.rows.find((row) => row.variantId === variantId);
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

describe('the plan an entitled store computes', () => {
  let storeId: string;
  let otherStoreId: string;
  let main: string;
  let annex: string;
  let listingId: string;
  let steady: string;
  let oversold: string;
  let untracked: string;
  let archivedVariant: string;

  beforeAll(async () => {
    storeId = await mintStore('plan');
    otherStoreId = await mintStore('other');
    await entitleStoreForTest(db, { storeId, capability: 'replenishment_planning' });

    main = await mintLocation(storeId, 'Main', true);
    annex = await mintLocation(storeId, 'Annex', false);
    listingId = await mintListing(storeId);
    steady = await mintVariant(listingId, 'steady');
    oversold = await mintVariant(listingId, 'oversold');
    untracked = await mintVariant(listingId, 'untracked', { tracked: false });
    const archivedListing = await mintListing(storeId, 'archived');
    archivedVariant = await mintVariant(archivedListing, 'archived');

    await stock({ variantId: steady, listingId, locationId: main, available: 10, committed: 2 });
    await stock({ variantId: steady, listingId, locationId: annex, available: 3 });
    await stock({ variantId: oversold, listingId, locationId: main, available: -2 });
    await stock({ variantId: untracked, listingId, locationId: main, available: 5 });

    const base = { storeId, listingId, variantId: steady };
    // Counted: a storefront sale (no location → the default), a POS sale at the
    // annex, and an older delivered sale inside the long window only.
    await sell({ ...base, quantity: 5, status: 'paid', createdAt: daysAgo(3) });
    await sell({
      ...base,
      quantity: 4,
      status: 'processing',
      createdAt: daysAgo(10),
      locationId: annex,
    });
    await sell({
      ...base,
      quantity: 6,
      status: 'delivered',
      createdAt: daysAgo(60),
      locationId: main,
    });
    // Counted net of its refund: 5 sold, 2 refunded (not restocked) → 3. A
    // REJECTED refund on the same line subtracts nothing.
    const partial = await sell({
      ...base,
      quantity: 5,
      status: 'partially_refunded',
      createdAt: daysAgo(5),
      locationId: main,
    });
    await refund({
      storeId,
      orderId: partial,
      variantId: steady,
      quantity: 2,
      status: 'refunded',
      restock: false,
    });
    await refund({
      storeId,
      orderId: partial,
      variantId: steady,
      quantity: 1,
      status: 'rejected',
      restock: false,
    });
    // Not counted: outside the long window, a reservation, a cancellation, a full refund.
    await sell({ ...base, quantity: 50, status: 'paid', createdAt: daysAgo(100) });
    await sell({ ...base, quantity: 7, status: 'pending_payment', createdAt: daysAgo(2) });
    await sell({ ...base, quantity: 8, status: 'cancelled', createdAt: daysAgo(2) });
    await sell({ ...base, quantity: 9, status: 'refunded', createdAt: daysAgo(2) });
    // Another store's order naming the same variant id (order lines are
    // snapshots) is not this store's demand.
    await sell({
      storeId: otherStoreId,
      listingId,
      variantId: steady,
      quantity: 100,
      status: 'paid',
      createdAt: daysAgo(1),
    });
    // The oversold variant sold too.
    await sell({
      storeId,
      listingId,
      variantId: oversold,
      quantity: 2,
      status: 'delivered',
      createdAt: daysAgo(20),
    });
  });

  it('counts paid, uncancelled lines net of counted refunds, store-wide', async () => {
    const plan = await computeReplenishmentPlan({ storeId, now: NOW });
    const row = rowFor(plan, steady);
    expect(row).toBeDefined();
    // recent: 5 + 4 + 3 = 12; long adds the 60-day-old 6.
    expect(row?.unitsSoldRecent).toBe(12);
    expect(row?.unitsSoldLong).toBe(18);
    expect(row?.available).toBe(13);
    expect(row?.committed).toBe(2);
    expect(row?.onHand).toBe(15);
    expect(row?.locationId).toBeNull();

    const demand = averageDailyDemand({ unitsRecent: 12, unitsLong: 18, ageDays: 400 });
    expect(row?.averageDailyDemand).toBe(roundTo(demand, 2));
    const projection = projectStock({
      demandPerDay: demand,
      available: 13,
      settings: plan.settings,
      now: NOW,
    });
    expect(row?.suggestedOrderQuantity).toBe(projection.suggestedOrderQuantity);
    expect(row?.suggestedOrderQuantity).toBeGreaterThan(0);
    expect(row?.projectedStockoutDate).toBe(projection.projectedStockoutDate);
  });

  it('plans only tracked variants of plannable listings', async () => {
    const plan = await computeReplenishmentPlan({ storeId, now: NOW });
    const ids = plan.rows.map((row) => row.variantId);
    expect(ids).toContain(steady);
    expect(ids).toContain(oversold);
    expect(ids).not.toContain(untracked);
    expect(ids).not.toContain(archivedVariant);
    expect(plan.totalRows).toBe(2);
    expect(plan.truncated).toBe(false);
  });

  it('puts the oversold variant first, stocked out today', async () => {
    const plan = await computeReplenishmentPlan({ storeId, now: NOW });
    expect(plan.rows[0]?.variantId).toBe(oversold);
    expect(plan.rows[0]?.status).toBe('stocked_out');
    expect(plan.rows[0]?.available).toBe(-2);
    expect(plan.summary.stockedOut).toBe(1);
    const filtered = await computeReplenishmentPlan({ storeId, status: 'stocked_out', now: NOW });
    expect(filtered.rows.map((row) => row.variantId)).toEqual([oversold]);
  });

  it('attributes a line with no location to the default and a POS line to its register', async () => {
    const atMain = await computeReplenishmentPlan({ storeId, locationId: main, now: NOW });
    const mainRow = rowFor(atMain, steady);
    // 5 (storefront → default) + 3 (partial) recent; + 6 long.
    expect(mainRow?.unitsSoldRecent).toBe(8);
    expect(mainRow?.unitsSoldLong).toBe(14);
    expect(mainRow?.available).toBe(10);
    expect(mainRow?.locationId).toBe(main);

    const atAnnex = await computeReplenishmentPlan({ storeId, locationId: annex, now: NOW });
    const annexRow = rowFor(atAnnex, steady);
    expect(annexRow?.unitsSoldRecent).toBe(4);
    expect(annexRow?.unitsSoldLong).toBe(4);
    expect(annexRow?.available).toBe(3);
    // Neither stocked nor sold at the annex: not the annex's to plan.
    expect(rowFor(atAnnex, oversold)).toBeUndefined();
  });

  it('refuses a location of another store', async () => {
    const foreign = await mintLocation(otherStoreId, 'Elsewhere', true);
    await expect(
      computeReplenishmentPlan({ storeId, locationId: foreign, now: NOW }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('plans with saved settings and a variant override, and clears an empty override', async () => {
    const saved = await updateReplenishmentSettings(storeId, {
      leadTimeDays: 3,
      targetCoverDays: 10,
      safetyStockDays: 2,
    });
    expect(saved.settings).toMatchObject({ leadTimeDays: 3, saved: true });

    const withOverride = await setReplenishmentOverride(storeId, steady, { leadTimeDays: 30 });
    expect(withOverride.overrides).toEqual([
      expect.objectContaining({ variantId: steady, leadTimeDays: 30, targetCoverDays: null }),
    ]);
    const plan = await computeReplenishmentPlan({ storeId, now: NOW });
    expect(rowFor(plan, steady)).toMatchObject({
      leadTimeDays: 30,
      targetCoverDays: 10,
      safetyStockDays: 2,
      overridden: true,
    });
    expect(rowFor(plan, oversold)).toMatchObject({ leadTimeDays: 3, overridden: false });

    const cleared = await setReplenishmentOverride(storeId, steady, {
      leadTimeDays: null,
      targetCoverDays: null,
      safetyStockDays: null,
    });
    expect(cleared.overrides).toEqual([]);
  });

  it('refuses an override for a variant that is not this store’s', async () => {
    const otherListing = await mintListing(otherStoreId);
    const foreignVariant = await mintVariant(otherListing, 'foreign');
    await expect(
      setReplenishmentOverride(storeId, foreignVariant, { leadTimeDays: 5 }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('the table refuses an override of nothing and an out-of-range day count', async () => {
    await expect(
      db.insert(replenishmentVariantOverrides).values({ storeId, variantId: oversold }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(replenishmentVariantOverrides)
        .values({ storeId, variantId: oversold, safetyStockDays: 181 }),
    ).rejects.toThrow();
  });
});

describe('a store without the capability', () => {
  it('cannot compute a plan or change settings, and can still read and tidy what it saved', async () => {
    const storeId = await mintStore('unentitled');
    await mintLocation(storeId, 'Main', true);
    const listingId = await mintListing(storeId);
    const variantId = await mintVariant(listingId, 'kept');
    // An override saved while the store held the tool (written directly: the
    // plan has since ended).
    await putReplenishmentOverride(db, {
      storeId,
      variantId,
      leadTimeDays: 9,
      targetCoverDays: null,
      safetyStockDays: null,
    });

    const plan = await refusalOf(computeReplenishmentPlan({ storeId, now: NOW }));
    expect(plan.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    expect(plan.httpStatus).toBe(403);
    expect(
      (
        await refusalOf(
          updateReplenishmentSettings(storeId, {
            leadTimeDays: 1,
            targetCoverDays: 1,
            safetyStockDays: 1,
          }),
        )
      ).code,
    ).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    expect(
      (await refusalOf(setReplenishmentOverride(storeId, variantId, { leadTimeDays: 2 }))).code,
    ).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);

    const view = await readReplenishmentSettings(storeId);
    expect(view.settings.saved).toBe(false);
    expect(view.overrides).toEqual([expect.objectContaining({ variantId, leadTimeDays: 9 })]);

    const tidied = await removeReplenishmentOverride(storeId, variantId);
    expect(tidied.overrides).toEqual([]);
    const rows = await db
      .select({ id: replenishmentVariantOverrides.id })
      .from(replenishmentVariantOverrides)
      .where(eq(replenishmentVariantOverrides.variantId, variantId));
    expect(rows).toHaveLength(0);
  });
});
