/**
 * The product page's shadow comparison (ADR 0002 D24 phase 3, #60's deferred
 * "#70/#71 both-answers comparison").
 *
 * With `CANONICAL_READS=shadow` this page computes the canonical answer AND the
 * listing-first one for the same product, records how they differed, and serves
 * NEITHER — the surface stays 404 while the evidence accumulates. `read-mode.ts`
 * named this issue as the second surface that would do it; this is that module,
 * built to the same shape as `services/search/shadow.ts` so an operator reads
 * one set of counters and not two vocabularies.
 *
 * ## What is compared, and what deliberately is NOT
 *
 * The count of ELIGIBLE OFFERS the canonical page would have served, against
 * the count of ACTIVE NATIVE LISTINGS the listing-first product experience
 * shows for the same product. That comparison answers the question a rollout
 * gates on: does the canonical page find ways to buy this thing that the
 * listing page does not, and — the direction that matters — does it find
 * NOTHING where the listing page found something.
 *
 * What is not measured is OVERLAP, for the reason #70's shadow states about the
 * same join: a listing reaches a canonical product by two unbatched routes that
 * are not the same set, and a number computed the cheap way would be worse than
 * no number at all, because a rollout decision would then rest on it.
 *
 * The two counts are also NOT the same kind of thing, and that is stated rather
 * than smoothed over: one native listing can produce several offers (one per
 * configuration), so `canonicalOffers` exceeding `listingCount` on a
 * multi-variant product is expected and is not evidence of coverage. The
 * load-bearing signal is the ZERO agreement — which of the two found nothing.
 *
 * ## Process-local, exactly as `read-mode.ts` and #70's shadow decided
 *
 * Several ECS tasks each observe their own traffic, a durable row per shadowed
 * read would be an analytics table this domain has no business owning (#77 owns
 * measurement and its own gate forbids a discovery module writing there), and
 * aggregation across tasks belongs to `oxy-infra` scraping the operator
 * endpoint.
 */

/** How one shadowed product page's two answers compared. */
export type ProductPageShadowClass =
  /** Both paths found something to show. */
  | 'both_returned'
  /** Only the canonical page found offers — coverage the listing page lacks. */
  | 'canonical_only'
  /** Only the listing page found listings — the direction a rollout must not regress. */
  | 'listing_only'
  /** Neither found anything. */
  | 'both_empty';

/** The counters one process has accumulated. */
export interface ProductPageShadowCounters {
  readonly pages: number;
  readonly bothReturned: number;
  readonly canonicalOnly: number;
  readonly listingOnly: number;
  readonly bothEmpty: number;
  /** Total eligible offers the canonical page would have served. */
  readonly canonicalOffers: number;
  /** Total active native listings the listing-first path holds for those products. */
  readonly listingResults: number;
}

const EMPTY: ProductPageShadowCounters = {
  pages: 0,
  bothReturned: 0,
  canonicalOnly: 0,
  listingOnly: 0,
  bothEmpty: 0,
  canonicalOffers: 0,
  listingResults: 0,
};

let counters: ProductPageShadowCounters = EMPTY;

/** Classify one comparison. Pure, so the classification is testable alone. */
export function classifyProductPageShadow(
  canonicalCount: number,
  listingCount: number,
): ProductPageShadowClass {
  if (canonicalCount > 0 && listingCount > 0) return 'both_returned';
  if (canonicalCount > 0) return 'canonical_only';
  if (listingCount > 0) return 'listing_only';
  return 'both_empty';
}

/** Record one shadowed page. Never throws; a counter cannot fail a request. */
export function recordProductPageShadow(canonicalCount: number, listingCount: number): void {
  const verdict = classifyProductPageShadow(canonicalCount, listingCount);
  counters = {
    pages: counters.pages + 1,
    bothReturned: counters.bothReturned + (verdict === 'both_returned' ? 1 : 0),
    canonicalOnly: counters.canonicalOnly + (verdict === 'canonical_only' ? 1 : 0),
    listingOnly: counters.listingOnly + (verdict === 'listing_only' ? 1 : 0),
    bothEmpty: counters.bothEmpty + (verdict === 'both_empty' ? 1 : 0),
    canonicalOffers: counters.canonicalOffers + canonicalCount,
    listingResults: counters.listingResults + listingCount,
  };
}

/** The counters, for the operator surface. */
export function readProductPageShadows(): ProductPageShadowCounters {
  return counters;
}

/** Reset. Test-only seam; production never calls it. */
export function resetProductPageShadows(): void {
  counters = EMPTY;
}
