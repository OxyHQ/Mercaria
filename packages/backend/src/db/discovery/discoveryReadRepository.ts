/**
 * `discovery_signals`, `listings` and `discounts` — the READ side of the
 * discovery feed. One query per {@link DiscoverySignal}, each ordered by the
 * ONE column its shelf is named after (`schema/discovery.ts`'s "only counts,
 * no score" rule) — plus `findStoresWithLiveDiscounts` for the deals scope's
 * store-offer cards.
 *
 * Split from `discoverySignalRepository.ts` (the WRITE side) because they
 * share no statement and sit on different paths: that one runs on a timer and
 * rewrites whole scopes, this one runs on every request and reads one indexed
 * slice.
 *
 * `top-rated`, `new` and `on-sale` — `DISCOVERY_SIGNALS_FROM_LISTINGS` — read
 * `listings` directly and page the FULL result set. `best-selling` and
 * `most-viewed` — `DISCOVERY_SIGNALS_FROM_COUNTS` — join `discovery_signals`,
 * so a page never reaches past what the sweep counted
 * (`config.discovery.topNPerCategory`): an empty scope in that table is an
 * empty shelf, never every listing in the category via a bad join.
 */

import { and, desc, eq, getTableColumns, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { DISCOVERY_WINDOWS, type DiscoverySignal } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { findOnSaleListings, type ListingRecord } from '../catalog/listingRepository.js';
import { type DiscountRow } from '../merchandising/discountRepository.js';
import { getDb } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { discoverySignals } from '../schema/discovery.js';
import { discounts } from '../schema/merchandising.js';

/** The one counting window this repository reads. See `DISCOVERY_WINDOWS`. */
const WINDOW = DISCOVERY_WINDOWS[0];

export interface FindListingsBySignalInput {
  signal: DiscoverySignal;
  categoryIds: string[];
  limit: number;
  offset: number;
}

/** One page of listings for `top-rated`, `new`, `on-sale`, `best-selling` or `most-viewed`. */
export async function findListingsBySignal(
  input: FindListingsBySignalInput,
): Promise<ListingRecord[]> {
  switch (input.signal) {
    case 'top-rated':
      return findTopRatedListings(input);
    case 'new':
      return findNewestListings(input);
    case 'on-sale':
      // A store-wide shelf with no category scope or paging depth of its
      // own — this signal delegates whole to the existing query rather than
      // reimplementing it.
      return findOnSaleListings(input.limit);
    case 'best-selling':
      return findBestSellingListings(input);
    case 'most-viewed':
      return findMostViewedListings(input);
  }
}

/** `top-rated` — ordered by `listings.rating`, floored at `topRatedMinReviews`. */
async function findTopRatedListings(input: FindListingsBySignalInput): Promise<ListingRecord[]> {
  if (input.categoryIds.length === 0) return [];
  return getDb()
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.status, 'active'),
        inArray(listings.categoryId, input.categoryIds),
        gte(listings.reviewCount, config.discovery.topRatedMinReviews),
      ),
    )
    .orderBy(desc(listings.rating), desc(listings.id))
    .limit(input.limit)
    .offset(input.offset);
}

/** `new` — ordered by `listings.published_at`, the FIRST activation, never row creation. */
async function findNewestListings(input: FindListingsBySignalInput): Promise<ListingRecord[]> {
  if (input.categoryIds.length === 0) return [];
  return getDb()
    .select()
    .from(listings)
    .where(and(eq(listings.status, 'active'), inArray(listings.categoryId, input.categoryIds)))
    .orderBy(desc(listings.publishedAt), desc(listings.id))
    .limit(input.limit)
    .offset(input.offset);
}

/** `best-selling` — `discovery_signals` joined to `listings`, ordered by `units_sold`. */
async function findBestSellingListings(
  input: FindListingsBySignalInput,
): Promise<ListingRecord[]> {
  if (input.categoryIds.length === 0) return [];
  return getDb()
    .select(getTableColumns(listings))
    .from(discoverySignals)
    .innerJoin(listings, eq(discoverySignals.subjectId, listings.id))
    .where(
      and(
        eq(discoverySignals.subjectType, 'listing'),
        inArray(discoverySignals.categoryId, input.categoryIds),
        eq(discoverySignals.window, WINDOW),
      ),
    )
    .orderBy(desc(discoverySignals.unitsSold), desc(discoverySignals.id))
    .limit(input.limit)
    .offset(input.offset);
}

/** `most-viewed` — `discovery_signals` joined to `listings`, ordered by `view_count`. */
async function findMostViewedListings(
  input: FindListingsBySignalInput,
): Promise<ListingRecord[]> {
  if (input.categoryIds.length === 0) return [];
  return getDb()
    .select(getTableColumns(listings))
    .from(discoverySignals)
    .innerJoin(listings, eq(discoverySignals.subjectId, listings.id))
    .where(
      and(
        eq(discoverySignals.subjectType, 'listing'),
        inArray(discoverySignals.categoryId, input.categoryIds),
        eq(discoverySignals.window, WINDOW),
      ),
    )
    .orderBy(desc(discoverySignals.viewCount), desc(discoverySignals.id))
    .limit(input.limit)
    .offset(input.offset);
}

/** Store ids ranked by `discovery_signals.units_sold` — the merchant shelf. */
export async function findStoresBySignal(input: {
  categoryId: string;
  limit: number;
}): Promise<string[]> {
  const rows = await getDb()
    .select({ subjectId: discoverySignals.subjectId })
    .from(discoverySignals)
    .where(
      and(
        eq(discoverySignals.subjectType, 'store'),
        eq(discoverySignals.categoryId, input.categoryId),
        eq(discoverySignals.window, WINDOW),
      ),
    )
    .orderBy(desc(discoverySignals.unitsSold), desc(discoverySignals.id))
    .limit(input.limit);
  return rows.map((row) => row.subjectId);
}

/**
 * Stores with a LIVE `automatic` discount — the deals scope's store-offer
 * cards. `method: 'code'` is never projected: a shelf advertising a saving
 * the shopper cannot get without a code they do not have is a false price.
 *
 * Filters exactly the three things `discounts_store_id_method_window_idx` was
 * built for: the method, the active flag, and the scheduled window
 * (`starts_at <= now <= coalesce(ends_at, 'infinity')`, read here as
 * `starts_at <= now` and `ends_at is null or ends_at >= now`).
 */
export async function findStoresWithLiveDiscounts(
  limit: number,
): Promise<{ storeId: string; discount: DiscountRow }[]> {
  const now = new Date();
  const rows = await getDb()
    .select()
    .from(discounts)
    .where(
      and(
        eq(discounts.method, 'automatic'),
        eq(discounts.isActive, true),
        lte(discounts.startsAt, now),
        or(isNull(discounts.endsAt), gte(discounts.endsAt, now)),
      ),
    )
    .orderBy(desc(discounts.startsAt), desc(discounts.id))
    .limit(limit);
  return rows.map((discount) => ({ storeId: discount.storeId, discount }));
}
