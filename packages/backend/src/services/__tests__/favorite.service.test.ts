/**
 * Unit tests for `favorite.service`.
 *
 * `mongodb-memory-server` is not available, so the `Favorite` and `Listing`
 * models — plus the catalog-hydration path — are mocked. Tests cover the F3
 * favorites contract: toggle on then off is idempotent and adjusts
 * `Listing.favoriteCount` (+1 / -1, the -1 clamped to count>0), and
 * `getFavoritedListingIds` returns exactly the favorited subset.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const favFindOne = vi.fn();
const favFind = vi.fn();
const favCreate = vi.fn();
const favDeleteOne = vi.fn();
const favCountDocuments = vi.fn();
const listingExists = vi.fn();
const listingUpdateOne = vi.fn();

vi.mock('../../models/favorite.js', () => ({
  Favorite: {
    findOne: (...args: unknown[]) => favFindOne(...args),
    find: (...args: unknown[]) => favFind(...args),
    create: (...args: unknown[]) => favCreate(...args),
    deleteOne: (...args: unknown[]) => favDeleteOne(...args),
    countDocuments: (...args: unknown[]) => favCountDocuments(...args),
  },
}));

vi.mock('../../models/listing.js', () => ({
  Listing: {
    exists: (...args: unknown[]) => listingExists(...args),
    updateOne: (...args: unknown[]) => listingUpdateOne(...args),
    find: vi.fn(),
  },
}));

vi.mock('../catalog-hydration.service.js', () => ({
  hydrateListings: vi.fn().mockResolvedValue([]),
}));

import { toggle, getFavoritedListingIds } from '../favorite.service.js';

const USER = 'user-1';
const LISTING_ID = '000000000000000000000001';

/** Build a `.select().lean()`-able query stub resolving to `value`. */
function selectLeanOf<T>(value: T) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

beforeEach(() => {
  favFindOne.mockReset();
  favFind.mockReset();
  favCreate.mockReset();
  favDeleteOne.mockReset();
  favCountDocuments.mockReset();
  listingExists.mockReset();
  listingUpdateOne.mockReset();
  listingUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});

describe('favorite.service.toggle', () => {
  it('creates the favorite and bumps favoriteCount +1 when absent', async () => {
    listingExists.mockResolvedValueOnce({ _id: LISTING_ID });
    favFindOne.mockReturnValueOnce(selectLeanOf(null));
    favCreate.mockResolvedValueOnce(undefined);

    const result = await toggle(USER, LISTING_ID);

    expect(result).toEqual({ saved: true });
    expect(favCreate).toHaveBeenCalledTimes(1);
    const [filter, update] = listingUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: LISTING_ID });
    expect(update).toEqual({ $inc: { favoriteCount: 1 } });
  });

  it('deletes the favorite and decrements favoriteCount -1 (clamped) when present', async () => {
    listingExists.mockResolvedValueOnce({ _id: LISTING_ID });
    favFindOne.mockReturnValueOnce(selectLeanOf({ _id: 'fav-1' }));
    favDeleteOne.mockResolvedValueOnce(undefined);

    const result = await toggle(USER, LISTING_ID);

    expect(result).toEqual({ saved: false });
    expect(favDeleteOne).toHaveBeenCalledWith({ _id: 'fav-1' });
    const [filter, update] = listingUpdateOne.mock.calls[0];
    // The -1 is clamped: only applies while favoriteCount > 0.
    expect(filter).toEqual({ _id: LISTING_ID, favoriteCount: { $gt: 0 } });
    expect(update).toEqual({ $inc: { favoriteCount: -1 } });
  });

  it('toggle on then off is idempotent (net zero favoriteCount change)', async () => {
    // On.
    listingExists.mockResolvedValueOnce({ _id: LISTING_ID });
    favFindOne.mockReturnValueOnce(selectLeanOf(null));
    favCreate.mockResolvedValueOnce(undefined);
    const on = await toggle(USER, LISTING_ID);

    // Off.
    listingExists.mockResolvedValueOnce({ _id: LISTING_ID });
    favFindOne.mockReturnValueOnce(selectLeanOf({ _id: 'fav-1' }));
    favDeleteOne.mockResolvedValueOnce(undefined);
    const off = await toggle(USER, LISTING_ID);

    expect(on).toEqual({ saved: true });
    expect(off).toEqual({ saved: false });
    const increments = listingUpdateOne.mock.calls.map((c) => (c[1] as { $inc: { favoriteCount: number } }).$inc.favoriteCount);
    expect(increments).toEqual([1, -1]);
    expect(increments.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('favorite.service.getFavoritedListingIds', () => {
  it('returns exactly the favorited subset of the queried ids', async () => {
    const A = '0000000000000000000000a1';
    const B = '0000000000000000000000b1';
    const C = '0000000000000000000000c1';
    // Only A and C are favorited.
    favFind.mockReturnValueOnce(selectLeanOf([{ listingId: A }, { listingId: C }]));

    const set = await getFavoritedListingIds(USER, [A, B, C]);

    expect(set.has(A)).toBe(true);
    expect(set.has(B)).toBe(false);
    expect(set.has(C)).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns an empty set for an empty id list (no query)', async () => {
    const set = await getFavoritedListingIds(USER, []);
    expect(set.size).toBe(0);
    expect(favFind).not.toHaveBeenCalled();
  });
});
