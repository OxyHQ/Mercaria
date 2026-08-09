/**
 * The DETERMINISTIC reconciliation rule for one merchant's offers appearing
 * twice (#84 catalog rule 4, acceptance 3) — a pure function.
 *
 * ## The situation this exists for
 *
 * A merchant's web shop was crawled before they ever heard of Mercaria, so their
 * catalogue is already in the graph as EXTERNAL offers on their own storefront.
 * They then claim the merchant and connect a native store, and their listings
 * begin materializing NATIVE offers against the same canonical variants. Two
 * rows now describe one real sale.
 *
 * ## What reconciliation does NOT do, and why the function returns a finding
 *
 * It does not delete, retire, re-price or merge anything. Issue catalog rule 3
 * ("do not delete external offers merely because the merchant now sells
 * natively"), rule 5 ("preserve all prior clicks, price history and source
 * records") and acceptance 3 ("matching external and native offers remain
 * distinct but share the canonical product") are three views of one property:
 * both rows survive, both keep pointing at their own `source_record_id` chain,
 * and the comparison surface keeps showing what each seller actually published.
 *
 * So the output is a FINDING — which representation is primary, which is the
 * duplicate, and which rule decided — in the shape `payment_discrepancies` uses
 * for the same reason: a thing an operator can see and act on, with no
 * destructive effect of its own.
 *
 * ## Determinism means TOTAL, not merely "usually the same"
 *
 * The four rules are applied in order and the last two exist to close the gap a
 * three-rule set would leave: `most_recently_seen` breaks a tie between two
 * comparable offers, and `lowest_offer_id` breaks a tie between two seen at the
 * same instant. A rule set that can end in a coin flip is not deterministic,
 * and "prefer the newest" alone ends in one every time a batch import stamps
 * two rows with one timestamp.
 */

import type { StoreLinkageOverlapRule } from '@mercaria/shared-types';

/**
 * One active offer, projected down to exactly what the rules read.
 *
 * `sellerIsChannelOperator` is ADR 0002 D8's derived marketplace fact handed in
 * already computed (`offers.merchant_id === storefronts.merchant_id`), rather
 * than recomputed here from a storefront row. That keeps this module unable to
 * reach the graph at all, and keeps the derivation in the one place that owns it.
 */
export interface OverlapCandidateOffer {
  offerId: string;
  canonicalVariantId: string;
  kind: 'native' | 'external' | 'affiliate' | 'informational';
  /** True when this offer's channel is operated by its own seller of record. */
  sellerIsChannelOperator: boolean;
  lastSeenAt: Date;
}

/** One duplicate representation and the rule that demoted it. */
export interface OfferOverlapFinding {
  canonicalVariantId: string;
  primaryOfferId: string;
  duplicateOfferId: string;
  rule: StoreLinkageOverlapRule;
}

/**
 * Which of two representations wins, and under which rule.
 *
 * Returned as a pair so the caller records the RULE that fired rather than
 * inferring it — an audit line saying "native won" is worth having, and one
 * saying "the newer one won" when in fact the ids were compared is worse than
 * no line at all.
 */
function preferOne(
  a: OverlapCandidateOffer,
  b: OverlapCandidateOffer,
): { winner: OverlapCandidateOffer; loser: OverlapCandidateOffer; rule: StoreLinkageOverlapRule } {
  // 1. A native offer is the merchant's own live catalogue: Mercaria reads its
  //    price from the variant the seller edits, not from a page somebody
  //    crawled. It is the better representation of the same sale whenever both
  //    exist.
  const aNative = a.kind === 'native';
  const bNative = b.kind === 'native';
  if (aNative !== bNative) {
    const winner = aNative ? a : b;
    return { winner, loser: winner === a ? b : a, rule: 'native_supersedes_external' };
  }

  // 2. Between two external representations, the one on a channel the seller
  //    OPERATES beats the one on somebody else's marketplace — the seller's own
  //    shop is the authority on the seller's own price (ADR 0002 D8's derived
  //    fact, used as a preference and never stored as a flag).
  if (a.sellerIsChannelOperator !== b.sellerIsChannelOperator) {
    const winner = a.sellerIsChannelOperator ? a : b;
    return {
      winner,
      loser: winner === a ? b : a,
      rule: 'operated_channel_supersedes_marketplace',
    };
  }

  // 3. Otherwise the fresher observation.
  if (a.lastSeenAt.getTime() !== b.lastSeenAt.getTime()) {
    const winner = a.lastSeenAt.getTime() > b.lastSeenAt.getTime() ? a : b;
    return { winner, loser: winner === a ? b : a, rule: 'most_recently_seen' };
  }

  // 4. And finally the lower id, which is what makes the order TOTAL. Two rows
  //    stamped by one batch import reach here, and without this the answer
  //    would depend on the order the rows came back in.
  const winner = a.offerId <= b.offerId ? a : b;
  return { winner, loser: winner === a ? b : a, rule: 'lowest_offer_id' };
}

/**
 * Reconcile one merchant's offers on the variants where they overlap.
 *
 * Grouped by canonical variant, because that is the grain at which two rows
 * describe the same purchasable thing (ADR 0002 D5/D18: comparison happens at
 * the product page, commerce at the variant). A variant carrying one offer
 * produces no finding — that is the normal state and not an overlap.
 *
 * The winner is found by a fold rather than by a sort, so the RULE recorded for
 * each loser is the rule that actually demoted it against the eventual primary,
 * not the rule that separated it from whichever neighbour it happened to sit
 * beside in a sorted array.
 */
export function reconcileMerchantOfferOverlaps(
  offers: readonly OverlapCandidateOffer[],
): OfferOverlapFinding[] {
  const byVariant = new Map<string, OverlapCandidateOffer[]>();
  for (const offer of offers) {
    const group = byVariant.get(offer.canonicalVariantId);
    if (group) group.push(offer);
    else byVariant.set(offer.canonicalVariantId, [offer]);
  }

  const findings: OfferOverlapFinding[] = [];

  for (const [canonicalVariantId, group] of byVariant) {
    if (group.length < 2) continue;

    // Sorting by id first makes the fold's starting point independent of the
    // caller's row order — without it, `lowest_offer_id` could still see two
    // different inputs produce two different primaries.
    const ordered = [...group].sort((a, b) => a.offerId.localeCompare(b.offerId));
    const [head, ...rest] = ordered;
    if (!head) continue;

    let primary = head;
    for (const contender of rest) {
      primary = preferOne(primary, contender).winner;
    }

    for (const offer of ordered) {
      if (offer.offerId === primary.offerId) continue;
      findings.push({
        canonicalVariantId,
        primaryOfferId: primary.offerId,
        duplicateOfferId: offer.offerId,
        rule: preferOne(primary, offer).rule,
      });
    }
  }

  return findings.sort(
    (a, b) =>
      a.canonicalVariantId.localeCompare(b.canonicalVariantId) ||
      a.duplicateOfferId.localeCompare(b.duplicateOfferId),
  );
}
