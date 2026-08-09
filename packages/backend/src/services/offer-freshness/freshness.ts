/**
 * Assessing an offer's freshness against its own source's contract (#68
 * §"Freshness model", §"Public behavior").
 *
 * ## `offers.stale_at` is a PRE-FILTER; the derivation is the AUTHORITY
 *
 * The comparison read has to narrow a million rows before it can project any of
 * them, and the only thing indexable at that point is a stored deadline
 * (`offers_freshness_idx`). So the SQL keeps filtering on `stale_at`, which the
 * ingest path stamps from the resolved policy — and then the PROJECTION
 * re-derives the verdict live and drops anything it refuses.
 *
 * That ordering matters and is the whole reason this is not "two
 * representations of one fact" in the sense #57 forbids. The two can only
 * disagree after a policy change, and the intersection of the two filters is a
 * SUBSET of what the derivation admits — so the disagreement can hide an offer
 * and can never show one the live policy says is expired. A contractual cache
 * cap that shortens a lifetime therefore bites at the next read, with no sweep
 * having run, which is the direction that keeps a contract.
 *
 * The visible cost is stated rather than hidden: a page may return fewer than
 * `limit` offers when the derivation drops some, and the caller follows
 * `nextCursor` exactly as before — the cursor is a keyset over the SQL order,
 * which the drop does not touch.
 */

import {
  assessOfferFreshness,
  mayAppearInComparison,
  nativeOfferFreshness,
  type OfferFreshnessAssessment,
  type OfferFreshnessObservation,
  type SourceFreshnessPolicy,
} from '@mercaria/shared-types';
import type { OfferRow } from '../../db/offers/offerRepository.js';

/** Read one offer row as the pure derivation's view of its timestamps. */
export function toFreshnessObservation(
  row: OfferRow,
  sourceId: string | null,
): OfferFreshnessObservation {
  return {
    sourceId,
    observedAt: row.observedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastConfirmedAt: row.lastConfirmedAt,
    declaredUnavailableAt: row.declaredUnavailableAt,
    storedExpiresAt: row.staleAt,
  };
}

/**
 * The verdict for one offer, native or external.
 *
 * A NATIVE offer never reaches `assessOfferFreshness`: it has no source, its
 * buyability is derived LIVE from the listing at projection time, and its
 * `stale_at` measures how long ago the convergence dispatcher ran. Expiring it
 * on that clock would delist a healthy catalogue during a dispatcher outage,
 * which is the exact failure #68 exists to prevent, pointed at ourselves.
 */
export function assessOffer(
  row: OfferRow,
  input: {
    sourceId: string | null;
    policy: SourceFreshnessPolicy | null;
    now: Date;
  },
): OfferFreshnessAssessment {
  const observation = toFreshnessObservation(row, input.sourceId);
  if (row.kind === 'native') return nativeOfferFreshness(observation, input.now);
  return assessOfferFreshness(observation, input.policy, input.now);
}

/**
 * May this offer be shown in a comparison, a search summary or a product
 * page's current-offer set?
 *
 * Two conditions, and the second is #68's addition: the row must still be
 * ACTIVE (a retired offer is history, #57), and the live derivation must admit
 * it. `mayAppearInComparison` is an exhaustive switch over the levels, so a
 * sixth level fails `tsc` there rather than defaulting into the visible set.
 */
export function offerIsCurrentlyVisible(
  row: OfferRow,
  assessment: OfferFreshnessAssessment,
): boolean {
  return row.status === 'active' && mayAppearInComparison(assessment);
}
