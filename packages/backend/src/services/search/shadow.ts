/**
 * The shadow comparison (#70 rollout 3 and 4, ADR 0002 D24 phase 3).
 *
 * With `CANONICAL_SEARCH=shadow` the handler computes the canonical answer AND
 * the listing-first answer for the same query, records how they differed, and
 * serves NEITHER — the surface stays 404 while the evidence accumulates. That
 * is what "shadow/compare old and new results for a representative query set"
 * means operationally: a rollout decision made from measurements taken on real
 * traffic, before a shopper has seen a canonical result.
 *
 * ## What is compared, and what is deliberately NOT
 *
 * Result COUNTS and ZERO-RESULT agreement, per query, aggregated. Nothing else.
 *
 * The tempting third measure is result OVERLAP — how many of the listings the
 * old path returned belong to the products the new one returned — and it is not
 * measured here, for the reason `analytics/search-instrumentation.ts` already
 * documents about the same join: a listing reaches a canonical product by two
 * routes that are not the same set (`product_identifiers` through its variants,
 * and `native_listing_links`), NEITHER is batched, and resolving a twenty-row
 * page would cost tens of queries inside the request being measured. Reporting
 * a number computed the cheap way — matching titles — would be worse than
 * reporting none, because a rollout decision would then rest on it.
 *
 * The four disagreement classes that ARE recorded answer the questions a
 * rollout actually gates on: does the canonical path find things the listing
 * path does not, does it find NOTHING where the old path found something (the
 * dangerous direction), and how often do they agree that there is nothing.
 *
 * ## Process-local, and that is the same decision `read-mode.ts` made
 *
 * The `ledgerImbalanceAttempts` reasoning, verbatim: several ECS tasks each
 * observe their own traffic, a durable row per shadowed search would be an
 * analytics table this domain has no business owning (#77 owns measurement, and
 * its own isolation gate forbids a discovery module writing there), and
 * aggregation across tasks belongs to `oxy-infra` scraping the operator
 * endpoint.
 */

/** How one shadowed query's two answers compared. */
export type ShadowComparisonClass =
  /** Both paths returned rows. */
  | 'both_returned'
  /** Only the canonical path returned rows — coverage the old path lacked. */
  | 'canonical_only'
  /** Only the listing path returned rows — the direction a rollout must not regress. */
  | 'listing_only'
  /** Neither returned anything. */
  | 'both_empty';

/** The counters one process has accumulated. */
export interface ShadowComparisonCounters {
  readonly queries: number;
  readonly bothReturned: number;
  readonly canonicalOnly: number;
  readonly listingOnly: number;
  readonly bothEmpty: number;
  /** Total rows the canonical path would have returned across every query. */
  readonly canonicalResults: number;
  /** Total rows the listing-first path returned across every query. */
  readonly listingResults: number;
}

const EMPTY: ShadowComparisonCounters = {
  queries: 0,
  bothReturned: 0,
  canonicalOnly: 0,
  listingOnly: 0,
  bothEmpty: 0,
  canonicalResults: 0,
  listingResults: 0,
};

let counters: ShadowComparisonCounters = EMPTY;

/** Classify one comparison. Pure, so the classification is testable alone. */
export function classifyShadowComparison(
  canonicalCount: number,
  listingCount: number,
): ShadowComparisonClass {
  if (canonicalCount > 0 && listingCount > 0) return 'both_returned';
  if (canonicalCount > 0) return 'canonical_only';
  if (listingCount > 0) return 'listing_only';
  return 'both_empty';
}

/** Record one shadowed query. Never throws; a counter cannot fail a request. */
export function recordShadowComparison(canonicalCount: number, listingCount: number): void {
  const verdict = classifyShadowComparison(canonicalCount, listingCount);
  counters = {
    queries: counters.queries + 1,
    bothReturned: counters.bothReturned + (verdict === 'both_returned' ? 1 : 0),
    canonicalOnly: counters.canonicalOnly + (verdict === 'canonical_only' ? 1 : 0),
    listingOnly: counters.listingOnly + (verdict === 'listing_only' ? 1 : 0),
    bothEmpty: counters.bothEmpty + (verdict === 'both_empty' ? 1 : 0),
    canonicalResults: counters.canonicalResults + canonicalCount,
    listingResults: counters.listingResults + listingCount,
  };
}

/** The counters, for the operator surface. */
export function readShadowComparisons(): ShadowComparisonCounters {
  return counters;
}

/** Reset. Test-only seam; production never calls it. */
export function resetShadowComparisons(): void {
  counters = EMPTY;
}
