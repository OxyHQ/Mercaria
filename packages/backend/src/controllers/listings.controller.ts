/**
 * Listings controller (THIN).
 *
 * Parses + validates the browse query, delegates the actual querying to
 * `search.service` and hydration to `catalog-hydration.service`, then emits the
 * canonical envelope:
 *  - default / `price_*` sort → OFFSET `PaginatedResponse<Listing>`
 *  - `newest` sort with a cursor → `CursorPage<Listing>`
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ListingQuery, CursorPage, Listing } from '@mercaria/shared-types';
import { Listing as ListingModel, type IListing } from '../models/listing.js';
import { searchListingsOffset, searchListingsCursor } from '../services/search.service.js';
import { hydrateListings } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * Listing statuses publicly viewable on the product-detail page. `draft` and
 * `archived` are owner/admin-only and 404 on the public read path.
 */
const PUBLICLY_VIEWABLE_STATUSES: readonly IListing['status'][] = ['active', 'sold'];

/** Coerce + validate the browse query string into a typed `ListingQuery`. */
const listingQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    condition: z.enum(['new', 'used']).optional(),
    minPrice: z.coerce.number().int().nonnegative().optional(),
    maxPrice: z.coerce.number().int().nonnegative().optional(),
    storeId: z.string().trim().min(1).optional(),
    ownerType: z.enum(['user', 'store']).optional(),
    vendor: z.string().trim().min(1).optional(),
    productType: z.string().trim().min(1).optional(),
    collectionId: z.string().trim().min(1).optional(),
    inStock: z.coerce.boolean().optional(),
    cursor: z.string().trim().min(1).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc']).optional(),
    lng: z.coerce.number().optional(),
    lat: z.coerce.number().optional(),
    radiusM: z.coerce.number().positive().optional(),
  })
  .passthrough();

/** Assemble a `ListingQuery` from the parsed query object. */
function toListingQuery(parsed: z.infer<typeof listingQuerySchema>): ListingQuery {
  const query: ListingQuery = {};
  if (parsed.q) query.q = parsed.q;
  if (parsed.category) query.category = parsed.category;
  if (parsed.condition) query.condition = parsed.condition;
  if (typeof parsed.minPrice === 'number') query.minPrice = parsed.minPrice;
  if (typeof parsed.maxPrice === 'number') query.maxPrice = parsed.maxPrice;
  if (parsed.storeId) query.storeId = parsed.storeId;
  if (parsed.ownerType) query.ownerType = parsed.ownerType;
  if (parsed.vendor) query.vendor = parsed.vendor;
  if (parsed.productType) query.productType = parsed.productType;
  if (parsed.collectionId) query.collectionId = parsed.collectionId;
  if (parsed.inStock) query.inStock = parsed.inStock;
  if (parsed.cursor) query.cursor = parsed.cursor;
  if (parsed.sort) query.sort = parsed.sort;
  if (
    typeof parsed.lng === 'number' &&
    typeof parsed.lat === 'number' &&
    typeof parsed.radiusM === 'number'
  ) {
    query.near = { lng: parsed.lng, lat: parsed.lat, radiusM: parsed.radiusM };
  }
  return query;
}

/** GET /listings — browse/search. Cursor for infinite `newest`, offset otherwise. */
export async function browseListings(req: Request, res: Response): Promise<void> {
  try {
    const parsed = listingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const query = toListingQuery(parsed.data);

    // Infinite path: newest sort with a cursor present → CursorPage.
    if (query.sort === 'newest' && query.cursor) {
      const { limit } = parsePagination(req.query);
      const result = await searchListingsCursor(query, limit);
      const data = await hydrateListings(result.listings, { viewerId: req.user?.id });
      const page: CursorPage<Listing> = { data, hasMore: result.hasMore };
      if (result.nextCursor) {
        page.nextCursor = result.nextCursor;
      }
      sendSuccess(res, page);
      return;
    }

    // Offset path: default / price_* sort → PaginatedResponse.
    const { page, limit } = parsePagination(req.query);
    const result = await searchListingsOffset(query, page, limit);
    const data = await hydrateListings(result.listings, { viewerId: req.user?.id });
    sendPaginated(res, data, buildPagination(page, limit, result.total));
  } catch (err) {
    log.general.error({ err }, 'Failed to browse listings');
    respondWithError(res, err, 'Failed to load listings');
  }
}

/** GET /listings/:id — the product detail page (full hydrated listing). */
export async function getListingById(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  try {
    const doc = await ListingModel.findById(id).lean<IListing | null>();
    if (!doc || !PUBLICLY_VIEWABLE_STATUSES.includes(doc.status)) {
      throw notFound('Listing not found');
    }
    const [dto] = await hydrateListings([doc], { viewerId: req.user?.id });
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, listingId: id }, 'Failed to load listing');
    respondWithError(res, err, 'Failed to load listing');
  }
}
