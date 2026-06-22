/**
 * Inventory service — race-safe stock atomicity WITHOUT transactions.
 *
 * Two stock models share ONE set of method signatures:
 *
 *  - STORE variants (`ownerType: 'store'`) stock at N locations through the
 *    standalone `InventoryLevel` collection. Each mutation is a single guarded
 *    `$inc` against the matching LEVEL row (`available: { $gte: qty }`), so two
 *    concurrent reserves cannot both succeed past the level's stock. After every
 *    level change the variant's scalar `inventory.{available,committed}` is
 *    recomputed as the SUM over its levels (the ROLLUP), so the storefront DTO and
 *    listing facets keep reading the scalar unchanged. A store mutator with no
 *    explicit `locationId` routes to the store's DEFAULT location.
 *
 *  - P2P variants (`ownerType: 'user'`) keep the scalar-only path: a guarded
 *    `$inc` against the variant document itself, no Location, no levels.
 *
 * `available` is decremented at RESERVE time and `committed` raised; `commit`
 * finalizes a sale (drop `committed`, stock already gone); `release` returns a
 * reservation (raise `available`, drop `committed`); `restock` raises `available`
 * on refund of already-committed stock. The trailing `locationId?` is optional on
 * every mutator — existing callers (`checkout.service`, `order.service.transition`)
 * pass none and store variants resolve the default location transparently.
 */

import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Listing, type IListing } from '../models/listing.js';
import { InventoryLevel } from '../models/inventory-level.js';
import { outOfStock, notFound } from '../lib/errors/error-codes.js';
import {
  syncListingFacets,
  recomputeVariantScalarFromLevels,
  resolveDefaultLocationId,
} from './catalog-write.service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

/** Minimal variant + ownership info used to route a stock mutation. */
interface VariantMeta {
  listingId: string;
  tracked: boolean;
  ownerType: IListing['ownerType'];
  storeId?: string;
  /** True iff the variant's stock lives in `InventoryLevel` (store variants). */
  isMultiLocation: boolean;
}

/**
 * Fetch the tracked flag, owning listing id, and ownership (P2P vs store) for a
 * variant, or null if the variant is missing. A store variant is multi-location
 * (stock in `InventoryLevel`); a P2P variant is scalar-only.
 */
async function loadVariantMeta(variantId: string): Promise<VariantMeta | null> {
  const variant = await ProductVariant.findById(variantId)
    .select('listingId inventory.tracked')
    .lean<Pick<IProductVariant, 'listingId' | 'inventory'> | null>();
  if (!variant) {
    return null;
  }
  const listingId = String(variant.listingId);

  const listing = await Listing.findById(listingId)
    .select('ownerType storeId')
    .lean<Pick<IListing, 'ownerType' | 'storeId'> | null>();
  const ownerType: IListing['ownerType'] = listing?.ownerType ?? 'user';
  const isMultiLocation = ownerType === 'store';

  const meta: VariantMeta = {
    listingId,
    tracked: variant.inventory.tracked,
    ownerType,
    isMultiLocation,
  };
  if (listing?.storeId) {
    meta.storeId = String(listing.storeId);
  }
  return meta;
}

/**
 * Resolve the location to operate on for a store variant: the explicit
 * `locationId` if supplied, otherwise the store's default location. Throws if the
 * variant's listing carries no store id (a misconfigured store variant).
 */
async function resolveStoreLocationId(meta: VariantMeta, locationId?: string): Promise<string> {
  if (locationId) {
    return locationId;
  }
  if (!meta.storeId) {
    throw notFound('No location for store');
  }
  return resolveDefaultLocationId(meta.storeId);
}

/**
 * Recompute a variant's scalar `inventory.{available,committed}` as the sum over
 * its `InventoryLevel` rows. Thin wrapper over the one rollup implementation in
 * `catalog-write.service` (kept there to avoid an import cycle).
 */
export async function rollupVariant(variantId: string): Promise<void> {
  await recomputeVariantScalarFromLevels(variantId);
}

/**
 * Reserve `qty` units of a variant. For a TRACKED variant this atomically
 * decrements `available` and raises `committed`, guarded so it can only succeed
 * when `available >= qty`; a losing/insufficient call throws `OUT_OF_STOCK`. An
 * UNTRACKED variant short-circuits (no stock to hold). STORE variants reserve at
 * the LEVEL grain (the resolved/explicit location) then roll up the scalar; P2P
 * variants reserve at the scalar grain.
 */
export async function reserve(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    const result = await InventoryLevel.updateOne(
      { variantId, locationId: loc, available: { $gte: qty } },
      { $inc: { available: -qty, committed: qty } },
    );
    if (result.matchedCount === 0) {
      throw outOfStock('Insufficient stock to reserve');
    }
    await rollupVariant(variantId);
  } else {
    const result = await ProductVariant.updateOne(
      { _id: variantId, 'inventory.tracked': true, 'inventory.available': { $gte: qty } },
      { $inc: { 'inventory.available': -qty, 'inventory.committed': qty } },
    );
    if (result.matchedCount === 0) {
      throw outOfStock('Insufficient stock to reserve');
    }
  }

  await syncListingFacets(meta.listingId);

  await maybeAlertLowStock(variantId, meta.listingId);
}

/**
 * Best-effort low-stock alert for a STORE-owned tracked variant after a reserve
 * drops its `available` to/below the threshold. Reads the ROLLED-UP scalar
 * `available` (recomputed for store variants by `reserve`). Never throws — a
 * notification failure must not affect the reservation. Uses a dynamic import of
 * the queue producer to avoid any module load-order fragility from the inventory
 * ↔ queue dependency cycle.
 */
async function maybeAlertLowStock(variantId: string, listingId: string): Promise<void> {
  try {
    const variant = await ProductVariant.findById(variantId)
      .select('title inventory.tracked inventory.available')
      .lean<Pick<IProductVariant, 'title' | 'inventory'> | null>();
    if (!variant || !variant.inventory.tracked) {
      return;
    }
    if (variant.inventory.available > config.orders.lowStockThreshold) {
      return;
    }

    const listing = await Listing.findById(listingId)
      .select('ownerType storeId')
      .lean<Pick<IListing, 'ownerType' | 'storeId'> | null>();
    if (!listing || listing.ownerType !== 'store' || !listing.storeId) {
      return;
    }

    const { enqueueLowStockAlert } = await import('../queue/producers.js');
    await enqueueLowStockAlert({
      storeId: String(listing.storeId),
      listingId,
      variantId,
      variantTitle: variant.title,
      available: variant.inventory.available,
    });
  } catch (err) {
    log.general.warn({ err, variantId, listingId }, 'Failed to evaluate/enqueue low-stock alert');
  }
}

/**
 * Commit a reserved `qty` (sale finalized). `available` was already decremented
 * at reserve time, so this only drops `committed`. Untracked short-circuits. STORE
 * variants drop `committed` at the level and roll up the scalar; P2P variants drop
 * it at the scalar grain. Available is unchanged, so facets are not resynced.
 */
export async function commit(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    await InventoryLevel.updateOne(
      { variantId, locationId: loc },
      { $inc: { committed: -qty } },
    );
    await rollupVariant(variantId);
  } else {
    await ProductVariant.updateOne(
      { _id: variantId, 'inventory.tracked': true },
      { $inc: { 'inventory.committed': -qty } },
    );
  }
}

/**
 * Release a reserved `qty` (reservation cancelled/expired). Raises `available`
 * and drops `committed`. Untracked short-circuits. STORE variants act at the
 * level then roll up; P2P variants act at the scalar grain. Recomputes facets in
 * case the variant flips back into stock.
 */
export async function release(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    await InventoryLevel.updateOne(
      { variantId, locationId: loc },
      { $inc: { available: qty, committed: -qty } },
    );
    await rollupVariant(variantId);
  } else {
    await ProductVariant.updateOne(
      { _id: variantId, 'inventory.tracked': true },
      { $inc: { 'inventory.available': qty, 'inventory.committed': -qty } },
    );
  }

  await syncListingFacets(meta.listingId);
}

/**
 * Raise `available` WITHOUT touching `committed` — used to return stock to the
 * pool on refund of an already-committed (paid) order, where `commit` already
 * zeroed the committed units. Tracked-only; untracked short-circuits; non-positive
 * quantities are a no-op. STORE variants act at the level then roll up; P2P
 * variants act at the scalar grain. Recomputes facets in case the variant flips
 * back into stock.
 */
export async function restock(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    await InventoryLevel.updateOne(
      { variantId, locationId: loc },
      { $inc: { available: qty } },
    );
    await rollupVariant(variantId);
  } else {
    await ProductVariant.updateOne(
      { _id: variantId, 'inventory.tracked': true },
      { $inc: { 'inventory.available': qty } },
    );
  }

  await syncListingFacets(meta.listingId);
}

/**
 * Admin absolute-set of `available` units on a TRACKED variant (e.g. restock).
 * Scoped to `listingId` so a store member can only set inventory on a variant
 * belonging to a listing they own — a variant whose `listingId` does not match
 * resolves to NOT_FOUND. Untracked variants ignore the value (always available).
 *
 * For a STORE variant the absolute set targets the given `locationId`'s level
 * (upserting the row if it does not exist yet, preserving any existing
 * `committed`), then the scalar is recomputed from the levels. For a P2P variant
 * the scalar is set directly and `locationId` is ignored (P2P has no locations).
 * Recomputes the parent listing's facets so `hasInventory`/`priceRange` reflect
 * the new state.
 */
export async function setAvailable(
  variantId: string,
  listingId: string,
  locationId: string,
  available: number,
): Promise<void> {
  if (available < 0 || !Number.isInteger(available)) {
    throw outOfStock('available must be a non-negative integer');
  }
  const variant = await ProductVariant.findOne({ _id: variantId, listingId });
  if (!variant) {
    throw notFound('Variant not found');
  }

  if (variant.inventory.tracked) {
    const listing = await Listing.findById(listingId)
      .select('ownerType')
      .lean<Pick<IListing, 'ownerType'> | null>();

    if (listing?.ownerType === 'store') {
      // `$set: { available }` alone preserves an existing row's `committed`;
      // `$setOnInsert` seeds `committed: 0` and the join fields only on insert.
      await InventoryLevel.updateOne(
        { variantId, locationId },
        {
          $set: { available },
          $setOnInsert: { listingId, committed: 0 },
        },
        { upsert: true },
      );
      await recomputeVariantScalarFromLevels(variantId);
    } else {
      variant.inventory.available = available;
      await variant.save();
    }
  }

  await syncListingFacets(String(variant.listingId));
}
