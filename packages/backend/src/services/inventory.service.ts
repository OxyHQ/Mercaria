/**
 * Inventory service — race-safe, variant-level stock atomicity WITHOUT
 * transactions.
 *
 * Each mutation is a single guarded `$inc` against the variant document, so two
 * concurrent reserves cannot both succeed past the available stock: the
 * `'inventory.available': { $gte: qty }` guard means at most one wins and the
 * loser sees `matchedCount === 0`. Untracked variants short-circuit (always
 * available). The multi-location seam (`inventory.levels`) reuses these same
 * method signatures with `arrayFilters` in the future — not built here.
 *
 * `available` is decremented at RESERVE time and `committed` raised; `commit`
 * finalizes a sale (drop `committed`, stock already gone); `release` returns a
 * reservation (raise `available`, drop `committed`).
 */

import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Listing, type IListing } from '../models/listing.js';
import { outOfStock, notFound } from '../lib/errors/error-codes.js';
import { syncListingFacets } from './catalog-write.service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

/** Fetch the minimal tracked/listing info for a variant, or null if missing. */
async function loadVariantMeta(
  variantId: string,
): Promise<Pick<IProductVariant, 'listingId'> & { tracked: boolean } | null> {
  const doc = await ProductVariant.findById(variantId)
    .select('listingId inventory.tracked')
    .lean<Pick<IProductVariant, 'listingId' | 'inventory'> | null>();
  if (!doc) {
    return null;
  }
  return { listingId: String(doc.listingId), tracked: doc.inventory.tracked };
}

/**
 * Reserve `qty` units of a variant. For a TRACKED variant this atomically
 * decrements `available` and raises `committed`, guarded so it can only succeed
 * when `available >= qty`; a losing/insufficient call throws `OUT_OF_STOCK`. An
 * UNTRACKED variant short-circuits (no stock to hold).
 */
export async function reserve(variantId: string, qty: number): Promise<void> {
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

  const result = await ProductVariant.updateOne(
    { _id: variantId, 'inventory.tracked': true, 'inventory.available': { $gte: qty } },
    { $inc: { 'inventory.available': -qty, 'inventory.committed': qty } },
  );

  if (result.matchedCount === 0) {
    throw outOfStock('Insufficient stock to reserve');
  }

  await syncListingFacets(meta.listingId);

  await maybeAlertLowStock(variantId, meta.listingId);
}

/**
 * Best-effort low-stock alert for a STORE-owned tracked variant after a reserve
 * drops its `available` to/below the threshold. Never throws — a notification
 * failure must not affect the reservation. Uses a dynamic import of the queue
 * producer to avoid any module load-order fragility from the inventory ↔ queue
 * dependency cycle.
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
 * at reserve time, so this only drops `committed`. Untracked short-circuits.
 */
export async function commit(variantId: string, qty: number): Promise<void> {
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

  await ProductVariant.updateOne(
    { _id: variantId, 'inventory.tracked': true },
    { $inc: { 'inventory.committed': -qty } },
  );
}

/**
 * Release a reserved `qty` (reservation cancelled/expired). Raises `available`
 * and drops `committed`. Untracked short-circuits. Recomputes facets in case the
 * variant flips back into stock.
 */
export async function release(variantId: string, qty: number): Promise<void> {
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

  await ProductVariant.updateOne(
    { _id: variantId, 'inventory.tracked': true },
    { $inc: { 'inventory.available': qty, 'inventory.committed': -qty } },
  );

  await syncListingFacets(meta.listingId);
}

/**
 * Raise `available` WITHOUT touching `committed` — used to return stock to the
 * pool on refund of an already-committed (paid) order, where `commit` already
 * zeroed the committed units. Tracked-only; untracked short-circuits; non-positive
 * quantities are a no-op. Recomputes facets in case the variant flips back into
 * stock.
 */
export async function restock(variantId: string, qty: number): Promise<void> {
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

  await ProductVariant.updateOne(
    { _id: variantId, 'inventory.tracked': true },
    { $inc: { 'inventory.available': qty } },
  );

  await syncListingFacets(meta.listingId);
}

/**
 * Admin absolute-set of `available` units on a TRACKED variant (e.g. restock).
 * Scoped to `listingId` so a store member can only set inventory on a variant
 * belonging to a listing they own — a variant whose `listingId` does not match
 * resolves to NOT_FOUND. Untracked variants ignore the value (always available).
 * Recomputes the parent listing's facets so `hasInventory`/`priceRange` reflect
 * the new state.
 */
export async function setAvailable(
  variantId: string,
  listingId: string,
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
    variant.inventory.available = available;
    await variant.save();
  }

  await syncListingFacets(String(variant.listingId));
}
