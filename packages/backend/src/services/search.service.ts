/**
 * Listing search/browse service.
 *
 * Translates a `ListingQuery` into a Mongo filter + sort, and runs it either:
 *  - OFFSET-paginated (`searchListingsOffset`) — backs default/`price_*` browse
 *    with `page`/`limit` + a total count, returning a `PaginatedResponse`; or
 *  - CURSOR-paginated (`searchListingsCursor`) — backs the infinite `newest`
 *    browse over the `{ status, publishedAt: -1, _id: -1 }` index.
 *
 * Returns RAW `IListing` docs; the controller hydrates them via
 * `catalog-hydration.service`.
 */

import mongoose, { type SortOrder } from 'mongoose';
import type { ListingQuery } from '@mercaria/shared-types';
import { Listing, type IListing } from '../models/listing.js';
import { decodeCursor, encodeCursor } from '../utils/pagination.js';

/** A Mongo filter document (Mongoose 9 dropped the `FilterQuery` export). */
type ListingFilter = Record<string, unknown>;

/** A page of raw listings produced by the cursor browse path. */
export interface CursorSearchResult {
  listings: IListing[];
  nextCursor?: string;
  hasMore: boolean;
}

/** A page of raw listings produced by the offset browse path. */
export interface OffsetSearchResult {
  listings: IListing[];
  total: number;
}

/**
 * Build the base Mongo filter shared by both pagination paths (everything except
 * the cursor boundary, which only the cursor path adds).
 *
 * NOTE: `$geoNear`/`$near` cannot be combined with `$text` in one query. When a
 * geo `near` filter is present we choose geo and ignore the free-text `q`.
 */
function buildFilter(query: ListingQuery): ListingFilter {
  const filter: ListingFilter = { status: 'active' };

  if (query.ownerType) {
    filter.ownerType = query.ownerType;
  }
  if (query.storeId) {
    filter.storeId = query.storeId;
  }
  if (query.category) {
    filter.categorySlugs = query.category;
  }
  if (query.condition) {
    filter.condition = query.condition;
  }
  if (query.inStock) {
    filter.hasInventory = true;
  }

  const priceFilter: Record<string, number> = {};
  if (typeof query.minPrice === 'number') {
    priceFilter.$gte = query.minPrice;
  }
  if (typeof query.maxPrice === 'number') {
    priceFilter.$lte = query.maxPrice;
  }
  if (Object.keys(priceFilter).length > 0) {
    filter['priceRange.min.amount'] = priceFilter;
  }

  if (query.near) {
    // Geo wins over text: $near is incompatible with $text in a single query.
    filter.location = {
      $near: {
        $geometry: { type: 'Point', coordinates: [query.near.lng, query.near.lat] },
        $maxDistance: query.near.radiusM,
      },
    };
  } else if (query.q && query.q.trim().length > 0) {
    filter.$text = { $search: query.q.trim() };
  }

  return filter;
}

/** Build the Mongo sort for a non-cursor query from the `sort` param. */
function buildSort(query: ListingQuery): Record<string, SortOrder> {
  switch (query.sort) {
    case 'price_asc':
      return { 'priceRange.min.amount': 1, _id: -1 };
    case 'price_desc':
      return { 'priceRange.min.amount': -1, _id: -1 };
    case 'newest':
    default:
      return { publishedAt: -1, _id: -1 };
  }
}

/**
 * Offset-paginated browse. Runs the filtered query with `skip`/`limit` and a
 * parallel `countDocuments` for the total. A geo `near` query disallows `skip`
 * with `$near` only on legacy operators; the modern `$near` GeoJSON form used
 * here supports skip/limit.
 */
export async function searchListingsOffset(
  query: ListingQuery,
  page: number,
  limit: number,
): Promise<OffsetSearchResult> {
  const filter = buildFilter(query);
  const sort = buildSort(query);
  const skip = (page - 1) * limit;

  const [listings, total] = await Promise.all([
    Listing.find(filter).sort(sort).skip(skip).limit(limit).lean<IListing[]>(),
    Listing.countDocuments(filter),
  ]);

  return { listings, total };
}

/**
 * Cursor-paginated browse for the infinite `newest` feed. Adds a
 * `(publishedAt, _id)` boundary derived from the opaque cursor and reads
 * `limit + 1` to detect whether another page exists.
 */
export async function searchListingsCursor(
  query: ListingQuery,
  limit: number,
): Promise<CursorSearchResult> {
  const filter = buildFilter(query);

  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  if (decoded) {
    filter.$or = [
      { publishedAt: { $lt: decoded.publishedAt } },
      { publishedAt: decoded.publishedAt, _id: { $lt: new mongoose.Types.ObjectId(decoded.id) } },
    ];
  }

  const docs = await Listing.find(filter)
    .sort({ publishedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean<IListing[]>();

  const hasMore = docs.length > limit;
  const listings = hasMore ? docs.slice(0, limit) : docs;

  let nextCursor: string | undefined;
  if (hasMore && listings.length > 0) {
    const last = listings[listings.length - 1];
    const publishedAt = last.publishedAt ?? last.createdAt;
    nextCursor = encodeCursor(publishedAt, String((last as { _id: mongoose.Types.ObjectId })._id));
  }

  return { listings, nextCursor, hasMore };
}
