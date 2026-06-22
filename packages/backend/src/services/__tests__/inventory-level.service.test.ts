/**
 * Unit tests for `inventory.service` — the STORE (multi-location level) path.
 *
 * `mongodb-memory-server` is not available, so the `ProductVariant`/`Listing`/
 * `InventoryLevel` models and the shared `catalog-write.service` helpers are
 * mocked. A store variant (`loadVariantMeta` resolves `ownerType: 'store'`) routes
 * stock mutations to the matching `InventoryLevel` row (default location when no
 * explicit `locationId`), then rolls up the variant scalar. These tests assert the
 * EXACT level filter + `$inc`, the level-grain `matchedCount` out-of-stock branch,
 * default-location resolution (the checkout path), and that the rollup is invoked.
 * The P2P (scalar) path lives in `inventory.service.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const variantFindById = vi.fn();
const variantFindOne = vi.fn();
const variantUpdateOne = vi.fn();
const listingFindById = vi.fn();
const levelUpdateOne = vi.fn();
const syncListingFacets = vi.fn().mockResolvedValue([]);
const recomputeVariantScalarFromLevels = vi.fn().mockResolvedValue(undefined);
const resolveDefaultLocationId = vi.fn();

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    findById: (...args: unknown[]) => variantFindById(...args),
    findOne: (...args: unknown[]) => variantFindOne(...args),
    updateOne: (...args: unknown[]) => variantUpdateOne(...args),
  },
}));

vi.mock('../../models/listing.js', () => ({
  Listing: {
    findById: (...args: unknown[]) => listingFindById(...args),
  },
}));

vi.mock('../../models/inventory-level.js', () => ({
  InventoryLevel: {
    updateOne: (...args: unknown[]) => levelUpdateOne(...args),
  },
}));

vi.mock('../catalog-write.service.js', () => ({
  syncListingFacets: (...args: unknown[]) => syncListingFacets(...args),
  recomputeVariantScalarFromLevels: (...args: unknown[]) =>
    recomputeVariantScalarFromLevels(...args),
  resolveDefaultLocationId: (...args: unknown[]) => resolveDefaultLocationId(...args),
}));

import { reserve, release, restock, commit, setAvailable } from '../inventory.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const VARIANT_ID = '000000000000000000000010';
const LISTING_ID = '000000000000000000000020';
const STORE_ID = '000000000000000000000040';
const DEFAULT_LOCATION_ID = '000000000000000000000050';
const EXPLICIT_LOCATION_ID = '000000000000000000000051';

/** `ProductVariant.findById(...).select(...).lean()` chain `loadVariantMeta` expects. */
function variantMetaDoc(tracked: boolean): unknown {
  return {
    select: () => ({
      lean: () => Promise.resolve({ listingId: LISTING_ID, inventory: { tracked } }),
    }),
  };
}

/** `Listing.findById(...).select(...).lean()` chain resolving a STORE listing. */
function storeListingDoc(): unknown {
  return {
    select: () => ({
      lean: () => Promise.resolve({ ownerType: 'store', storeId: STORE_ID }),
    }),
  };
}

beforeEach(() => {
  variantFindById.mockReset();
  variantFindOne.mockReset();
  variantUpdateOne.mockReset();
  listingFindById.mockReset();
  levelUpdateOne.mockReset();
  syncListingFacets.mockClear();
  recomputeVariantScalarFromLevels.mockClear();
  resolveDefaultLocationId.mockReset().mockResolvedValue(DEFAULT_LOCATION_ID);
});

describe('inventory.service.reserve (store level path)', () => {
  it('reserves at the level grain (guarded $inc) and rolls up the scalar', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await reserve(VARIANT_ID, 2);

    // No scalar $inc; the level row took the guarded decrement.
    expect(variantUpdateOne).not.toHaveBeenCalled();
    expect(levelUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = levelUpdateOne.mock.calls[0];
    expect(filter).toEqual({
      variantId: VARIANT_ID,
      locationId: DEFAULT_LOCATION_ID,
      available: { $gte: 2 },
    });
    expect(update).toEqual({ $inc: { available: -2, committed: 2 } });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('resolves the DEFAULT location when no locationId is supplied (checkout path)', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await reserve(VARIANT_ID, 1);

    expect(resolveDefaultLocationId).toHaveBeenCalledWith(STORE_ID);
    const [filter] = levelUpdateOne.mock.calls[0];
    expect(filter.locationId).toBe(DEFAULT_LOCATION_ID);
  });

  it('uses an explicit locationId without resolving the default', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await reserve(VARIANT_ID, 1, EXPLICIT_LOCATION_ID);

    expect(resolveDefaultLocationId).not.toHaveBeenCalled();
    const [filter] = levelUpdateOne.mock.calls[0];
    expect(filter.locationId).toBe(EXPLICIT_LOCATION_ID);
  });

  it('throws OUT_OF_STOCK when the level guarded update matches nothing', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await expect(reserve(VARIANT_ID, 5)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
    expect(recomputeVariantScalarFromLevels).not.toHaveBeenCalled();
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});

describe('inventory.service.release/restock/commit (store level path)', () => {
  it('release raises available and drops committed at the level, then rolls up', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await release(VARIANT_ID, 3);

    const [filter, update] = levelUpdateOne.mock.calls[0];
    expect(filter).toEqual({ variantId: VARIANT_ID, locationId: DEFAULT_LOCATION_ID });
    expect(update).toEqual({ $inc: { available: 3, committed: -3 } });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('restock raises available only at the level, then rolls up', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await restock(VARIANT_ID, 4);

    const [filter, update] = levelUpdateOne.mock.calls[0];
    expect(filter).toEqual({ variantId: VARIANT_ID, locationId: DEFAULT_LOCATION_ID });
    expect(update).toEqual({ $inc: { available: 4 } });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('commit drops committed only at the level, rolls up, and does NOT resync facets', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(storeListingDoc());
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await commit(VARIANT_ID, 2);

    const [filter, update] = levelUpdateOne.mock.calls[0];
    expect(filter).toEqual({ variantId: VARIANT_ID, locationId: DEFAULT_LOCATION_ID });
    expect(update).toEqual({ $inc: { committed: -2 } });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    // commit does not flip availability — no facet resync.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});

describe('inventory.service.setAvailable (store level path)', () => {
  it('absolute-sets the level (upsert preserving committed) and recomputes the scalar', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    variantFindOne.mockResolvedValueOnce({
      _id: VARIANT_ID,
      listingId: LISTING_ID,
      inventory: { tracked: true, available: 1, committed: 0 },
      save,
    });
    listingFindById.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve({ ownerType: 'store' }) }),
    });
    levelUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });

    await setAvailable(VARIANT_ID, LISTING_ID, EXPLICIT_LOCATION_ID, 25);

    expect(variantFindOne).toHaveBeenCalledWith({ _id: VARIANT_ID, listingId: LISTING_ID });
    // The store path writes the level, not the scalar via save().
    expect(save).not.toHaveBeenCalled();
    const [filter, update, opts] = levelUpdateOne.mock.calls[0];
    expect(filter).toEqual({ variantId: VARIANT_ID, locationId: EXPLICIT_LOCATION_ID });
    expect(update).toEqual({
      $set: { available: 25 },
      $setOnInsert: { listingId: LISTING_ID, committed: 0 },
    });
    expect(opts).toEqual({ upsert: true });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });
});
