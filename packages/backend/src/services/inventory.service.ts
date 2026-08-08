/**
 * Inventory service — race-safe stock atomicity WITHOUT transactions.
 *
 * Two stock models share ONE set of method signatures:
 *
 *  - STORE variants (`ownerType: 'store'`) stock at N locations through
 *    `inventory_levels`. Each mutation is a single guarded UPDATE against the
 *    matching LEVEL row, so two concurrent reserves cannot both succeed past the
 *    level's stock. After every level change the variant's scalar
 *    `inventory_{available,committed}` is recomputed as the SUM over its levels
 *    (the ROLLUP), so the storefront DTO and listing facets keep reading the
 *    scalar unchanged. A store mutator with no explicit `locationId` routes to
 *    the store's DEFAULT location.
 *
 *  - P2P variants (`ownerType: 'user'`) keep the scalar-only path: a guarded
 *    UPDATE against the variant row itself, no location, no levels.
 *
 * `available` is decremented at RESERVE time and `committed` raised; `commit`
 * finalizes a sale (drop `committed`, stock already gone); `release` returns a
 * reservation (raise `available`, drop `committed`); `restock` raises `available`
 * on refund of already-committed stock. The trailing `locationId?` is optional on
 * every mutator — existing callers (`checkout.service`, `order.service.transition`)
 * pass none and store variants resolve the default location transparently.
 *
 * ## Ported to Postgres
 *
 * The race-safety contract is unchanged in substance and its mechanism is the
 * same: Mongo's `updateOne({available: {$gte: qty}}, {$inc: …})` and Postgres's
 * `UPDATE … SET available = available - $n WHERE … AND available >= $n` are both
 * CONDITIONAL WRITES whose predicate is re-evaluated against the winner's write.
 * What changes is how the refusal is reported — `matchedCount === 0` becomes a
 * repository returning `false` — and that a level row now clamps at zero rather
 * than being able to go negative through an unguarded `$inc`.
 */

import { findListingById } from '../db/catalog/listingRepository.js';
import {
  adjustVariantScalar,
  findVariantById,
  findVariantInListing,
  reserveVariantScalar,
  setVariantScalarAvailable,
} from '../db/catalog/variantRepository.js';
import {
  adjustLevel,
  reserveAtLocation,
  setLevelAvailable,
} from '../db/catalog/inventoryLevelRepository.js';
import type { ListingOwnerType } from '@mercaria/shared-types';
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
  variantId: string;
  listingId: string;
  tracked: boolean;
  ownerType: ListingOwnerType;
  storeId?: string;
  /** True iff the variant's stock lives in `inventory_levels` (store variants). */
  isMultiLocation: boolean;
}

/**
 * Fetch the tracked flag, owning listing id, and ownership (P2P vs store) for a
 * variant, or null if the variant is missing. A store variant is multi-location
 * (stock in `inventory_levels`); a P2P variant is scalar-only.
 */
async function loadVariantMeta(variantId: string): Promise<VariantMeta | null> {
  const variant = await findVariantById(variantId);
  if (!variant) {
    return null;
  }

  const listing = await findListingById(variant.listingId);
  const ownerType: ListingOwnerType = listing?.ownerType ?? 'user';

  const meta: VariantMeta = {
    variantId,
    listingId: variant.listingId,
    tracked: variant.inventoryTracked,
    ownerType,
    isMultiLocation: ownerType === 'store',
  };
  if (listing?.storeId) {
    meta.storeId = listing.storeId;
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
 * Recompute a variant's scalar `inventory_{available,committed}` as the sum over
 * its `inventory_levels` rows. Thin wrapper over the one rollup implementation in
 * `catalog-write.service` (kept there to avoid an import cycle).
 */
export async function rollupVariant(variantId: string): Promise<void> {
  await recomputeVariantScalarFromLevels(variantId);
}

/**
 * Load a variant's routing metadata, or short-circuit.
 *
 * @returns `null` when the caller should do nothing — an untracked variant has
 *   no stock to hold. Throws NOT_FOUND when the variant does not exist, which is
 *   a different thing and must not be silently absorbed.
 */
async function metaForMutation(variantId: string): Promise<VariantMeta | null> {
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  return meta.tracked ? meta : null;
}

/**
 * Reserve `qty` units of a variant. For a TRACKED variant this atomically
 * decrements `available` and raises `committed`, guarded so it can only succeed
 * when `available >= qty`; a losing or insufficient call throws `OUT_OF_STOCK`.
 * An UNTRACKED variant short-circuits (no stock to hold). STORE variants reserve
 * at the LEVEL grain (the resolved/explicit location) then roll up the scalar;
 * P2P variants reserve at the scalar grain.
 */
export async function reserve(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await metaForMutation(variantId);
  if (!meta) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    // The rowcount IS the answer: `false` means the guard refused, never
    // "nothing to do".
    if (!(await reserveAtLocation(variantId, loc, qty))) {
      throw outOfStock('Insufficient stock to reserve');
    }
    await rollupVariant(variantId);
  } else if (!(await reserveVariantScalar(variantId, qty))) {
    throw outOfStock('Insufficient stock to reserve');
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
    const variant = await findVariantById(variantId);
    if (!variant || !variant.inventoryTracked) {
      return;
    }
    if (variant.inventoryAvailable > config.orders.lowStockThreshold) {
      return;
    }

    const listing = await findListingById(listingId);
    if (!listing || listing.ownerType !== 'store' || !listing.storeId) {
      return;
    }

    const { enqueueLowStockAlert } = await import('../queue/producers.js');
    await enqueueLowStockAlert({
      storeId: listing.storeId,
      listingId,
      variantId,
      variantTitle: variant.title,
      available: variant.inventoryAvailable,
    });
  } catch (err) {
    log.general.warn({ err, variantId, listingId }, 'Failed to evaluate/enqueue low-stock alert');
  }
}

/**
 * Commit a reserved `qty` (sale finalized). `available` was already decremented
 * at reserve time, so this only drops `committed`. Untracked short-circuits.
 * STORE variants drop `committed` at the level and roll up the scalar; P2P
 * variants drop it at the scalar grain. Available is unchanged, so facets are not
 * resynced.
 */
export async function commit(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await metaForMutation(variantId);
  if (!meta) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    await adjustLevel(variantId, loc, { committed: -qty });
    await rollupVariant(variantId);
  } else {
    await adjustVariantScalar(variantId, { committed: -qty });
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
  const meta = await metaForMutation(variantId);
  if (!meta) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    await adjustLevel(variantId, loc, { available: qty, committed: -qty });
    await rollupVariant(variantId);
  } else {
    await adjustVariantScalar(variantId, { available: qty, committed: -qty });
  }

  await syncListingFacets(meta.listingId);
}

/**
 * Raise `available` WITHOUT touching `committed` — used to return stock to the
 * pool on refund of an already-committed (paid) order, where `commit` already
 * zeroed the committed units. Tracked-only; untracked short-circuits;
 * non-positive quantities are a no-op. STORE variants act at the level then roll
 * up; P2P variants act at the scalar grain. Recomputes facets in case the variant
 * flips back into stock.
 */
export async function restock(variantId: string, qty: number, locationId?: string): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await metaForMutation(variantId);
  if (!meta) {
    return;
  }

  if (meta.isMultiLocation) {
    const loc = await resolveStoreLocationId(meta, locationId);
    await adjustLevel(variantId, loc, { available: qty });
    await rollupVariant(variantId);
  } else {
    await adjustVariantScalar(variantId, { available: qty });
  }

  await syncListingFacets(meta.listingId);
}

/**
 * Admin absolute-set of `available` units on a TRACKED variant (e.g. restock).
 * Scoped to `listingId` so a store member can only set inventory on a variant
 * belonging to a listing they own — a variant whose listing does not match
 * resolves to NOT_FOUND. Untracked variants ignore the value (always available).
 *
 * For a STORE variant the absolute set targets the given `locationId`'s level
 * (creating the row if it does not exist yet, PRESERVING any existing
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
  const variant = await findVariantInListing(listingId, variantId);
  if (!variant) {
    throw notFound('Variant not found');
  }

  if (variant.inventoryTracked) {
    const listing = await findListingById(listingId);

    if (listing?.ownerType === 'store') {
      await setLevelAvailable({ variantId, listingId, locationId, available });
      await recomputeVariantScalarFromLevels(variantId);
    } else {
      await setVariantScalarAvailable(variantId, available);
    }
  }

  await syncListingFacets(variant.listingId);
}
