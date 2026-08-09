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
import {
  CONDITION_GROUPS,
  ITEM_CONDITION_KEYS,
  LEGACY_BINARY_CONDITIONS,
} from '@mercaria/shared-types';
import type { ListingQuery, CursorPage, Listing } from '@mercaria/shared-types';
import {
  findListingById,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import { searchListingsOffset, searchListingsCursor } from '../services/search.service.js';
import { hydrateListings } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError, notFound, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { findCanonicalProductIdForListing } from '../db/reviews/reviewTargetResolver.js';
import { log } from '../lib/logger.js';
// Discovery analytics (#77). These are the ONLY two analytics modules a
// discovery surface may import — `analytics-ranking-isolation.test.ts` fails
// the build on any other, so a ranking function can never reach a rollup, an
// aggregate or a metric and "popularity we measured" cannot become an organic
// ranking input by accident.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import { instrumentSearch } from '../services/analytics/search-instrumentation.js';

/**
 * Listing statuses publicly viewable on the product-detail page. `draft` and
 * `archived` are owner/admin-only and 404 on the public read path.
 */
const PUBLICLY_VIEWABLE_STATUSES: readonly ListingRecord['status'][] = ['active', 'sold'];

/**
 * The shared tuples, narrowed to the NON-EMPTY tuple `z.enum` requires.
 *
 * `asEnumValues`'s reasoning at the HTTP boundary: the shared lists are typed
 * `readonly T[]`, and a cast would ASSERT non-emptiness where this checks it at
 * module load. Reading the same tuples the Postgres CHECKs are rendered from is
 * what stops a taxonomy key being storable and unqueryable.
 */
const LEGACY_BINARY_CONDITION_VALUES = zodEnumValues(LEGACY_BINARY_CONDITIONS);
const ITEM_CONDITION_KEY_VALUES = zodEnumValues(ITEM_CONDITION_KEYS);
const CONDITION_GROUP_VALUES = zodEnumValues(CONDITION_GROUPS);

function zodEnumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('A z.enum of no values rejects every request');
  }
  return [first, ...rest];
}

/**
 * A repeatable comma-separated query parameter, validated against a closed set.
 *
 * `?conditionGroups=used,refurbished` and `?conditionGroups=used&
 * conditionGroups=refurbished` both work, because express hands the second form
 * back as an array and clients disagree about which to send. An unrecognised
 * member is a 400 rather than a silent drop: silently ignoring it would answer
 * a filter the caller did not ask for with results they would read as filtered.
 */
function commaSeparated<T extends string>(values: readonly [T, ...T[]]) {
  const member = z.enum(values);
  return z
    .union([z.string(), z.array(z.string())])
    .transform((raw) => (Array.isArray(raw) ? raw : raw.split(',')))
    .pipe(z.array(member).min(1));
}

/** Coerce + validate the browse query string into a typed `ListingQuery`. */
const listingQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    // #90: the v1 binary spelling, still accepted. `conditionKeys` and
    // `conditionGroups` are the taxonomy filters; sending the v1 field beside
    // either is a 400 rather than a precedence rule nobody would remember.
    condition: z.enum(LEGACY_BINARY_CONDITION_VALUES).optional(),
    conditionKeys: commaSeparated(ITEM_CONDITION_KEY_VALUES).optional(),
    conditionGroups: commaSeparated(CONDITION_GROUP_VALUES).optional(),
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
  // #90: the two spellings can disagree (`condition=new` beside
  // `conditionGroups=used`), so there is deliberately no precedence rule
  // between them — the same decision the write path makes, for the same reason.
  if (parsed.condition && (parsed.conditionKeys || parsed.conditionGroups)) {
    throw validationError(
      'Send either `condition` (v1) or `conditionKeys`/`conditionGroups`, not both',
    );
  }
  if (parsed.condition) query.condition = parsed.condition;
  if (parsed.conditionKeys) query.conditionKeys = [...parsed.conditionKeys];
  if (parsed.conditionGroups) query.conditionGroups = [...parsed.conditionGroups];
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

/**
 * GET /listings — browse/search. Cursor for infinite `newest`, offset otherwise.
 *
 * Instrumented for #77. `instrumentSearch` runs AFTER the results are in hand
 * and returns a `queryEventId` echoed in the response, so the client can attach
 * its impressions and clicks to this exact search. Three properties of that
 * call are load-bearing:
 *
 *  - It cannot throw and cannot be awaited (`services/analytics/sink.ts`), so a
 *    Postgres problem in telemetry cannot fail or slow a browse — acceptance 7.
 *  - It returns `undefined` when collection is off, and the response field is
 *    then simply absent. No branch, no flag, no empty string.
 *  - The raw term reaches `redactSearchQuery` and nothing else. It is not
 *    logged here and not held anywhere after the call.
 */
export async function browseListings(req: Request, res: Response): Promise<void> {
  // The clock starts before the query, not before parsing: latency here is what
  // the API spent SEARCHING, which is the figure the metric names, and folding
  // in zod validation would make an invalid-request spike look like a slow index.
  const startedAt = Date.now();
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
      const queryEventId = instrumentSearch(req, {
        ...(query.q === undefined ? {} : { term: query.q }),
        resultCount: result.listings.length,
        latencyMs: Date.now() - startedAt,
        ...(query.category === undefined ? {} : { categoryId: query.category }),
      });
      const page: CursorPage<Listing> = { data, hasMore: result.hasMore };
      if (result.nextCursor) {
        page.nextCursor = result.nextCursor;
      }
      sendSuccess(res, { ...page, ...(queryEventId === undefined ? {} : { queryEventId }) });
      return;
    }

    // Offset path: default / price_* sort → PaginatedResponse.
    const { page, limit } = parsePagination(req.query);
    const result = await searchListingsOffset(query, page, limit);
    const data = await hydrateListings(result.listings, { viewerId: req.user?.id });
    instrumentSearch(req, {
      ...(query.q === undefined ? {} : { term: query.q }),
      // The rows on THIS page, not `result.total`: an impression is something
      // that was served, and a page-3 request with 4,000 matches served twenty.
      resultCount: result.listings.length,
      latencyMs: Date.now() - startedAt,
      ...(query.category === undefined ? {} : { categoryId: query.category }),
    });
    sendPaginated(res, data, buildPagination(page, limit, result.total));
  } catch (err) {
    log.general.error({ err }, 'Failed to browse listings');
    respondWithError(res, err, 'Failed to load listings');
  }
}

/** GET /listings/:id — the product detail page (full hydrated listing). */
export async function getListingById(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const row = await findListingById(id);
    if (!row || !PUBLICLY_VIEWABLE_STATUSES.includes(row.status)) {
      throw notFound('Listing not found');
    }
    const [dto] = await hydrateListings([row], { viewerId: req.user?.id });
    /**
     * The canonical product link, resolved HERE and only here (#76).
     *
     * Not in `hydrateListings`, which also serves the feed, search and every
     * store grid: the resolution walks each variant through the identifier
     * collision gate, and paying that per card on a forty-item page to render
     * something no card shows would be a real cost for nothing. The detail page
     * is the one surface that needs it, so the detail handler is where it is
     * paid.
     *
     * A `null` is left ABSENT rather than serialized: "Mercaria does not know
     * which product this is" is what an omitted field means, and it is the
     * honest answer for a listing with no barcode, an unclaimed one, or variants
     * that disagree.
     */
    const canonicalProductId = await findCanonicalProductIdForListing(row.id);
    // Emitted AFTER the 404 guard, so a view of something that does not exist
    // is not counted as a product view — `product_page_view` is the denominator
    // of two metrics, and inflating it with misses would deflate both. It
    // carries the canonical product id resolved just above, which is what makes
    // `duplicate_product_rate` and the coverage metrics answerable at all.
    emitAnalyticsEvent(req, {
      eventType: 'product_page_view',
      entities: {
        listingId: row.id,
        ...(row.storeId === null ? {} : { storeId: row.storeId }),
        ...(canonicalProductId === null ? {} : { canonicalProductId }),
      },
    });
    sendSuccess(res, canonicalProductId ? { ...dto, canonicalProductId } : dto);
  } catch (err) {
    log.general.error({ err, listingId: id }, 'Failed to load listing');
    respondWithError(res, err, 'Failed to load listing');
  }
}
