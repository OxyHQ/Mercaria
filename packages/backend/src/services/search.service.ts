/**
 * Listing search/browse service.
 *
 * Translates a `ListingQuery` into repository filters and runs it either:
 *  - OFFSET-paginated (`searchListingsOffset`) — backs default/`price_*` browse
 *    with `page`/`limit` + a total count, returning a `PaginatedResponse`; or
 *  - KEYSET-paginated (`searchListingsCursor`) — backs the infinite `newest`
 *    browse over `(published_at desc nulls last, id desc)`.
 *
 * Returns RAW listing rows; the controller hydrates them via
 * `catalog-hydration.service`.
 *
 * ## Two behaviour changes the port makes on purpose
 *
 * **Free text and a geo radius now COMBINE.** Mongo cannot run `$text` and
 * `$near` in one query, so this service used to pick geo and silently DROP the
 * search term: a buyer searching "bike" within 5 km got every listing within
 * 5 km, with nothing in the response to say the word had been ignored. A GIN
 * `tsvector` match and a GiST `ST_DWithin` are ordinary predicates in Postgres
 * and simply AND together.
 *
 * The other half of that change is that a `near` filter no longer imposes an
 * ORDER. Mongo's `$near` sorted by distance as a side effect of filtering, which
 * quietly overrode the caller's `sort`. It is a filter here and `sort` decides
 * the order, which is what the parameter always claimed to do.
 *
 * **Full-text matching uses `websearch_to_tsquery`.** It is the only built-in
 * parser that cannot raise on user input — a lone `"` or `|` is a syntax error
 * to `to_tsquery` — and it gives buyers the quoting and `-exclusion` a search box
 * implies. `plainto_tsquery` is equally safe but ANDs every word with no way to
 * phrase-match, which Mongo's `$text` did support.
 */

import { CONDITION_GROUPS } from '@mercaria/shared-types';
import type { ListingQuery } from '@mercaria/shared-types';
import {
  searchListingsKeyset,
  searchListingsPage,
  type ListingRecord,
  type ListingSearchFilters,
} from '../db/catalog/listingRepository.js';
import { decodeCursor, encodeCursor } from '../utils/pagination.js';

/** A page of raw listings produced by the cursor browse path. */
export interface CursorSearchResult {
  listings: ListingRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

/** A page of raw listings produced by the offset browse path. */
export interface OffsetSearchResult {
  listings: ListingRecord[];
  total: number;
}

/**
 * Map the public query contract onto the repository's filter shape.
 *
 * A field-by-field translation rather than passing `ListingQuery` straight
 * through: the query is a wire contract with pagination and sort mixed into it,
 * and the filter is what actually narrows rows. Keeping them distinct is what
 * stops a new query parameter from silently reaching the database.
 */
function toFilters(query: ListingQuery): ListingSearchFilters {
  const filters: ListingSearchFilters = {};

  if (query.ownerType) filters.ownerType = query.ownerType;
  if (query.storeId) filters.storeId = query.storeId;
  if (query.category) filters.categorySlug = query.category;
  /**
   * #90: the ONE place the v1 binary spelling is translated for reads.
   *
   * `condition=used` becomes every non-`new` GROUP, which is the honest reading
   * of what a v1 client is asking for — it has no way to name a segment, and it
   * meant "not factory-sealed". Mapping it to a single key instead would hide
   * refurbished and for-parts listings from every shipped mobile build.
   *
   * The mutual exclusion is enforced at the controller, so this only ever sees
   * one of the two.
   */
  if (query.condition) {
    filters.conditionGroups =
      query.condition === 'new'
        ? ['new']
        : CONDITION_GROUPS.filter((group) => group !== 'new');
  }
  if (query.conditionKeys && query.conditionKeys.length > 0) {
    filters.conditionKeys = query.conditionKeys;
  }
  if (query.conditionGroups && query.conditionGroups.length > 0) {
    filters.conditionGroups = query.conditionGroups;
  }
  if (query.vendor) filters.vendor = query.vendor;
  if (query.productType) filters.productType = query.productType;
  if (query.collectionId) filters.collectionId = query.collectionId;
  if (query.inStock) filters.inStock = true;
  if (typeof query.minPrice === 'number') filters.minPrice = query.minPrice;
  if (typeof query.maxPrice === 'number') filters.maxPrice = query.maxPrice;
  if (query.q && query.q.trim().length > 0) filters.text = query.q.trim();
  if (query.near) filters.near = query.near;

  return filters;
}

/**
 * Offset-paginated browse. Runs the filtered query with `limit`/`offset` and a
 * parallel count for the total.
 */
export async function searchListingsOffset(
  query: ListingQuery,
  page: number,
  limit: number,
): Promise<OffsetSearchResult> {
  const { rows, total } = await searchListingsPage(toFilters(query), query.sort, page, limit);
  return { listings: rows, total };
}

/**
 * Keyset-paginated browse for the infinite `newest` feed.
 *
 * An unreadable or OLD-FORMAT cursor is treated as no cursor — the reader
 * returns `null` for both — so a client holding a cursor minted before the
 * cutover gets the first page rather than an error. See `utils/pagination.ts`
 * for why the format carries a version at all.
 */
export async function searchListingsCursor(
  query: ListingQuery,
  limit: number,
): Promise<CursorSearchResult> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const { rows, hasMore } = await searchListingsKeyset(toFilters(query), cursor, limit);

  let nextCursor: string | undefined;
  if (hasMore && rows.length > 0) {
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor(last.publishedAt, last.id);
  }

  return { listings: rows, nextCursor, hasMore };
}
