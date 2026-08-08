/**
 * Favorite service — the buyer's wishlist.
 *
 * `toggle` is idempotent and keeps `listings.favorite_count` in sync.
 * `listFavorites` returns the fully-hydrated `Listing` DTOs via the catalogue
 * hydration path, and `getFavoritedListingIds` is the batched lookup hydration
 * uses to set `saved`.
 *
 * ## Ported to Postgres — the counter stopped being able to drift
 *
 * Two changes, and both close a real hole rather than reshaping a query:
 *
 *  - **The count moves only when the SET really changed.** The repository's
 *    insert and delete report whether a row was written, so a repeated save
 *    increments nothing. The Mongo path read first and then wrote, which two
 *    concurrent saves could both pass — inserting once (the unique index absorbs
 *    the second) and counting twice.
 *  - **The decrement is `greatest(0, count - 1)` rather than a
 *    `where favoriteCount > 0` guard.** That guard made the whole update a
 *    no-op at zero, so a legitimate increment arriving in the same moment was
 *    lost outright; clamping applies every delta and refuses only to go negative.
 */

import type { Listing as ListingDTO, Pagination } from '@mercaria/shared-types';
import {
  deleteFavorite,
  favoriteExists,
  findFavoriteListingIdsPage,
  findSavedListingIds,
  insertFavorite,
} from '../db/buyers/favoriteRepository.js';
import {
  adjustFavoriteCount,
  findListingsByIds,
  listingExists,
} from '../db/catalog/listingRepository.js';
import { hydrateListings } from './catalog-hydration.service.js';
import { buildPagination } from '../utils/pagination.js';
import { notFound } from '../lib/errors/error-codes.js';

/** Result of a favorite toggle: the resulting saved-state for the listing. */
export interface ToggleResult {
  /** `true` if the listing is now favorited, `false` if it was un-favorited. */
  saved: boolean;
}

/**
 * Toggle a listing in the buyer's wishlist (idempotent).
 *
 * If absent it is created (and the count bumped `+1`) → `{saved: true}`; if
 * present it is removed (and the count decremented, clamped ≥0) →
 * `{saved: false}`. The listing must exist (NOT_FOUND otherwise).
 */
export async function toggle(oxyUserId: string, listingId: string): Promise<ToggleResult> {
  if (!(await listingExists(listingId))) {
    throw notFound('Listing not found');
  }

  if (await favoriteExists(oxyUserId, listingId)) {
    return unsave(oxyUserId, listingId);
  }
  return save(oxyUserId, listingId);
}

/** Explicitly save (favorite) a listing — idempotent (no-op if already saved). */
export async function save(oxyUserId: string, listingId: string): Promise<ToggleResult> {
  if (!(await listingExists(listingId))) {
    throw notFound('Listing not found');
  }

  // The count follows the ROW, not a prior read: `false` means the unique index
  // absorbed a duplicate and there is nothing new to count.
  if (await insertFavorite(oxyUserId, listingId)) {
    await adjustFavoriteCount(listingId, 1);
  }
  return { saved: true };
}

/** Explicitly unsave (un-favorite) a listing — idempotent (no-op if absent). */
export async function unsave(oxyUserId: string, listingId: string): Promise<ToggleResult> {
  if (await deleteFavorite(oxyUserId, listingId)) {
    await adjustFavoriteCount(listingId, -1);
  }
  return { saved: false };
}

/**
 * List the buyer's favorited listings (most-recently saved first), hydrated into
 * `Listing` DTOs. Listings the favorite points at that no longer exist are
 * skipped — though the `ON DELETE CASCADE` on `favorites.listing_id` means a
 * deleted listing now takes its favorites with it, so the case has become
 * unreachable rather than merely handled.
 */
export async function listFavorites(
  oxyUserId: string,
  page: number,
  limit: number,
): Promise<{ data: ListingDTO[]; pagination: Pagination }> {
  const { listingIds, total } = await findFavoriteListingIdsPage(oxyUserId, page, limit);

  if (listingIds.length === 0) {
    return { data: [], pagination: buildPagination(page, limit, total) };
  }

  // `findListingsByIds` restores the caller's order, which here is recency of
  // SAVING — not a property of the listings themselves, so SQL cannot supply it.
  const rows = await findListingsByIds(listingIds);
  const data = await hydrateListings(rows, { viewerId: oxyUserId });
  return { data, pagination: buildPagination(page, limit, total) };
}

/**
 * Batched lookup: of `listingIds`, which has the viewer favorited? Returns a set
 * of favorited listing-id strings. Used by catalog-hydration to set `saved`.
 */
export async function getFavoritedListingIds(
  oxyUserId: string,
  listingIds: string[],
): Promise<Set<string>> {
  return findSavedListingIds(oxyUserId, listingIds);
}
