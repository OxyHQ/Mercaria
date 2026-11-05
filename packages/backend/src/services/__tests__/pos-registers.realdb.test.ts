/**
 * Named POS registers (`expanded_pos_registers`, #89) against a REAL server.
 *
 * What is under test is the free baseline holding as much as the paid tool
 * working: a sale with no register, or with one the store may not use, is
 * recorded on the location's default register exactly as every POS sale was
 * before this tool existed, and is never refused. Beside it: the allowance a
 * create takes and a removal gives back (in the same transaction as the row),
 * the archive-instead-of-delete rule that keeps a register's history, the
 * composite keys that keep a register inside its own store, and the daily
 * summary's aggregation — all of which only a real server can answer.
 *
 * Every assertion is scoped to stores this file mints; the database is shared
 * with every other realdb file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/** The paid transition's best-effort notifications; no Redis runs in the suite. */
vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowInventoryAlert: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));

import { uuidv7, isForeignKeyViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { orders } from '../../db/schema/orders.js';
import { posRegisters } from '../../db/schema/posRegisters.js';
import { insertListing } from '../../db/catalog/listingRepository.js';
import { insertVariants } from '../../db/catalog/variantRepository.js';
import { insertLevels } from '../../db/catalog/inventoryLevelRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertDraftOrder, replaceDraftPricing } from '../../db/pos/draftOrderRepository.js';
import { insertPosRegister } from '../../db/pos/posRegisterRepository.js';
import { findEntitlementUsage } from '../../db/merchantPlans/usageRepository.js';
import {
  listEntitlementGrants,
  revokeEntitlementGrant,
} from '../../db/merchantPlans/grantRepository.js';
import { invalidateMerchantEntitlements } from '../entitlements/resolve.js';
import { PlanCapabilityRefusal } from '../entitlements/enforce.js';
import {
  entitleStoreForTest,
  ensureCapabilityAvailable,
} from '../entitlements/__tests__/entitle-store.js';
import { ErrorCodes } from '../../utils/api-response.js';
import { completeDraftOrder } from '../draft-order.service.js';
import { deleteLocation } from '../location.service.js';
import {
  POS_REGISTERS_CAPABILITY,
  createPosRegister,
  getPosRegisterSalesSummary,
  listPosRegisters,
  removePosRegister,
  renamePosRegister,
} from '../pos-registers.service.js';

let pg: Database;

const CURRENCY = 'FAIR';
const ACTOR = 'oxy-user-register-manager';
const UNIT_PRICE = 1500;

beforeAll(async () => {
  pg = await connectPostgres();
  await ensureCapabilityAvailable(pg, POS_REGISTERS_CAPABILITY);
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

interface Shop {
  storeId: string;
  locationId: string;
  listingId: string;
  variantId: string;
}

/** A store with a default location and one stocked variant to sell. */
async function seedShop(label: string): Promise<Shop> {
  const store = await insertStore({
    oxyAccountId: ACTOR,
    handle: `pos-registers-${label}-${uuidv7()}`,
    name: `POS Registers ${label}`,
    description: '',
    brandColor: '#204060',
    defaultCurrency: CURRENCY,
  });
  const location = await insertLocation(store.id, {
    name: 'Shop floor',
    type: 'retail',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });
  const listing = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId: store.id,
      productTypeDefinitionId: null,
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
      priceRangeMinAmount: UNIT_PRICE,
      priceRangeMinCurrency: CURRENCY,
      priceRangeMaxAmount: UNIT_PRICE,
      priceRangeMaxCurrency: CURRENCY,
      hasInventory: true,
      variantCount: 1,
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
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default Title',
      priceAmount: UNIT_PRICE,
      priceCurrency: CURRENCY,
      inventoryTracked: true,
      inventoryAvailable: 1000,
      position: 0,
      optionValues: [],
    },
  ]);
  await insertLevels([
    {
      variantId: variant.id,
      listingId: listing.id,
      locationId: location.id,
      available: 1000,
      committed: 0,
    },
  ]);
  return {
    storeId: store.id,
    locationId: location.id,
    listingId: listing.id,
    variantId: variant.id,
  };
}

/** Ring up `quantity` units at `locationId` and complete the sale, naming `registerId`. */
async function sell(
  shop: Shop,
  input: { registerId?: string; quantity?: number; locationId?: string } = {},
): Promise<string> {
  const quantity = input.quantity ?? 1;
  const zero = { amount: 0, currency: CURRENCY } as const;
  const draft = await insertDraftOrder({
    storeId: shop.storeId,
    createdByOxyUserId: ACTOR,
    locationId: input.locationId ?? shop.locationId,
    currency: CURRENCY,
    totals: { subtotal: zero, discountTotal: zero, tax: zero, shipping: zero, grandTotal: zero },
  });
  const total = { amount: UNIT_PRICE * quantity, currency: CURRENCY } as const;
  await replaceDraftPricing(draft.id, {
    lineItems: [
      {
        listingId: shop.listingId,
        variantId: shop.variantId,
        title: 'Register Item',
        variantTitle: 'Default Title',
        unitPrice: { amount: UNIT_PRICE, currency: CURRENCY },
        quantity,
        optionValues: [],
      },
    ],
    appliedDiscounts: [],
    taxLines: [],
    totals: { subtotal: total, discountTotal: zero, tax: zero, shipping: zero, grandTotal: total },
  });
  const order = await completeDraftOrder(
    shop.storeId,
    draft.id,
    input.registerId ? { registerId: input.registerId } : {},
    ACTOR,
  );
  return order.id;
}

async function registerOf(orderId: string): Promise<string | null> {
  const [row] = await pg
    .select({ posRegisterId: orders.posRegisterId, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(eq(orders.id, orderId));
  expect(row?.paymentStatus, 'the sale itself must go through').toBe('paid');
  return row?.posRegisterId ?? null;
}

async function used(storeId: string): Promise<number> {
  const counter = await findEntitlementUsage(pg, {
    storeId,
    capabilityKey: POS_REGISTERS_CAPABILITY,
    periodKey: 'total',
  });
  return counter?.used ?? 0;
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

/** End the store's plan for this tool: revoke every grant it holds. */
async function endPlan(storeId: string): Promise<void> {
  for (const grant of await listEntitlementGrants(pg, storeId)) {
    await revokeEntitlementGrant(pg, {
      id: grant.id,
      revokedByOxyUserId: 'test-operator',
      revocationReason: 'test: the plan ended',
    });
  }
  invalidateMerchantEntitlements(storeId);
}

describe('the free baseline is unchanged', () => {
  it('a free store sells on the default register, with or without a register id', async () => {
    const shop = await seedShop('free');
    expect(await registerOf(await sell(shop))).toBeNull();

    // A register row the store could not have created through the API (written
    // directly) is still not honoured while the store lacks the tool.
    const planted = await insertPosRegister(pg, {
      storeId: shop.storeId,
      locationId: shop.locationId,
      name: 'Planted',
      createdByOxyUserId: ACTOR,
    });
    expect(await registerOf(await sell(shop, { registerId: planted.id }))).toBeNull();

    const list = await listPosRegisters(shop.storeId, {});
    expect(list.attributionActive).toBe(false);
  });

  it('refuses a free store a NEW register, writing nothing', async () => {
    const shop = await seedShop('free-create');
    const refusal = await refusalOf(
      createPosRegister(shop.storeId, ACTOR, { locationId: shop.locationId, name: 'Till 2' }),
    );
    expect(refusal.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    const rows = await pg.select().from(posRegisters).where(eq(posRegisters.storeId, shop.storeId));
    expect(rows).toHaveLength(0);
  });
});

describe('the allowance', () => {
  it('a create takes one, the limit refuses the next, a removal gives one back', async () => {
    const shop = await seedShop('allowance');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 2,
    });

    const first = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'Till 1',
    });
    await createPosRegister(shop.storeId, ACTOR, { locationId: shop.locationId, name: 'Till 2' });
    expect(await used(shop.storeId)).toBe(2);

    const over = await refusalOf(
      createPosRegister(shop.storeId, ACTOR, { locationId: shop.locationId, name: 'Till 3' }),
    );
    expect(over.code).toBe(ErrorCodes.PLAN_LIMIT_REACHED);
    expect(await used(shop.storeId)).toBe(2);

    // At the ceiling, the registers the store has still take sales.
    expect(await registerOf(await sell(shop, { registerId: first.id }))).toBe(first.id);

    const removed = await removePosRegister(shop.storeId, first.id);
    expect(removed.outcome).toBe('archived');
    expect(await used(shop.storeId)).toBe(1);

    // A second removal of the same register gives nothing back twice.
    await expect(removePosRegister(shop.storeId, first.id)).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(await used(shop.storeId)).toBe(1);

    await createPosRegister(shop.storeId, ACTOR, { locationId: shop.locationId, name: 'Till 3' });
    expect(await used(shop.storeId)).toBe(2);
  });

  it('a duplicate live name is a 409 and takes nothing; an archived name is free again', async () => {
    const shop = await seedShop('names');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 5,
    });
    const front = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'Front',
    });
    await expect(
      createPosRegister(shop.storeId, ACTOR, { locationId: shop.locationId, name: 'FRONT' }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(await used(shop.storeId)).toBe(1);

    await sell(shop, { registerId: front.id });
    await removePosRegister(shop.storeId, front.id); // archived: it has a sale
    const again = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'Front',
    });
    expect(again.id).not.toBe(front.id);

    const renamed = await renamePosRegister(shop.storeId, again.id, 'Front counter');
    expect(renamed.name).toBe('Front counter');
  });

  it('refuses a location of another store', async () => {
    const shop = await seedShop('own');
    const other = await seedShop('other');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 5,
    });
    await expect(
      createPosRegister(shop.storeId, ACTOR, { locationId: other.locationId, name: 'Stolen' }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(await used(shop.storeId)).toBe(0);
  });
});

describe('a sale is attributed only to a live register of its own location, while entitled', () => {
  it('honours the register; falls back for archived, other-location and foreign registers', async () => {
    const shop = await seedShop('attribution');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 10,
    });
    const back = await insertLocation(shop.storeId, {
      name: 'Back room',
      type: 'warehouse',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: false,
    });
    const till = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'Till',
    });
    const backTill = await createPosRegister(shop.storeId, ACTOR, {
      locationId: back.id,
      name: 'Back till',
    });

    expect(await registerOf(await sell(shop, { registerId: till.id }))).toBe(till.id);
    expect(await registerOf(await sell(shop))).toBeNull();
    // A register at ANOTHER location of the same store: the default register.
    expect(await registerOf(await sell(shop, { registerId: backTill.id }))).toBeNull();
    // An id nobody has: the default register, and the sale goes through.
    expect(await registerOf(await sell(shop, { registerId: uuidv7() }))).toBeNull();

    // Another store's register.
    const other = await seedShop('attribution-other');
    await entitleStoreForTest(pg, {
      storeId: other.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 1,
    });
    const foreign = await createPosRegister(other.storeId, ACTOR, {
      locationId: other.locationId,
      name: 'Theirs',
    });
    expect(await registerOf(await sell(shop, { registerId: foreign.id }))).toBeNull();

    // Archived: the device still remembers it; the sale goes to the default.
    await removePosRegister(shop.storeId, till.id);
    expect(await registerOf(await sell(shop, { registerId: till.id }))).toBeNull();
  });

  it('when the plan ends, history stays and new sales fall back to the default register', async () => {
    const shop = await seedShop('downgrade');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 3,
    });
    const till = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'Till',
    });
    const before = await sell(shop, { registerId: till.id });
    expect(await registerOf(before)).toBe(till.id);

    await endPlan(shop.storeId);

    const after = await sell(shop, { registerId: till.id });
    expect(await registerOf(after)).toBeNull();
    expect(await registerOf(before), 'a past sale keeps its register').toBe(till.id);

    const list = await listPosRegisters(shop.storeId, {});
    expect(list.attributionActive).toBe(false);
    expect(list.registers.map((r) => r.id)).toEqual([till.id]);

    const refusal = await refusalOf(
      createPosRegister(shop.storeId, ACTOR, { locationId: shop.locationId, name: 'Till 2' }),
    );
    expect(refusal.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);

    // Still removable, and the summary still reads the attributed sale.
    const summary = await getPosRegisterSalesSummary(shop.storeId, {});
    expect(summary.rows.find((r) => r.registerId === till.id)?.salesCount).toBe(1);
    await expect(removePosRegister(shop.storeId, till.id)).resolves.toMatchObject({
      outcome: 'archived',
    });
  });
});

describe('the schema keeps a register inside its store', () => {
  it('refuses an order naming another store’s register (composite foreign key)', async () => {
    const shop = await seedShop('fk');
    const other = await seedShop('fk-other');
    const foreign = await insertPosRegister(pg, {
      storeId: other.storeId,
      locationId: other.locationId,
      name: 'Theirs',
      createdByOxyUserId: ACTOR,
    });
    const orderId = await sell(shop);
    let caught: unknown;
    try {
      await pg.execute(
        sql`update ${orders} set pos_register_id = ${foreign.id} where id = ${orderId}`,
      );
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught, 'orders_pos_register_id_store_id_fkey')).toBe(true);
  });

  it('refuses a register at another store’s location', async () => {
    const shop = await seedShop('loc-fk');
    const other = await seedShop('loc-fk-other');
    let caught: unknown;
    try {
      await insertPosRegister(pg, {
        storeId: shop.storeId,
        locationId: other.locationId,
        name: 'Misplaced',
        createdByOxyUserId: ACTOR,
      });
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught, 'pos_registers_location_id_store_id_fkey')).toBe(true);
  });

  it('a location with a live register is not deleted until the register is removed', async () => {
    const shop = await seedShop('location-delete');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 2,
    });
    const kiosk = await insertLocation(shop.storeId, {
      name: 'Kiosk',
      type: 'pop_up',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: false,
    });
    const register = await createPosRegister(shop.storeId, ACTOR, {
      locationId: kiosk.id,
      name: 'Kiosk till',
    });
    await expect(deleteLocation(shop.storeId, kiosk.id)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(removePosRegister(shop.storeId, register.id)).resolves.toMatchObject({
      outcome: 'deleted',
    });
    await expect(deleteLocation(shop.storeId, kiosk.id)).resolves.toBeUndefined();
    expect(await used(shop.storeId)).toBe(0);
  });
});

describe('the daily summary', () => {
  it('counts and totals each register’s sales per day, the default register included', async () => {
    const shop = await seedShop('summary');
    await entitleStoreForTest(pg, {
      storeId: shop.storeId,
      capability: POS_REGISTERS_CAPABILITY,
      limit: 5,
    });
    const a = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'A',
    });
    const b = await createPosRegister(shop.storeId, ACTOR, {
      locationId: shop.locationId,
      name: 'B',
    });

    await sell(shop, { registerId: a.id, quantity: 2 });
    await sell(shop, { registerId: a.id, quantity: 1 });
    await sell(shop, { registerId: b.id, quantity: 4 });
    await sell(shop, { quantity: 3 });

    // A sibling store's sales never leak in.
    const other = await seedShop('summary-other');
    await sell(other, { quantity: 7 });

    const summary = await getPosRegisterSalesSummary(shop.storeId, {});
    const today = new Date().toISOString().slice(0, 10);
    const byRegister = new Map(summary.rows.map((row) => [row.registerId, row]));
    expect(summary.rows.length).toBeGreaterThanOrEqual(3);
    expect(summary.rows.every((row) => row.locationId === shop.locationId)).toBe(true);

    expect(byRegister.get(a.id)).toMatchObject({
      day: today,
      salesCount: 2,
      grossSales: { amount: UNIT_PRICE * 3, currency: CURRENCY },
    });
    expect(byRegister.get(b.id)).toMatchObject({
      salesCount: 1,
      grossSales: { amount: UNIT_PRICE * 4, currency: CURRENCY },
    });
    expect(byRegister.get(null)).toMatchObject({
      salesCount: 1,
      grossSales: { amount: UNIT_PRICE * 3, currency: CURRENCY },
    });
    expect(summary.rows).toHaveLength(3);

    // Default register first within the day.
    expect(summary.rows[0]?.registerId).toBeNull();

    // A window that ends before the sales reads nothing.
    const empty = await getPosRegisterSalesSummary(shop.storeId, {
      from: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      to: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    expect(empty.rows).toHaveLength(0);
  });
});
