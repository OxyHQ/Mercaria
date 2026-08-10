/**
 * The offer read a search PAGE runs — one statement for every product on it
 * (#70 "Performance": avoid N+1 offer hydration).
 *
 * ## Two statements, and why not one
 *
 * `readProductOfferSummary` reads one product's offers through
 * `listOffersForComparison`. Calling it per result would be forty round trips
 * for a twenty-row page, inside the very latency #77 measures — so this module
 * exists. It does NOT re-implement the comparison read: it selects the offer
 * IDS a comparison would show, per product, bounded; the caller then hydrates
 * exactly those through the same typed select and projects them through the
 * same `projectOffer`.
 *
 * Splitting it in two is deliberate rather than incidental. The ranking pass has
 * to scan and sort a product's whole active offer set to find the cheapest
 * slice (#61 measured that amplification at 124× and recorded it as accepted),
 * and doing it on a two-column projection instead of on fifty-column rows is
 * the difference between reading ids and reading heap. The hydration is then
 * bounded by construction: at most `limitPerProduct` × page size rows, with no
 * predicate that could widen it.
 *
 * ## The pre-filter is a pre-filter, and the derivation is still the authority
 *
 * `stale_at > now` narrows on the indexed stored deadline exactly as
 * `listOffersForComparison`'s `excludeStale` does. #68's rule holds unchanged:
 * the stored deadline can only offer up FEWER candidates than the live policy
 * would, and the caller re-derives freshness through `assessOfferFreshness` and
 * DROPS what it refuses. So a policy change that shortens a lifetime bites at
 * the next search with no sweep having run, and the two can never disagree in
 * the direction that shows an expired price.
 *
 * ## What this module does NOT do
 *
 * It does not choose an offer. Ordering by price is how the CHEAPEST slice is
 * identified for a summary — a fact about the offers — and #74 owns which offer
 * a shopper should be shown. `search-relevance-isolation.test.ts` fails the
 * build if anything on this path learns to read a fee, a commission or a plan.
 */

import { and, asc, eq, inArray, gt, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { conditionKeysInGroup } from '@mercaria/shared-types';
import type {
  ConditionGroup,
  OfferAvailability,
  OfferConditionKey,
  OfferKind,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { offers } from '../schema/offers.js';
import { storefronts } from '../schema/merchants.js';
import type { OfferWithChannel } from '../offers/offerRepository.js';

/**
 * Where an UNPRICED offer sorts: last.
 *
 * The same sentinel `offerRepository.UNPRICED_SORT_KEY` uses and the same one
 * `offers_variant_price_sort_idx` indexes — `Number.MAX_SAFE_INTEGER`, which is
 * `MAX_MONEY_MINOR_UNITS`, so no real price can collide with it. A DIFFERENT
 * constant here would not merely sort differently: an expression index whose
 * constant differs from the reader's by one is an index the planner silently
 * cannot use (#61).
 */
const UNPRICED_SORT_KEY = Number.MAX_SAFE_INTEGER;

/** How a search page narrows the offers it summarises. */
export interface SearchOfferScope {
  /** Only offers published for this market, plus market-less ones. */
  readonly market?: string;
  readonly kinds?: readonly OfferKind[];
  readonly availability?: readonly OfferAvailability[];
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly merchantIds?: readonly string[];
}

/** One product's slot in the ranked offer list. */
export interface ProductOfferId {
  readonly canonicalProductId: string;
  readonly offerId: string;
}

/**
 * The offer-narrowing predicates, built once and used by the ranking statement.
 *
 * Every one of them is a COLUMN on `offers`. The filters that are not — the
 * price range, which needs FX, and the official-channel test, which needs #55's
 * temporal relationships — are deliberately absent: applying them here would
 * mean either a currency comparison with no conversion context or a join whose
 * validity window this statement cannot express, and both are decisions the
 * service makes over projected offers where they are visible.
 */
function scopePredicates(scope: SearchOfferScope, now: Date): SQL[] {
  const predicates: SQL[] = [];

  const marketPredicate =
    scope.market === undefined
      ? undefined
      : or(eq(offers.country, scope.market), isNull(offers.country));
  if (marketPredicate !== undefined) predicates.push(marketPredicate);

  if (scope.kinds !== undefined && scope.kinds.length > 0) {
    predicates.push(inArray(offers.kind, [...scope.kinds]));
  }
  if (scope.availability !== undefined && scope.availability.length > 0) {
    predicates.push(inArray(offers.availability, [...scope.availability]));
  }
  if (scope.conditionGroups !== undefined && scope.conditionGroups.length > 0) {
    // Segments collapse into ONE key membership test, the #90 rule
    // `listOffersForComparison` states: two ANDed `IN` lists answer with the
    // empty set for a facet UI that sent both a segment and a key.
    const keys = new Set<OfferConditionKey>();
    for (const group of scope.conditionGroups) {
      for (const key of conditionKeysInGroup(group)) keys.add(key);
    }
    predicates.push(inArray(offers.condition, [...keys]));
  }
  if (scope.merchantIds !== undefined && scope.merchantIds.length > 0) {
    predicates.push(inArray(offers.merchantId, [...scope.merchantIds]));
  }
  predicates.push(gt(offers.staleAt, now));
  return predicates;
}

/**
 * The cheapest `limitPerProduct` current offers of each product, as IDS.
 *
 * `row_number() over (partition by product_id order by <sort price>, id)` and
 * deliberately not a `CROSS JOIN LATERAL` per product: the lateral form issues
 * one bounded scan per product, which is faster for ONE product and loses to a
 * single partitioned pass as the page widens — and #61 measured the two shapes
 * against each other on the neighbouring deduplication problem (X02 1.240 ms /
 * 3,348 rows against X03 1.985 ms / 6,043) with the window form winning there
 * too. The numbers are for a different query and are cited as the reason the
 * window form was tried FIRST, not as a measurement of this one; `docs/search.md`
 * carries this statement's own figure.
 *
 * The tiebreak is `id`, matching `offers_variant_price_sort_idx`'s own trailing
 * column, so two offers at the same price rank in a stable order across pages.
 */
export async function rankProductOfferIds(
  db: DatabaseOrTransaction,
  input: {
    canonicalProductIds: readonly string[];
    limitPerProduct: number;
    scope: SearchOfferScope;
    now: Date;
  },
): Promise<ProductOfferId[]> {
  if (input.canonicalProductIds.length === 0) return [];

  const predicates = scopePredicates(input.scope, input.now);
  const sortPrice = sql`coalesce(${offers.priceAmount}, ${UNPRICED_SORT_KEY}::bigint)`;
  const ranked = db
    .select({
      canonicalProductId: canonicalVariants.productId,
      offerId: offers.id,
      position: sql<number>`row_number() over (
        partition by ${canonicalVariants.productId}
        order by ${sortPrice} asc, ${offers.id} asc
      )`.as('position'),
    })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .where(
      and(
        eq(offers.status, 'active'),
        inArray(canonicalVariants.productId, [...input.canonicalProductIds]),
        ...predicates,
      ),
    )
    .as('ranked');

  const rows = await db
    .select({ canonicalProductId: ranked.canonicalProductId, offerId: ranked.offerId })
    .from(ranked)
    .where(sql`${ranked.position} <= ${input.limitPerProduct}`)
    .orderBy(asc(ranked.canonicalProductId), asc(ranked.position));

  return rows.map((row) => ({
    canonicalProductId: row.canonicalProductId,
    offerId: row.offerId,
  }));
}

/**
 * Hydrate exactly the offers {@link rankProductOfferIds} chose.
 *
 * Returns `OfferWithChannel`, the shape `buildOfferProjectionContext` and
 * `projectOffer` already take — so the page goes through the SAME projection
 * the public `GET /offers` read uses, freshness assessment included, rather
 * than through a search-shaped copy of it.
 */
export async function loadOffersWithChannel(
  db: DatabaseOrTransaction,
  offerIds: readonly string[],
): Promise<OfferWithChannel[]> {
  if (offerIds.length === 0) return [];
  const rows = await db
    .select({ offer: offers, storefrontOperatorMerchantId: storefronts.merchantId })
    .from(offers)
    .leftJoin(storefronts, eq(storefronts.id, offers.storefrontId))
    .where(inArray(offers.id, [...offerIds]));
  return rows.map((row) => ({
    offer: row.offer,
    storefrontOperatorMerchantId: row.storefrontOperatorMerchantId,
  }));
}
