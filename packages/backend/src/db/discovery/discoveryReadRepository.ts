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
 *
 * `best-selling`, `most-viewed` and `findStoresBySignal` all additionally
 * require their own ranking column to be greater than zero: every counted
 * subject earns an unconditional row in the root scope regardless of whether
 * it ever sold or was viewed — and a store can be seated in a scope through
 * the VIEW-COUNT arm of the sweep's union with `unitsSold: 0` — so an
 * ORDER BY with no floor presents an arbitrary ordering of zero-count rows
 * under a heading that claims they are the best or the most.
 */

import { and, desc, eq, getTableColumns, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  DISCOVERY_WINDOWS,
  type DiscoverySignal,
  type DiscountValueType,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { findOnSaleListings, type ListingRecord } from '../catalog/listingRepository.js';
import { type DiscountRow } from '../merchandising/discountRepository.js';
import { getDb } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { discoverySignals } from '../schema/discovery.js';
import { DISCOUNT_VALUE_TYPES, discounts } from '../schema/merchandising.js';
import { stores } from '../schema/stores.js';

/** The one counting window this repository reads. See `DISCOVERY_WINDOWS`. */
const WINDOW = DISCOVERY_WINDOWS[0];

/**
 * Whether a discount's value type can STATE its saving on a deals card.
 *
 * `DiscountSummary` (`@mercaria/shared-types`) carries `percentOff` and
 * `amountOff` and nothing else that could express a saving, so a `bogo` or a
 * `free_item` projects to a summary with neither — a card headed by a store
 * and a discount that promises no number at all. Both fields being optional on
 * the DTO is exactly why the compiler could not see it.
 *
 * Excluded rather than projected, on the same grounds `method = 'code'` is:
 * advertising a saving the shopper cannot read off the card is a false price,
 * and there is no honest way to spell "buy one, get one" in a field that holds
 * a percentage. Adding one is a shared-types change, and then this map's `false`
 * becomes the thing to revisit.
 *
 * A `Record` over the whole union rather than a hand-written tuple: a FIFTH
 * value type is then a compile error here (the object literal stops satisfying
 * `Record<DiscountValueType, boolean>`) rather than a new member silently
 * inheriting "statable" — measured by deleting a key, which fails `tsc`.
 */
const STATES_ITS_OWN_SAVING: Record<DiscountValueType, boolean> = {
  percentage: true,
  fixed_amount: true,
  bogo: false,
  free_item: false,
};

/** The value types a `store-offer` card can carry, derived from the map above. */
const STATABLE_VALUE_TYPES = DISCOUNT_VALUE_TYPES.filter((type) => STATES_ITS_OWN_SAVING[type]);

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
      // Delegates to the existing query rather than reimplementing it, but
      // scoped and paged exactly like the other four signals — an unscoped
      // on-sale shelf inside a category page would leak every discounted
      // listing in the marketplace, not just this category's.
      return findOnSaleListings({
        limit: input.limit,
        categoryIds: input.categoryIds,
        offset: input.offset,
      });
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

/**
 * `best-selling` — `discovery_signals` grouped by subject, joined to `listings`,
 * ordered by `units_sold`.
 *
 * GROUPED, not a plain join: `discovery_signals` carries one row per subject
 * PER ANCESTOR SCOPE (`sweep.ts`'s own docblock, "one row per ancestor"), and
 * every one of a listing's ancestor rows carries the SAME `units_sold` — the
 * listing's own total, duplicated so a query at any single depth finds it
 * with one indexed read. A `categoryIds` naming more than one level of the
 * SAME subtree (`activeSubtreeIds`, or `root`'s whole taxonomy) therefore
 * matches that listing's row MORE THAN ONCE — a listing two levels below the
 * queried scope matched three times (its own category, the mid-level
 * ancestor, and the scope itself), not two, before this fix. `MAX`, not
 * `SUM`: the duplicate rows carry the IDENTICAL value by construction (see
 * `sweep.ts`'s per-listing candidate, computed once before the per-scope
 * loop), so summing them would multiply one true count by however many
 * ancestor levels matched rather than reporting it once. `SUM` is the right
 * verb for a STORE subject's row (`sweep.ts`'s `storeAggregates`, which really
 * does add several LISTINGS' counts together within one scope) — it is the
 * wrong one here, where every matched row is the same fact repeated, and
 * `findStoresBySignal` below is untouched because it is never called with
 * more than one `categoryId`, so it never had this fanout to begin with.
 *
 * The tiebreak moves to `listings.id`: grouping collapses the several
 * `discovery_signals.id`s a listing could have contributed into no single
 * row to break a tie on.
 */
async function findBestSellingListings(
  input: FindListingsBySignalInput,
): Promise<ListingRecord[]> {
  if (input.categoryIds.length === 0) return [];
  const ranked = getDb()
    .select({
      subjectId: discoverySignals.subjectId,
      unitsSold: sql<number>`max(${discoverySignals.unitsSold})`.as('units_sold'),
    })
    .from(discoverySignals)
    .where(
      and(
        eq(discoverySignals.subjectType, 'listing'),
        inArray(discoverySignals.categoryId, input.categoryIds),
        eq(discoverySignals.window, WINDOW),
      ),
    )
    .groupBy(discoverySignals.subjectId)
    .as('ranked_best_selling');

  return getDb()
    .select(getTableColumns(listings))
    .from(ranked)
    .innerJoin(listings, eq(ranked.subjectId, listings.id))
    .where(
      and(
        // A listing counted while it sold can be archived, sold out or put
        // under a moderation hold afterward — `discovery_signals` carries no
        // status check of its own (Task 4's sweep counts from order/view
        // history, not from the listing's current state), so this join is
        // the one place that can still keep it off a public shelf.
        eq(listings.status, 'active'),
        // A zero count is an absent fact, not a ranking. The seed emits a
        // root-scope row for every counted subject regardless of whether it
        // ever sold anything, so an unguarded ORDER BY presents listings
        // nobody bought under a heading that says they are the best-selling.
        gt(ranked.unitsSold, 0),
      ),
    )
    .orderBy(desc(ranked.unitsSold), desc(listings.id))
    .limit(input.limit)
    .offset(input.offset);
}

/**
 * `most-viewed` — `discovery_signals` grouped by subject, joined to
 * `listings`, ordered by `view_count`. Same subtree-fanout fix as
 * `findBestSellingListings` above, for the same reason: a listing's
 * `view_count` is duplicated identically across its ancestor-scope rows, so a
 * multi-category `categoryIds` needs `MAX` grouped by subject, not a plain
 * join.
 */
async function findMostViewedListings(
  input: FindListingsBySignalInput,
): Promise<ListingRecord[]> {
  if (input.categoryIds.length === 0) return [];
  const ranked = getDb()
    .select({
      subjectId: discoverySignals.subjectId,
      viewCount: sql<number>`max(${discoverySignals.viewCount})`.as('view_count'),
    })
    .from(discoverySignals)
    .where(
      and(
        eq(discoverySignals.subjectType, 'listing'),
        inArray(discoverySignals.categoryId, input.categoryIds),
        eq(discoverySignals.window, WINDOW),
      ),
    )
    .groupBy(discoverySignals.subjectId)
    .as('ranked_most_viewed');

  return getDb()
    .select(getTableColumns(listings))
    .from(ranked)
    .innerJoin(listings, eq(ranked.subjectId, listings.id))
    .where(
      and(
        // See the same predicate in `findBestSellingListings` above.
        eq(listings.status, 'active'),
        // See the same predicate in `findBestSellingListings` above: a shelf
        // named for a column must not show rows where it is zero.
        gt(ranked.viewCount, 0),
      ),
    )
    .orderBy(desc(ranked.viewCount), desc(listings.id))
    .limit(input.limit)
    .offset(input.offset);
}

/**
 * Store ids ranked by `discovery_signals.units_sold` — the merchant shelf.
 *
 * Joined to `stores` for `status = 'active'` — the same reasoning as
 * `storeRepository.ts`'s `findTopActiveStores`, "since this is a public
 * storefront read." A store counted while it sold can go `suspended` or
 * `closed` afterward, and `findStoresByIds` (the batch hydration Task 7 would
 * call with these ids) does no status filtering of its own.
 *
 * Same zero-count guard as `findBestSellingListings`/`findMostViewedListings`:
 * the sweep's `selectTopByUnion` can seat a store in a scope through the
 * VIEW-COUNT arm of its union with `unitsSold: 0` (stores carry no view count
 * of their own, but still earn a row), which would otherwise put a store that
 * sold nothing onto a shelf labelled best-selling.
 */
export async function findStoresBySignal(input: {
  categoryId: string;
  limit: number;
}): Promise<string[]> {
  const rows = await getDb()
    .select({ subjectId: discoverySignals.subjectId })
    .from(discoverySignals)
    .innerJoin(stores, eq(discoverySignals.subjectId, stores.id))
    .where(
      and(
        eq(discoverySignals.subjectType, 'store'),
        eq(discoverySignals.categoryId, input.categoryId),
        eq(discoverySignals.window, WINDOW),
        eq(stores.status, 'active'),
        gt(discoverySignals.unitsSold, 0),
      ),
    )
    .orderBy(desc(discoverySignals.unitsSold), desc(discoverySignals.id))
    .limit(input.limit);
  return rows.map((row) => row.subjectId);
}

/**
 * Stores with a LIVE `automatic` discount whose saving a card can STATE — the
 * deals scope's store-offer cards. `method: 'code'` is never projected: a
 * shelf advertising a saving the shopper cannot get without a code they do not
 * have is a false price. `bogo` and `free_item` are excluded on the same
 * grounds and by the same test — see {@link STATES_ITS_OWN_SAVING}, which is
 * also what makes a fifth `DiscountValueType` a compile error rather than a
 * silent arrival on the shelf.
 *
 * Filters the discount's method, active flag and scheduled window
 * (`starts_at <= now <= coalesce(ends_at, 'infinity')`, read here as
 * `starts_at <= now` and `ends_at is null or ends_at >= now`), joined to
 * `stores` for `status = 'active'` — the same reasoning as
 * `storeRepository.ts`'s `findTopActiveStores`. This is a cross-store read
 * with no `store_id` predicate, so it does not seek either of `discounts`'
 * composite indexes by their leading column; both exist for the per-store
 * reads in `discountRepository.ts`, not this one.
 */
export async function findStoresWithLiveDiscounts(
  limit: number,
): Promise<{ storeId: string; discount: DiscountRow }[]> {
  const now = new Date();
  const rows = await getDb()
    .select(getTableColumns(discounts))
    .from(discounts)
    .innerJoin(stores, eq(discounts.storeId, stores.id))
    .where(
      and(
        eq(discounts.method, 'automatic'),
        inArray(discounts.valueType, STATABLE_VALUE_TYPES),
        eq(discounts.isActive, true),
        lte(discounts.startsAt, now),
        or(isNull(discounts.endsAt), gte(discounts.endsAt, now)),
        eq(stores.status, 'active'),
      ),
    )
    .orderBy(desc(discounts.startsAt), desc(discounts.id))
    .limit(limit);
  return rows.map((discount) => ({ storeId: discount.storeId, discount }));
}
