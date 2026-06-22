/**
 * Favorite service — the buyer's wishlist.
 *
 * `toggle` is idempotent and keeps `Listing.favoriteCount` in sync: creating a
 * favorite (the unique `{oxyUserId, listingId}` index makes a duplicate save a
 * no-op) bumps the count `+1`; deleting one decrements it (clamped at 0 so a
 * double-unsave never drives the count negative). `listFavorites` returns the
 * fully-hydrated `Listing` DTOs via the F1 catalog-hydration path, and
 * `getFavoritedListingIds` is the batched lookup hydration uses to set `saved`.
 */

import mongoose from 'mongoose';
import type { Listing as ListingDTO } from '@mercaria/shared-types';
import { Favorite } from '../models/favorite.js';
import { Listing, type IListing } from '../models/listing.js';
import { hydrateListings } from './catalog-hydration.service.js';
import { buildPagination } from '../utils/pagination.js';
import type { Pagination } from '@mercaria/shared-types';
import { notFound } from '../lib/errors/error-codes.js';

/** Result of a favorite toggle: the resulting saved-state for the listing. */
export interface ToggleResult {
  /** `true` if the listing is now favorited, `false` if it was un-favorited. */
  saved: boolean;
}

/**
 * Toggle a listing in the buyer's wishlist (idempotent).
 *
 * If absent it is created (and `Listing.favoriteCount` bumped `+1`) → `{saved: true}`;
 * if present it is removed (and the count decremented, clamped ≥0) → `{saved: false}`.
 * The listing must exist (NOT_FOUND otherwise).
 */
export async function toggle(oxyUserId: string, listingId: string): Promise<ToggleResult> {
  const listingExists = await Listing.exists({ _id: listingId });
  if (!listingExists) {
    throw notFound('Listing not found');
  }

  const existing = await Favorite.findOne({ oxyUserId, listingId }).select('_id').lean();

  if (existing) {
    await Favorite.deleteOne({ _id: existing._id });
    await Listing.updateOne(
      { _id: listingId, favoriteCount: { $gt: 0 } },
      { $inc: { favoriteCount: -1 } },
    );
    return { saved: false };
  }

  await Favorite.create({ oxyUserId, listingId: new mongoose.Types.ObjectId(listingId) });
  await Listing.updateOne({ _id: listingId }, { $inc: { favoriteCount: 1 } });
  return { saved: true };
}

/** Explicitly save (favorite) a listing — idempotent (no-op if already saved). */
export async function save(oxyUserId: string, listingId: string): Promise<ToggleResult> {
  const listingExists = await Listing.exists({ _id: listingId });
  if (!listingExists) {
    throw notFound('Listing not found');
  }

  const existing = await Favorite.findOne({ oxyUserId, listingId }).select('_id').lean();
  if (existing) {
    return { saved: true };
  }

  await Favorite.create({ oxyUserId, listingId: new mongoose.Types.ObjectId(listingId) });
  await Listing.updateOne({ _id: listingId }, { $inc: { favoriteCount: 1 } });
  return { saved: true };
}

/** Explicitly unsave (un-favorite) a listing — idempotent (no-op if absent). */
export async function unsave(oxyUserId: string, listingId: string): Promise<ToggleResult> {
  const existing = await Favorite.findOne({ oxyUserId, listingId }).select('_id').lean();
  if (!existing) {
    return { saved: false };
  }

  await Favorite.deleteOne({ _id: existing._id });
  await Listing.updateOne(
    { _id: listingId, favoriteCount: { $gt: 0 } },
    { $inc: { favoriteCount: -1 } },
  );
  return { saved: false };
}

/**
 * List the buyer's favorited listings (most-recently saved first), hydrated into
 * `Listing` DTOs via the F1 catalog-hydration path. Listings the favorite points
 * at that no longer exist are skipped.
 */
export async function listFavorites(
  oxyUserId: string,
  page: number,
  limit: number,
): Promise<{ data: ListingDTO[]; pagination: Pagination }> {
  const filter = { oxyUserId };

  const [favorites, total] = await Promise.all([
    Favorite.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('listingId')
      .lean(),
    Favorite.countDocuments(filter),
  ]);

  const listingIds = favorites.map((f) => String(f.listingId));
  if (listingIds.length === 0) {
    return { data: [], pagination: buildPagination(page, limit, total) };
  }

  const docs = await Listing.find({ _id: { $in: listingIds } }).lean<IListing[]>();

  // Preserve favorite (recency) order; drop any listing that has been deleted.
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const ordered = listingIds
    .map((id) => byId.get(id))
    .filter((d): d is IListing => d !== undefined);

  const data = await hydrateListings(ordered, { viewerId: oxyUserId });
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
  if (listingIds.length === 0) {
    return new Set();
  }
  const docs = await Favorite.find({ oxyUserId, listingId: { $in: listingIds } })
    .select('listingId')
    .lean();
  return new Set(docs.map((d) => String(d.listingId)));
}
