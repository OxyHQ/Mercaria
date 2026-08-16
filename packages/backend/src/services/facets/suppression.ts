/**
 * Which facets and which answers are withheld, and why (#367 Workstream 10).
 *
 * PURE. Two rules carry the whole module and they pull in opposite directions,
 * which is what makes them worth stating together.
 *
 * ## Suppress what cannot narrow anything
 *
 * A facet whose every in-scope product gives the same answer is a control that
 * does nothing: pressing it returns the same set. A bucket with a zero count is
 * a control that empties the page. Both are noise, and a rail full of noise is
 * one nobody reads — including the parts that would have helped.
 *
 * ## Never withdraw something the shopper CHOSE
 *
 * The moment a selection makes a facet degenerate, the rule above would remove
 * the control the shopper is currently using. Their filter would still be
 * applied — the results are narrowed — and the chip explaining why would be
 * gone. That is a page lying about its own state, and it is unrecoverable
 * without clearing everything.
 *
 * So selection WINS, at both grains: a selected bucket is always rendered, count
 * and all, and a facet carrying any selected bucket is always offered. This is
 * "selected filters preserved even when the current result set makes a facet
 * count zero", and it is one predicate rather than a special case, because the
 * suppressor is handed the selection rather than deriving it.
 */

import type { FacetSuppressionReason } from '@mercaria/shared-types';
import { FACET_MIN_DISTINCT_VALUES } from '@mercaria/shared-types';

/** One candidate answer, as the suppressor sees it. */
export interface SuppressibleBucket {
  readonly key: string;
  readonly count: number;
  readonly selected: boolean;
}

/** The outcome for one facet's answers. */
export interface BucketSuppression {
  readonly kept: readonly SuppressibleBucket[];
  readonly dropped: number;
}

/**
 * Drop the answers that cannot help, keeping every one the shopper picked.
 *
 * A zero count on an UNSELECTED bucket means picking it empties the page, so it
 * goes. A zero count on a SELECTED one is information — "your current filters
 * have no overlap" — and it is the only place the shopper can see that, so it
 * stays.
 */
export function suppressBuckets(
  buckets: readonly SuppressibleBucket[],
  cap: number,
): BucketSuppression {
  const kept = buckets.filter((bucket) => bucket.selected || bucket.count > 0);
  if (kept.length <= cap) return { kept, dropped: buckets.length - kept.length };
  // The cap is a response-size bound, not a policy: a selected bucket is never
  // the one dropped, so a shopper cannot lose their own chip to a long tail.
  const selected = kept.filter((bucket) => bucket.selected);
  const rest = kept.filter((bucket) => !bucket.selected).slice(0, Math.max(0, cap - selected.length));
  const capped = kept.filter((bucket) => selected.includes(bucket) || rest.includes(bucket));
  return { kept: capped, dropped: buckets.length - capped.length };
}

/** What the facet-level suppressor needs to decide. */
export interface SuppressibleFacet {
  readonly key: string;
  /** Set by `planFacets` when metadata already withheld it. */
  readonly metadataSuppression?: FacetSuppressionReason;
  readonly shape: 'buckets' | 'range' | 'money_range';
  readonly buckets: readonly SuppressibleBucket[];
  readonly rangeMin?: number;
  readonly rangeMax?: number;
  /** Whether any selection names this facet. */
  readonly hasSelection: boolean;
  /** Set when a price facet's bound currency had no rate for anything in scope. */
  readonly unconvertible?: boolean;
}

/**
 * Why this facet is withheld, or `undefined` when it is offered.
 *
 * The selection exemption is checked BEFORE every data-driven reason and AFTER
 * the metadata ones. That order is the decision: a facet the registry says is
 * not filterable, or the product type hides, must stay hidden even if a stale
 * client sends a selection for it — otherwise a selection would be a way to
 * summon a control somebody deliberately withheld. A facet that is merely
 * degenerate right now is the shopper's own doing and stays visible.
 */
export function suppressFacet(facet: SuppressibleFacet): FacetSuppressionReason | undefined {
  if (facet.metadataSuppression !== undefined) return facet.metadataSuppression;
  if (facet.hasSelection) return undefined;
  if (facet.unconvertible === true) return 'unconvertible_currency';

  if (facet.shape === 'buckets') {
    const live = facet.buckets.filter((bucket) => bucket.count > 0);
    if (live.length === 0) return 'no_values';
    if (live.length < FACET_MIN_DISTINCT_VALUES) return 'single_value';
    return undefined;
  }

  if (facet.rangeMin === undefined || facet.rangeMax === undefined) return 'no_values';
  if (facet.rangeMin === facet.rangeMax) return 'degenerate_range';
  return undefined;
}
