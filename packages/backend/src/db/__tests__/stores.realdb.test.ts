/**
 * The stores-domain repositories, against a REAL Postgres database.
 *
 * `store.service.test.ts` mocks these functions, which is right for what it
 * tests — who may demote whom is pure logic. It is also blind to everything
 * below, and the blindness is total: a mocked repository accepts any argument
 * and returns whatever the test says, so a query correlated against the wrong
 * column, a transaction that is not one, and a constraint that does not exist
 * all look identical to a passing suite.
 *
 * Each block here covers something only a server can answer:
 *
 *  - the single-default LOCATION invariant is a partial unique index now, not a
 *    convention two statements politely observed;
 *  - `deleteLocation` raises SQLSTATE 23503 from the RESTRICT side, which
 *    `location.service` translates into its CONFLICT contract;
 *  - the `inventory_levels` cascade removes the rows Mongo leaked, and the
 *    variant ROLLUP has to be recomputed afterwards because a cascade does not
 *    touch a denormalized total;
 *  - `recomputeVariantRollup`'s correlated aggregate returns a NON-VACUOUS
 *    result — the one assertion that catches drizzle's bare-column trap, which
 *    returns `[]` with no error at all and shipped in a sibling Oxy port;
 *  - the column DEFAULTS `store.service` stopped substituting really are what
 *    the DDL carries.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isForeignKeyViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { inventoryLevels, listings, productVariants } from '../schema/catalog.js';
import { draftOrders } from '../schema/pos.js';
import { stores } from '../schema/stores.js';
import {
  adjustStoreProductCount,
  findStoreById,
  findStoresForMember,
  insertStore,
  insertStoreMember,
} from '../stores/storeRepository.js';
import {
  deleteLocation,
  findDefaultLocationId,
  insertLocation,
  updateLocation,
} from '../stores/locationRepository.js';
import { recomputeVariantRollup } from '../catalog/variantRepository.js';

let db: Database;

/** Store ids created by a test, dropped after it so the shared database stays clean. */
const createdStoreIds: string[] = [];

/** Create a store through the repository and register it for cleanup. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid, not a prefix: v7 is time-ordered, so two ids minted in the
  // same millisecond share their leading characters and a truncated suffix
  // collides with `stores_handle_key` — which is the constraint working, but
  // in the wrong test.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `realdb-${suffix}`,
      name: 'Realdb store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A listing and one variant on it, for the inventory-rollup blocks. */
async function makeVariant(storeId: string): Promise<{ listingId: string; variantId: string }> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: 'Realdb product',
      description: '',
      condition: 'new',
    })
    .returning({ id: listings.id });

  const [variant] = await db
    .insert(productVariants)
    .values({ listingId: listing.id, priceAmount: 1000, priceCurrency: 'FAIR' })
    .returning({ id: productVariants.id });

  return { listingId: listing.id, variantId: variant.id };
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // `listings.store_id` is RESTRICT, so the listings (and their cascading
    // variants and levels) go before the store does.
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(stores).where(eq(stores.id, storeId));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('insertStore', () => {
  it('creates the store and its founding owner in one transaction', async () => {
    const storeId = await makeStore();

    const store = await findStoreById(storeId);
    expect(store?.members).toHaveLength(1);
    expect(store?.members[0].role).toBe('owner');
    // `$type<StorePermission[]>` is a compile-time narrowing over a `text[]`;
    // this is the round trip that shows the array really survives as an array.
    expect(store?.members[0].permissions).toEqual(['store:manage']);
  });

  it('carries the column DEFAULTS the service stopped substituting', async () => {
    // `store.service.updateStoreSettings` no longer reconstructs an absent
    // settings block, on the grounds that these columns are NOT NULL with
    // exactly these defaults. That claim is DDL, so it is checked here.
    const store = await findStoreById(await makeStore());
    expect(store?.taxSettingsPricesIncludeTax).toBe(false);
    expect(store?.taxSettingsChargeTaxOnProducts).toBe(true);
    expect(store?.notificationSettingsLowStockAlerts).toBe(true);
    expect(store?.notificationSettingsOrderEmails).toBe(true);
    expect(store?.notificationSettingsLowStockThreshold).toBeNull();
    expect(store?.policiesReturnWindowDays).toBe(30);
  });

  it('refuses a second membership for the same user on the same store', async () => {
    const storeId = await makeStore();
    const store = await findStoreById(storeId);
    const existing = store?.members[0].oxyUserId ?? '';

    // Mongo's embedded array held the same user twice happily. This is the
    // invariant the table buys, and the reason `inviteMember`'s own duplicate
    // check is a nicer error rather than the only thing standing in the way.
    let caught: unknown;
    try {
      await insertStoreMember(storeId, {
        oxyUserId: existing,
        role: 'staff',
        permissions: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, 'store_members_store_id_oxy_user_id_key')).toBe(true);
  });

  it('finds a store through the membership join', async () => {
    const storeId = await makeStore();
    const store = await findStoreById(storeId);
    const owner = store?.members[0].oxyUserId ?? '';

    const found = await findStoresForMember(owner);
    expect(found.map((row) => row.id)).toEqual([storeId]);
    // The join must not drop the members it did not join on.
    expect(found[0].members).toHaveLength(1);
  });
});

describe('adjustStoreProductCount', () => {
  it('clamps at zero rather than going negative', async () => {
    const storeId = await makeStore();

    await adjustStoreProductCount(storeId, 1);
    await adjustStoreProductCount(storeId, -5);

    const store = await findStoreById(storeId);
    expect(store?.productCount).toBe(0);
  });
});

describe('the single-default location invariant', () => {
  it('promotes a new default and demotes the old one, atomically', async () => {
    const storeId = await makeStore();
    const first = await insertLocation(storeId, {
      name: 'First',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const second = await insertLocation(storeId, {
      name: 'Second',
      type: 'retail',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });

    // If the demote and the promote were two independent statements, the
    // partial unique index would have refused the second insert outright.
    expect(await findDefaultLocationId(storeId)).toBe(second.id);

    const promotedBack = await updateLocation(storeId, first.id, { isDefault: true });
    expect(promotedBack?.isDefault).toBe(true);
    expect(await findDefaultLocationId(storeId)).toBe(first.id);
  });

  it('falls back to any ACTIVE location when a store has no default', async () => {
    const storeId = await makeStore();
    const only = await insertLocation(storeId, {
      name: 'Not default',
      type: 'warehouse',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: true,
    });

    expect(await findDefaultLocationId(storeId)).toBe(only.id);
  });
});

describe('deleteLocation', () => {
  it('reports the variants whose inventory levels the cascade removed', async () => {
    const storeId = await makeStore();
    const { listingId, variantId } = await makeVariant(storeId);
    const keep = await insertLocation(storeId, {
      name: 'Keep',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const doomed = await insertLocation(storeId, {
      name: 'Doomed',
      type: 'pop_up',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: true,
    });

    await db.insert(inventoryLevels).values([
      { variantId, listingId, locationId: keep.id, available: 4 },
      { variantId, listingId, locationId: doomed.id, available: 6 },
    ]);
    await recomputeVariantRollup(variantId);

    const before = await db
      .select({ available: productVariants.inventoryAvailable })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    // NON-VACUOUS: the correlated aggregate really summed both level rows. A
    // subquery whose correlation renders as a bare column returns nothing and
    // rolls up to 0 here, silently — this assertion is what catches that.
    expect(before[0]?.available).toBe(10);

    const result = await deleteLocation(storeId, doomed.id);
    expect(result.deleted).toBe(true);
    expect(result.affectedVariantIds).toEqual([variantId]);

    // The FK removed the orphaned level row Mongo used to leak...
    const remaining = await db
      .select({ id: inventoryLevels.id })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.variantId, variantId));
    expect(remaining).toHaveLength(1);

    // ...and it did NOT update the denormalized total, which is exactly why
    // `location.service` recomputes each affected variant afterwards.
    const stale = await db
      .select({ available: productVariants.inventoryAvailable })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    expect(stale[0]?.available).toBe(10);

    await recomputeVariantRollup(variantId);
    const rolled = await db
      .select({ available: productVariants.inventoryAvailable })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    expect(rolled[0]?.available).toBe(4);
  });

  it('is REFUSED by a draft order holding the location (23503)', async () => {
    const storeId = await makeStore();
    const held = await insertLocation(storeId, {
      name: 'Held',
      type: 'retail',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: true,
    });

    await db.insert(draftOrders).values({
      storeId,
      locationId: held.id,
      createdByOxyUserId: 'cashier-1',
      currency: 'FAIR',
      totalsSubtotalAmount: 0,
      totalsSubtotalCurrency: 'FAIR',
      totalsDiscountTotalAmount: 0,
      totalsDiscountTotalCurrency: 'FAIR',
      totalsTaxAmount: 0,
      totalsTaxCurrency: 'FAIR',
      totalsShippingAmount: 0,
      totalsShippingCurrency: 'FAIR',
      totalsGrandTotalAmount: 0,
      totalsGrandTotalCurrency: 'FAIR',
    });

    // Under Mongo this delete SUCCEEDED and left the draft pointing at a
    // location that no longer existed. `SET NULL` was not an option: NULL
    // already means "the store's default location", so it would have silently
    // rerouted the reservation instead of refusing.
    let caught: unknown;
    try {
      await deleteLocation(storeId, held.id);
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught)).toBe(true);

    await db.delete(draftOrders).where(eq(draftOrders.storeId, storeId));
  });

  it('refuses to delete a location belonging to another store', async () => {
    const owner = await makeStore();
    const other = await makeStore();
    const location = await insertLocation(owner, {
      name: 'Owned',
      type: 'warehouse',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: true,
    });

    const result = await deleteLocation(other, location.id);
    expect(result.deleted).toBe(false);
    expect(result.affectedVariantIds).toEqual([]);
  });
});
