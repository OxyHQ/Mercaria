/**
 * Revalidating a plan before anybody acts on it (#96 solver design rule 7,
 * UX rule 9).
 *
 * A plan is a statement about a moment. Between the solve and the click a
 * source refreshes, a jury restricts a listing, a seller loses payment
 * readiness or a price moves — and the failure this exists to prevent is a
 * shopper being sent to a retailer for a price Mercaria quoted and the retailer
 * no longer offers.
 *
 * ## It re-reads through #74 and compares against the SNAPSHOT
 *
 * Not against the plan: the plan is a projection, and re-deriving eligibility
 * from it would mean this module deciding what "still eligible" means. The
 * snapshot carries the TERMS each offer was solved against and the revalidation
 * asks #74 the same question again, rebuilding the candidate through the SAME
 * `toCandidate` the solve used and diffing one fingerprint against the other.
 *
 * The fingerprint is item price, delivery cost and the free-shipping THRESHOLD,
 * not the price alone. A merchant raising its delivery fee, or lifting its
 * free-over above the basket, moves exactly the figure a shopper was shown —
 * "at least X, plus delivery from N merchants" — and a check that watched only
 * the item price would answer `unchanged` and `mayProceed: true` for it.
 *
 * ## `mayProceed` is DERIVED, and refuses on ANY movement
 *
 * A price that went DOWN blocks too, and that is deliberate: the shopper is
 * about to act on a plan whose totals no longer describe what they would pay,
 * and a cheaper basket is still a different basket. The remedy is one button —
 * recalculate — which is UX rule 9's "recalculate with current data rather than
 * presenting a stale plan as current" arriving as behaviour rather than as
 * copy.
 */

import type {
  BasketInputSnapshot,
  BasketLineRevalidation,
  BasketPlan,
  BasketReasonCode,
  BasketRevalidation,
  Offer,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';
import { rankOfferComparison } from '../ranking/comparison.service.js';
import { renderCandidateTerms } from './basket/candidates.js';
import { comparisonRates, sellerLabelOf, toCandidate } from './basket/candidate-source.js';
import { ComparisonRecordIndex } from './record-refs.js';

export interface RevalidateInput {
  readonly snapshot: BasketInputSnapshot;
  readonly plan: BasketPlan;
  /** Offer ref → the real offer id, from the solution's record table. */
  readonly offerIdsByRef: ReadonlyMap<string, string>;
}

/**
 * Re-check every line of one plan.
 *
 * Throws `validationError` when the plan names an offer the snapshot never
 * carried — a plan and a snapshot from two different solves cannot be compared,
 * and answering anything at all for that pair would be answering about a basket
 * nobody has.
 */
export async function revalidateBasketPlan(
  input: RevalidateInput,
): Promise<BasketRevalidation> {
  const revalidatedAt = new Date().toISOString();
  const lines: BasketLineRevalidation[] = [];
  const reasons: BasketReasonCode[] = [];
  const rates = await comparisonRates(input.snapshot.comparisonCurrency);
  // A throwaway index: the refs it mints are never emitted, and rebuilding the
  // candidate is the only way to compute the terms through the same code the
  // solve used rather than a second reading of the same offer.
  const index = new ComparisonRecordIndex();

  for (const planLine of input.plan.lines) {
    if (!input.snapshot.candidateOfferRefs.includes(planLine.offerRef)) {
      throw validationError('That plan does not belong to this snapshot');
    }
    const offerId = input.offerIdsByRef.get(planLine.offerRef);
    if (offerId === undefined) {
      throw validationError('That plan does not belong to this snapshot');
    }

    const requestLine = input.snapshot.request.lines.find(
      (line) => line.lineId === planLine.lineId,
    );
    if (requestLine === undefined) {
      throw validationError('That plan does not belong to this snapshot');
    }

    const ranked = await rankOfferComparison({
      ...(requestLine.canonicalVariantId === undefined
        ? { canonicalProductId: requestLine.canonicalProductId }
        : { canonicalVariantId: requestLine.canonicalVariantId }),
      comparisonCurrency: input.snapshot.comparisonCurrency,
      ...(input.snapshot.market === undefined ? {} : { market: input.snapshot.market }),
      ...(requestLine.conditionGroups === undefined
        ? {}
        : { conditionGroups: requestLine.conditionGroups }),
      limit: 50,
    });

    const stillEligible = ranked.comparison.offers.find(
      (rankedOffer) => rankedOffer.offerId === offerId,
    );
    if (stillEligible === undefined) {
      // The offer is gone from the ELIGIBLE set. #74's `excluded` list says why
      // when it is still in the candidate window; a source that retired the row
      // outright leaves neither, and both are the same fact to a shopper.
      lines.push({
        state: 'ineligible',
        lineId: planLine.lineId,
        offerRef: planLine.offerRef,
        reasons: ['offer_no_longer_eligible'],
      });
      if (!reasons.includes('offer_no_longer_eligible')) reasons.push('offer_no_longer_eligible');
      continue;
    }

    const liveOffer: Offer | undefined = ranked.offers.get(offerId);
    if (liveOffer === undefined) {
      lines.push({
        state: 'ineligible',
        lineId: planLine.lineId,
        offerRef: planLine.offerRef,
        reasons: ['offer_no_longer_eligible'],
      });
      if (!reasons.includes('offer_no_longer_eligible')) reasons.push('offer_no_longer_eligible');
      continue;
    }

    const nowRendered = renderCandidateTerms(
      toCandidate({
        index,
        lineId: planLine.lineId,
        subjectRef: planLine.subjectRef,
        offer: liveOffer,
        rankedOffer: stillEligible,
        policyVersion: ranked.comparison.policy.version,
        currency: input.snapshot.comparisonCurrency,
        rates,
        sellerLabel: sellerLabelOf(undefined),
      }),
    );
    const wasRendered = input.snapshot.candidateTerms[planLine.offerRef] ?? 'unknown';
    if (nowRendered !== wasRendered) {
      lines.push({
        state: 'price_changed',
        lineId: planLine.lineId,
        offerRef: planLine.offerRef,
        wasRendered,
        nowRendered,
      });
      if (!reasons.includes('offer_price_changed')) reasons.push('offer_price_changed');
      continue;
    }

    lines.push({ state: 'unchanged', lineId: planLine.lineId, offerRef: planLine.offerRef });
  }

  const mayProceed = reasons.length === 0;
  return {
    snapshotDigest: input.snapshot.digest,
    revalidatedAt,
    lines,
    mayProceed,
    reasons,
  };
}

/**
 * The offer ids behind a solution's refs.
 *
 * A caller hands back the record table it was given, and this is the ONE place
 * a ref becomes an id again — which is what keeps the opaque handle opaque
 * everywhere else.
 */
export function offerIdsByRef(
  records: readonly { readonly ref: string; readonly kind: string; readonly recordId: string }[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== 'offer') continue;
    map.set(record.ref, record.recordId);
  }
  return map;
}
