/**
 * Unit tests for `inventory.service` — the P2P (scalar) stock path.
 *
 * `mongodb-memory-server` is not available, so the `ProductVariant`/`Listing`
 * models and the shared `catalog-write.service` helpers are mocked. These tests
 * cover the P2P path: `loadVariantMeta` resolves the listing `ownerType` to
 * `'user'`, so `reserve`/`release`/`commit`/`setAvailable` act on the VARIANT
 * scalar. They assert the EXACT Mongo filter + `$inc` and the `matchedCount`
 * branch (the race-safety contract), the untracked short-circuit, and that facets
 * are resynced after stock-flipping changes. The store (level) path lives in
 * `inventory-level.service.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const variantUpdateOne = vi.fn();
const variantFindById = vi.fn();
const variantFindOne = vi.fn();
const listingFindById = vi.fn();
const levelUpdateOne = vi.fn();
const syncListingFacets = vi.fn().mockResolvedValue([]);
const recomputeVariantScalarFromLevels = vi.fn().mockResolvedValue(undefined);
const resolveDefaultLocationId = vi.fn();

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    updateOne: (...args: unknown[]) => variantUpdateOne(...args),
    findById: (...args: unknown[]) => variantFindById(...args),
    findOne: (...args: unknown[]) => variantFindOne(...args),
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

import { reserve, commit, release, setAvailable } from '../inventory.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const VARIANT_ID = '000000000000000000000010';
const LISTING_ID = '000000000000000000000020';

/** Build the `ProductVariant.findById(...).select(...).lean()` chain `loadVariantMeta` expects. */
function variantMetaDoc(tracked: boolean): unknown {
  return {
    select: () => ({
      lean: () => Promise.resolve({ listingId: LISTING_ID, inventory: { tracked } }),
    }),
  };
}

/** Build the `Listing.findById(...).select(...).lean()` chain resolving an ownerType. */
function listingOwnerDoc(ownerType: 'user' | 'store', storeId?: string): unknown {
  return {
    select: () => ({
      lean: () => Promise.resolve({ ownerType, ...(storeId ? { storeId } : {}) }),
    }),
  };
}

beforeEach(() => {
  variantUpdateOne.mockReset();
  variantFindById.mockReset();
  variantFindOne.mockReset();
  listingFindById.mockReset();
  levelUpdateOne.mockReset();
  syncListingFacets.mockClear();
  recomputeVariantScalarFromLevels.mockClear();
  resolveDefaultLocationId.mockReset();
});

describe('inventory.service.reserve (P2P scalar path)', () => {
  it('decrements available and raises committed when available >= qty', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));
    variantUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await reserve(VARIANT_ID, 2);

    expect(variantUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = variantUpdateOne.mock.calls[0];
    expect(filter).toEqual({
      _id: VARIANT_ID,
      'inventory.tracked': true,
      'inventory.available': { $gte: 2 },
    });
    expect(update).toEqual({
      $inc: { 'inventory.available': -2, 'inventory.committed': 2 },
    });
    expect(levelUpdateOne).not.toHaveBeenCalled();
    expect(recomputeVariantScalarFromLevels).not.toHaveBeenCalled();
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('throws OUT_OF_STOCK when the guarded update matches no document', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));
    variantUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await expect(reserve(VARIANT_ID, 5)).rejects.toSatisfy((err: unknown) => {
      return isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK;
    });
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('short-circuits (no update) for an untracked variant', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(false));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));

    await reserve(VARIANT_ID, 99);

    expect(variantUpdateOne).not.toHaveBeenCalled();
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('is a no-op for non-positive quantities', async () => {
    await reserve(VARIANT_ID, 0);
    expect(variantFindById).not.toHaveBeenCalled();
    expect(variantUpdateOne).not.toHaveBeenCalled();
  });
});

describe('inventory.service.release (P2P scalar path)', () => {
  it('restores available and drops committed', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));
    variantUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await release(VARIANT_ID, 3);

    const [filter, update] = variantUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: VARIANT_ID, 'inventory.tracked': true });
    expect(update).toEqual({
      $inc: { 'inventory.available': 3, 'inventory.committed': -3 },
    });
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('short-circuits for an untracked variant', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(false));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));
    await release(VARIANT_ID, 3);
    expect(variantUpdateOne).not.toHaveBeenCalled();
  });
});

describe('inventory.service.commit (P2P scalar path)', () => {
  it('reduces committed only (available untouched)', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(true));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));
    variantUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await commit(VARIANT_ID, 4);

    const [filter, update] = variantUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: VARIANT_ID, 'inventory.tracked': true });
    expect(update).toEqual({ $inc: { 'inventory.committed': -4 } });
    // commit does not flip availability — no facet resync.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('short-circuits for an untracked variant', async () => {
    variantFindById.mockReturnValueOnce(variantMetaDoc(false));
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));
    await commit(VARIANT_ID, 4);
    expect(variantUpdateOne).not.toHaveBeenCalled();
  });
});

describe('inventory.service.setAvailable (P2P scalar path)', () => {
  const LOCATION_ID = '000000000000000000000030';

  it('absolute-sets available on a tracked P2P variant (scoped to its listing) and resyncs facets', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    variantFindOne.mockResolvedValueOnce({
      _id: VARIANT_ID,
      listingId: LISTING_ID,
      inventory: { tracked: true, available: 1, committed: 0 },
      save,
    });
    listingFindById.mockReturnValueOnce(listingOwnerDoc('user'));

    await setAvailable(VARIANT_ID, LISTING_ID, LOCATION_ID, 25);

    expect(variantFindOne).toHaveBeenCalledWith({ _id: VARIANT_ID, listingId: LISTING_ID });
    expect(save).toHaveBeenCalledTimes(1);
    // P2P path writes the scalar directly — never the level.
    expect(levelUpdateOne).not.toHaveBeenCalled();
    expect(recomputeVariantScalarFromLevels).not.toHaveBeenCalled();
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('rejects a negative or non-integer available before any lookup', async () => {
    await expect(setAvailable(VARIANT_ID, LISTING_ID, LOCATION_ID, -1)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
    await expect(setAvailable(VARIANT_ID, LISTING_ID, LOCATION_ID, 1.5)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
  });

  it('IDOR regression: a variant on a DIFFERENT listing resolves to NOT_FOUND with NO stock write', async () => {
    const OTHER_LISTING_ID = '000000000000000000000099';
    // The scoped `findOne({ _id, listingId })` matches nothing for another store's listing.
    variantFindOne.mockResolvedValueOnce(null);

    await expect(setAvailable(VARIANT_ID, OTHER_LISTING_ID, LOCATION_ID, 25)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );

    expect(variantFindOne).toHaveBeenCalledWith({ _id: VARIANT_ID, listingId: OTHER_LISTING_ID });
    // No stock write and no facet resync happened.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});
