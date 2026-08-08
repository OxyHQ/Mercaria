/**
 * Unit tests for `favorite.service`.
 *
 * The wishlist and the catalogue are Postgres now, so what is mocked here are
 * the REPOSITORIES the service imports — `db/buyers/favoriteRepository` and
 * `db/catalog/listingRepository` — plus the catalog-hydration path. Tests cover
 * the F3 favorites contract: toggle on then off is idempotent and moves
 * `listings.favorite_count` by ±1, the count moves ONLY when the row really
 * changed, and `getFavoritedListingIds` returns exactly the favorited subset.
 *
 * ## What is deliberately NOT asserted here
 *
 * The clamp. It stopped being a predicate the service writes
 * (`{favoriteCount: {$gt: 0}}`) and became `greatest(0, …)` inside
 * `adjustFavoriteCount`, so the only test that can tell a clamp from its absence
 * runs against a live server — `src/db/__tests__/catalog.realdb.test.ts` does
 * that, including the concurrent-increment case the Mongo guard lost. A
 * mock-based duplicate here could only assert that the service passes `-1`,
 * which it does either way.
 *
 * What this file CAN tell, and now does, is the decision that replaced the
 * guard: the service counts a save or an unsave only when the repository
 * reports that a row was really written or removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertFavorite = vi.fn();
const deleteFavorite = vi.fn();
const favoriteExists = vi.fn();
const findSavedListingIds = vi.fn();
const listingExists = vi.fn();
const adjustFavoriteCount = vi.fn();

vi.mock('../../db/buyers/favoriteRepository.js', () => ({
  insertFavorite: (...args: unknown[]) => insertFavorite(...args),
  deleteFavorite: (...args: unknown[]) => deleteFavorite(...args),
  favoriteExists: (...args: unknown[]) => favoriteExists(...args),
  findSavedListingIds: (...args: unknown[]) => findSavedListingIds(...args),
  findFavoriteListingIdsPage: vi.fn(),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  listingExists: (...args: unknown[]) => listingExists(...args),
  adjustFavoriteCount: (...args: unknown[]) => adjustFavoriteCount(...args),
  findListingsByIds: vi.fn(),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  hydrateListings: vi.fn().mockResolvedValue([]),
}));

import { toggle, save, unsave, getFavoritedListingIds } from '../favorite.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const USER = 'user-1';
const LISTING_ID = '000000000000000000000001';

/** Every `adjustFavoriteCount` delta applied to `LISTING_ID`, in call order. */
function appliedDeltas(): unknown[] {
  return adjustFavoriteCount.mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  listingExists.mockResolvedValue(true);
  adjustFavoriteCount.mockResolvedValue(undefined);
});

describe('favorite.service.toggle', () => {
  it('creates the favorite and bumps favoriteCount +1 when absent', async () => {
    favoriteExists.mockResolvedValueOnce(false);
    insertFavorite.mockResolvedValueOnce(true);

    const result = await toggle(USER, LISTING_ID);

    expect(result).toEqual({ saved: true });
    expect(insertFavorite).toHaveBeenCalledWith(USER, LISTING_ID);
    // The old assertion read the Mongo update document (`{$inc:{favoriteCount:1}}`)
    // against a filter; there is no update document any more, so the SERVICE's
    // decision — which repository call, with which delta — is what is pinned.
    expect(adjustFavoriteCount).toHaveBeenCalledWith(LISTING_ID, 1);
  });

  it('deletes the favorite and decrements favoriteCount -1 when present', async () => {
    favoriteExists.mockResolvedValueOnce(true);
    deleteFavorite.mockResolvedValueOnce(true);

    const result = await toggle(USER, LISTING_ID);

    expect(result).toEqual({ saved: false });
    expect(deleteFavorite).toHaveBeenCalledWith(USER, LISTING_ID);
    // The clamp that used to ride along in the filter (`favoriteCount: {$gt: 0}`)
    // now lives in the SQL — see the module header.
    expect(adjustFavoriteCount).toHaveBeenCalledWith(LISTING_ID, -1);
  });

  it('toggle on then off is idempotent (net zero favoriteCount change)', async () => {
    // On.
    favoriteExists.mockResolvedValueOnce(false);
    insertFavorite.mockResolvedValueOnce(true);
    const on = await toggle(USER, LISTING_ID);

    // Off.
    favoriteExists.mockResolvedValueOnce(true);
    deleteFavorite.mockResolvedValueOnce(true);
    const off = await toggle(USER, LISTING_ID);

    expect(on).toEqual({ saved: true });
    expect(off).toEqual({ saved: false });
    expect(appliedDeltas()).toEqual([1, -1]);
  });

  it('rejects with NOT_FOUND when the listing does not exist', async () => {
    listingExists.mockResolvedValueOnce(false);

    await expect(toggle(USER, LISTING_ID)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
    expect(insertFavorite).not.toHaveBeenCalled();
    expect(adjustFavoriteCount).not.toHaveBeenCalled();
  });
});

describe('the count follows the ROW, not a prior read', () => {
  it('does NOT count a save the unique index absorbed', async () => {
    /**
     * The behaviour change the port made, and the drift it closes. Mongo read
     * first and then wrote, so two concurrent saves could both see "not saved",
     * both insert (the unique index absorbing the second) and both increment —
     * leaving a listing showing one more favorite than it has. `insertFavorite`
     * reports whether a row was really created, and `false` must move nothing.
     *
     * Reached through `save` rather than `toggle` on purpose: `toggle` only
     * inserts when `favoriteExists` said no, so the racing shape cannot be
     * expressed through it.
     */
    insertFavorite.mockResolvedValueOnce(false);

    const result = await save(USER, LISTING_ID);

    expect(result).toEqual({ saved: true });
    expect(adjustFavoriteCount).not.toHaveBeenCalled();
  });

  it('does NOT count an unsave that removed nothing', async () => {
    deleteFavorite.mockResolvedValueOnce(false);

    const result = await unsave(USER, LISTING_ID);

    // Idempotent: the buyer's state is "not saved" either way, but nothing was
    // taken out of the set, so nothing is taken off the count.
    expect(result).toEqual({ saved: false });
    expect(adjustFavoriteCount).not.toHaveBeenCalled();
  });

  it('counts a repeated save exactly once', async () => {
    insertFavorite.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await save(USER, LISTING_ID);
    await save(USER, LISTING_ID);

    expect(appliedDeltas()).toEqual([1]);
  });
});

describe('favorite.service.getFavoritedListingIds', () => {
  it('returns exactly the favorited subset of the queried ids', async () => {
    const A = '0000000000000000000000a1';
    const B = '0000000000000000000000b1';
    const C = '0000000000000000000000c1';
    // Only A and C are favorited.
    findSavedListingIds.mockResolvedValueOnce(new Set([A, C]));

    const set = await getFavoritedListingIds(USER, [A, B, C]);

    expect(findSavedListingIds).toHaveBeenCalledWith(USER, [A, B, C]);
    expect(set.has(A)).toBe(true);
    expect(set.has(B)).toBe(false);
    expect(set.has(C)).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns an empty set for an empty id list', async () => {
    /**
     * The old assertion here was `expect(favFind).not.toHaveBeenCalled()` — the
     * service used to decide not to query. It no longer builds a query at all:
     * the short-circuit moved INTO `findSavedListingIds`, which returns an empty
     * set before touching the database. So what survives at this level is the
     * delegation and the answer; the "no query" half belongs to the repository.
     */
    findSavedListingIds.mockResolvedValueOnce(new Set<string>());

    const set = await getFavoritedListingIds(USER, []);

    expect(set.size).toBe(0);
    expect(findSavedListingIds).toHaveBeenCalledWith(USER, []);
  });
});
