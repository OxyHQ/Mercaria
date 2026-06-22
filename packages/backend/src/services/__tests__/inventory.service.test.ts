/**
 * Unit tests for `inventory.service`.
 *
 * `mongodb-memory-server` is not available, so the `ProductVariant` model and
 * the shared `syncListingFacets` helper are mocked. Tests assert the EXACT Mongo
 * filter + `$inc` and the `matchedCount` branch (the race-safety contract), the
 * untracked short-circuit, and that facets are resynced after stock-flipping
 * changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateOne = vi.fn();
const findById = vi.fn();
const findOne = vi.fn();
const syncListingFacets = vi.fn().mockResolvedValue([]);

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    updateOne: (...args: unknown[]) => updateOne(...args),
    findById: (...args: unknown[]) => findById(...args),
    findOne: (...args: unknown[]) => findOne(...args),
  },
}));

vi.mock('../catalog-write.service.js', () => ({
  syncListingFacets: (...args: unknown[]) => syncListingFacets(...args),
}));

import { reserve, commit, release, setAvailable } from '../inventory.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const VARIANT_ID = '000000000000000000000010';
const LISTING_ID = '000000000000000000000020';

/** Build the `.select(...).lean()` chain `loadVariantMeta` expects. */
function metaDoc(tracked: boolean): unknown {
  return {
    select: () => ({
      lean: () => Promise.resolve({ listingId: LISTING_ID, inventory: { tracked } }),
    }),
  };
}

beforeEach(() => {
  updateOne.mockReset();
  findById.mockReset();
  findOne.mockReset();
  syncListingFacets.mockClear();
});

describe('inventory.service.reserve', () => {
  it('decrements available and raises committed when available >= qty', async () => {
    findById.mockReturnValueOnce(metaDoc(true));
    updateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await reserve(VARIANT_ID, 2);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({
      _id: VARIANT_ID,
      'inventory.tracked': true,
      'inventory.available': { $gte: 2 },
    });
    expect(update).toEqual({
      $inc: { 'inventory.available': -2, 'inventory.committed': 2 },
    });
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('throws OUT_OF_STOCK when the guarded update matches no document', async () => {
    findById.mockReturnValueOnce(metaDoc(true));
    updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await expect(reserve(VARIANT_ID, 5)).rejects.toSatisfy((err: unknown) => {
      return isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK;
    });
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('short-circuits (no update) for an untracked variant', async () => {
    findById.mockReturnValueOnce(metaDoc(false));

    await reserve(VARIANT_ID, 99);

    expect(updateOne).not.toHaveBeenCalled();
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('is a no-op for non-positive quantities', async () => {
    await reserve(VARIANT_ID, 0);
    expect(findById).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('inventory.service.release', () => {
  it('restores available and drops committed', async () => {
    findById.mockReturnValueOnce(metaDoc(true));
    updateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await release(VARIANT_ID, 3);

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: VARIANT_ID, 'inventory.tracked': true });
    expect(update).toEqual({
      $inc: { 'inventory.available': 3, 'inventory.committed': -3 },
    });
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('short-circuits for an untracked variant', async () => {
    findById.mockReturnValueOnce(metaDoc(false));
    await release(VARIANT_ID, 3);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('inventory.service.commit', () => {
  it('reduces committed only (available untouched)', async () => {
    findById.mockReturnValueOnce(metaDoc(true));
    updateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await commit(VARIANT_ID, 4);

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: VARIANT_ID, 'inventory.tracked': true });
    expect(update).toEqual({ $inc: { 'inventory.committed': -4 } });
    // commit does not flip availability — no facet resync.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('short-circuits for an untracked variant', async () => {
    findById.mockReturnValueOnce(metaDoc(false));
    await commit(VARIANT_ID, 4);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('inventory.service.setAvailable', () => {
  it('absolute-sets available on a tracked variant (scoped to its listing) and resyncs facets', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    findOne.mockResolvedValueOnce({
      _id: VARIANT_ID,
      listingId: LISTING_ID,
      inventory: { tracked: true, available: 1, committed: 0 },
      save,
    });

    await setAvailable(VARIANT_ID, LISTING_ID, 25);

    expect(findOne).toHaveBeenCalledWith({ _id: VARIANT_ID, listingId: LISTING_ID });
    expect(save).toHaveBeenCalledTimes(1);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('rejects a negative or non-integer available before any lookup', async () => {
    await expect(setAvailable(VARIANT_ID, LISTING_ID, -1)).rejects.toSatisfy((err: unknown) =>
      isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
    await expect(setAvailable(VARIANT_ID, LISTING_ID, 1.5)).rejects.toSatisfy((err: unknown) =>
      isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
  });

  it('IDOR regression: a variant on a DIFFERENT listing resolves to NOT_FOUND with NO stock write', async () => {
    const OTHER_LISTING_ID = '000000000000000000000099';
    // The scoped `findOne({ _id, listingId })` matches nothing for another store's listing.
    findOne.mockResolvedValueOnce(null);

    await expect(setAvailable(VARIANT_ID, OTHER_LISTING_ID, 25)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );

    expect(findOne).toHaveBeenCalledWith({ _id: VARIANT_ID, listingId: OTHER_LISTING_ID });
    // No stock write and no facet resync happened.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});
