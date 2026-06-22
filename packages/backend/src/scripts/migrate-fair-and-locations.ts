/**
 * Locations + multi-location inventory backfill (Phase B2).
 *
 * Idempotent, dev-guarded migration that promotes the store inventory model from
 * a per-variant scalar to the standalone `InventoryLevel` collection routed by a
 * store `Location`:
 *
 *   1. Every Store WITHOUT a Location gets a default `warehouse` Location.
 *   2. Every STORE-owned tracked variant WITHOUT an `InventoryLevel` row gets one
 *      at its store's default location, seeded from the variant's current scalar
 *      `inventory.{available,committed}` (so the level sum already equals the
 *      scalar — no rescale, no scalar rewrite).
 *
 * It NEVER deletes anything and NEVER touches P2P (`ownerType: 'user'`) listings.
 * Re-running it is a no-op (skips stores that already have a location and variants
 * that already have a level). The FAIR currency relabel was handled by the B0
 * reseed; this script is purely the locations/levels backfill.
 *
 * Run from `packages/backend`:
 *   NODE_ENV=development bun src/scripts/migrate-fair-and-locations.ts
 */

import mongoose from 'mongoose';
import { connectDB } from '../lib/db.js';
import { log } from '../lib/logger.js';
import { Store, type IStore } from '../models/store.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Location, type ILocation } from '../models/location.js';
import { InventoryLevel } from '../models/inventory-level.js';

/**
 * Ensure a store has a default location, returning its id. Reuses the existing
 * default (or any location) if present; otherwise creates the default warehouse.
 */
async function ensureDefaultLocation(storeId: string): Promise<{ locationId: string; created: boolean }> {
  const existing = await Location.findOne({ storeId })
    .sort({ isDefault: -1, createdAt: 1 })
    .select('_id')
    .lean<Pick<ILocation, '_id'> | null>();
  if (existing) {
    return { locationId: String(existing._id), created: false };
  }
  const location = await Location.create({
    storeId,
    name: 'Default',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });
  return { locationId: String(location._id), created: true };
}

async function migrate(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    log.general.error('Refusing to migrate in production without ALLOW_PROD_SEED=true');
    process.exit(1);
  }

  await connectDB();

  // 1. Default location per store.
  const stores = await Store.find({}).select('_id').lean<Pick<IStore, '_id'>[]>();
  const locationByStore = new Map<string, string>();
  let locationsCreated = 0;
  for (const store of stores) {
    const storeId = String(store._id);
    const { locationId, created } = await ensureDefaultLocation(storeId);
    locationByStore.set(storeId, locationId);
    if (created) {
      locationsCreated += 1;
    }
  }

  // 2. One InventoryLevel per store-owned tracked variant lacking one.
  const storeListings = await Listing.find({ ownerType: 'store' })
    .select('_id storeId')
    .lean<Pick<IListing, '_id' | 'storeId'>[]>();
  const storeIdByListing = new Map<string, string>();
  for (const listing of storeListings) {
    if (listing.storeId) {
      storeIdByListing.set(String(listing._id), String(listing.storeId));
    }
  }

  const listingIds = [...storeIdByListing.keys()];
  let levelsCreated = 0;
  let levelsSkipped = 0;

  if (listingIds.length > 0) {
    const variants = await ProductVariant.find({ listingId: { $in: listingIds } })
      .select('_id listingId inventory.tracked inventory.available inventory.committed')
      .lean<Pick<IProductVariant, '_id' | 'listingId' | 'inventory'>[]>();

    for (const variant of variants) {
      if (!variant.inventory.tracked) {
        continue;
      }
      const variantId = String(variant._id);
      const listingId = String(variant.listingId);
      const storeId = storeIdByListing.get(listingId);
      if (!storeId) {
        continue;
      }
      const locationId = locationByStore.get(storeId);
      if (!locationId) {
        continue;
      }

      const alreadyHasLevel = await InventoryLevel.exists({ variantId });
      if (alreadyHasLevel) {
        levelsSkipped += 1;
        continue;
      }

      await InventoryLevel.create({
        variantId,
        listingId,
        locationId,
        available: variant.inventory.available,
        committed: variant.inventory.committed,
      });
      levelsCreated += 1;
    }
  }

  log.general.info(
    {
      stores: stores.length,
      locationsCreated,
      storeListings: storeListings.length,
      levelsCreated,
      levelsSkipped,
    },
    'Locations + inventory-level backfill complete',
  );
}

migrate()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Migration failed');
    try {
      await mongoose.connection.close();
    } catch (closeErr) {
      log.general.error({ err: closeErr }, 'Failed to close mongoose connection after migration error');
    }
    process.exit(1);
  });
