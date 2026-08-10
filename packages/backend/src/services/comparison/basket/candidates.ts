/**
 * The candidate set the solver searches (#96 solver design rule 3).
 *
 * PURE. Two jobs, and the second one is where the care goes:
 *
 * 1. **Filter** by the request's own constraints — channel policy, excluded
 *    merchants, a line's requested condition or merchant, and a POSITIVE
 *    statement that stock is insufficient.
 * 2. **Prune dominated offers WITHOUT removing a distinct trust, condition,
 *    delivery or channel option.**
 *
 * ## Dominance is only ever computed inside one distinction bucket
 *
 * Two offers are comparable for pruning only when they agree on every
 * qualitative axis a shopper might be choosing between:
 * `(merchant, condition group, channel, verified standing, whether delivery is
 * known)`. Inside such a bucket, a strictly cheaper offer with no worse quoted
 * delivery and no worse quoted window really is the same purchase for less
 * money.
 *
 * Across buckets nothing is pruned, ever. A refurbished unit from an official
 * store at twice the price of an unknown-condition marketplace listing is not
 * dominated by it — those are different products to a shopper — and a
 * comparison that quietly dropped one would be answering a question nobody
 * asked. That is the rule the issue states, and it is the reason the bucket key
 * is spelled out rather than left as "similar offers".
 *
 * ## Unknown is compared conservatively, in both directions
 *
 * An unknown delivery is not "worse than" a known one and not "better than" it:
 * it is a different bucket. An unquoted delivery WINDOW is incomparable, so an
 * offer that quotes one never dominates an offer that does not and vice versa.
 * Every one of those decisions errs toward KEEPING a candidate, which costs
 * search time and cannot cost a shopper an option.
 */

import {
  hasKnownComparisonMoney,
  type BasketChannelPolicy,
  type BasketReasonCode,
  type BasketRequestLine,
  type ComparisonAcquisitionChannel,
  type ComparisonMoneyFact,
  type ComparisonOfferFreshness,
  type ConditionGroup,
  type OfferRelationshipStanding,
  type OfferTaxInclusion,
} from '@mercaria/shared-types';
import { MAX_BASKET_CANDIDATES, MAX_CANDIDATES_PER_LINE } from '../policy.js';

/**
 * One way to serve one line.
 *
 * `merchantKey` is the SOLVER's notion of a merchant, and it is not always an
 * id. Every NATIVE offer shares the key `native`, because every native line
 * goes into one Mercaria cart and is one checkout for the shopper — which is
 * what a merchant costs them. An external offer keys on its merchant id; an
 * external offer that names no merchant keys on its own offer id, the
 * conservative reading, since two offers cannot be assumed to share a seller
 * without a record saying so.
 */
export interface BasketCandidate {
  readonly lineId: string;
  readonly subjectRef: string;
  readonly offerRef: string;
  readonly offerId: string;
  readonly merchantKey: string;
  readonly merchantRef?: string;
  readonly merchantLabel: string;
  readonly channel: ComparisonAcquisitionChannel;
  readonly unitItemPrice: ComparisonMoneyFact;
  /** The delivery this offer quotes for an order containing it. */
  readonly delivery: ComparisonMoneyFact;
  /** The basket value above which this merchant ships free, when they state one. */
  readonly deliveryFreeOver: ComparisonMoneyFact;
  readonly deliveryMaxDays?: number;
  readonly taxInclusion: OfferTaxInclusion;
  readonly conditionGroup?: ConditionGroup;
  readonly relationship?: OfferRelationshipStanding;
  /** Present only when the source published one (#57 commercial fact 3). */
  readonly availableQuantity?: number;
  readonly freshness: ComparisonOfferFreshness;
  readonly nativeCheckoutEligible: boolean;
  /** The native variant a cart line would be created from. Native offers only. */
  readonly productVariantId?: string;
  readonly destinationHost?: string;
  /** #74's tie-break digest for this offer under the ranking policy in force. */
  readonly tieBreak: string;
}

/** What survived filtering and pruning, and what it cost. */
export interface PrunedCandidates {
  readonly candidates: readonly BasketCandidate[];
  /** Line id → every reason its candidates were refused, when none survived. */
  readonly refusals: ReadonlyMap<string, readonly BasketReasonCode[]>;
  /** Whether a cap removed a candidate that passed every filter. */
  readonly truncated: boolean;
}

export interface PruneInput {
  readonly lines: readonly BasketRequestLine[];
  readonly candidates: readonly BasketCandidate[];
  readonly channelPolicy: BasketChannelPolicy;
  readonly excludedMerchantIds: readonly string[];
  /**
   * The request-level condition filter — the DEFAULT for a line that names
   * none.
   *
   * Resolved HERE rather than expanded onto the lines by a caller, because this
   * module is the only thing that applies a condition filter at all. A caller
   * that composed the pure pieces itself and forgot to expand would silently
   * plan a basket the shopper's preference should have narrowed, and that is a
   * filter working in one composition and not another — which is exactly the
   * bug the benchmark caught when the expansion lived one layer up.
   *
   * `gatherCandidates` also narrows the #74 read by a line's own segments. That
   * is an OPTIMISATION and may only ever be WIDER than this: a wider read
   * returns candidates this function then refuses, while a narrower one would
   * be a second filter with no reason code.
   */
  readonly conditionGroups?: readonly ConditionGroup[];
}

/**
 * Filter and prune.
 *
 * A line whose candidates are all refused gets an entry in `refusals` carrying
 * EVERY reason that applied to at least one of its offers — never just the
 * first. A shopper asking why an item is missing from their basket needs the
 * whole list, which is the rule #74's eligibility already follows for exactly
 * this question one domain over.
 */
export function pruneBasketCandidates(input: PruneInput): PrunedCandidates {
  const excluded = new Set(input.excludedMerchantIds);
  const refusals = new Map<string, BasketReasonCode[]>();
  const kept: BasketCandidate[] = [];
  let truncated = false;

  for (const line of input.lines) {
    const forLine = input.candidates.filter((candidate) => candidate.lineId === line.lineId);
    const reasons: BasketReasonCode[] = [];
    const admitted: BasketCandidate[] = [];

    if (forLine.length === 0) reasons.push('no_eligible_offer');

    const segments = line.conditionGroups ?? input.conditionGroups;
    for (const candidate of forLine) {
      const refusal = refuse(candidate, segments, line, input.channelPolicy, excluded);
      if (refusal === undefined) admitted.push(candidate);
      else if (!reasons.includes(refusal)) reasons.push(refusal);
    }

    if (admitted.length === 0) {
      refusals.set(line.lineId, reasons.length === 0 ? ['no_eligible_offer'] : reasons);
      continue;
    }

    const surviving = removeDominated(admitted);
    const ordered = sortForCap(surviving);
    if (ordered.length > MAX_CANDIDATES_PER_LINE) truncated = true;
    kept.push(...ordered.slice(0, MAX_CANDIDATES_PER_LINE));
  }

  if (kept.length > MAX_BASKET_CANDIDATES) {
    truncated = true;
    return {
      candidates: kept.slice(0, MAX_BASKET_CANDIDATES),
      refusals,
      truncated,
    };
  }
  return { candidates: kept, refusals, truncated };
}

/** Why one candidate cannot serve one line, or `undefined` when it can. */
function refuse(
  candidate: BasketCandidate,
  segments: readonly ConditionGroup[] | undefined,
  line: BasketRequestLine,
  channelPolicy: BasketChannelPolicy,
  excluded: ReadonlySet<string>,
): BasketReasonCode | undefined {
  // Keyed on `merchantKey`, which for a native offer is the shared `native`
  // key: excluding "native" excludes Mercaria's own checkout, which is a thing
  // a shopper can legitimately ask for and is what `native_only`'s opposite
  // looks like.
  if (excluded.has(candidate.merchantKey)) return 'every_offer_from_excluded_merchant';

  if (!channelPermits(channelPolicy, candidate)) return 'no_offer_in_channel_policy';

  if (
    segments !== undefined &&
    segments.length > 0 &&
    // An UNKNOWN condition cannot satisfy a condition filter — #74 eligibility
    // rule 6's reasoning, restated because the basket applies its own filter
    // over an already-eligible set.
    (candidate.conditionGroup === undefined || !segments.includes(candidate.conditionGroup))
  ) {
    return 'no_offer_in_requested_condition';
  }

  if (line.merchantId !== undefined && candidate.merchantKey !== line.merchantId) {
    return 'no_offer_from_requested_merchant';
  }

  if (!hasKnownComparisonMoney(candidate.unitItemPrice)) return 'no_convertible_price';

  // Refused ONLY on a positive statement. Most sources publish no quantity at
  // all, and reading that silence as "not enough stock" would empty a basket;
  // reading it as "enough stock" would be the soft yes. #74 draws the same line
  // for availability and this is that line applied to a count.
  if (candidate.availableQuantity !== undefined && candidate.availableQuantity < line.quantity) {
    return 'quantity_exceeds_available_stock';
  }

  return undefined;
}

/** Whether the request's channel policy admits this candidate. */
function channelPermits(policy: BasketChannelPolicy, candidate: BasketCandidate): boolean {
  switch (policy) {
    case 'native_only':
      return candidate.channel === 'native_checkout';
    case 'external_only':
      return candidate.channel === 'external_merchant';
    case 'official_only':
      return candidate.relationship === 'official_channel';
    case 'mixed':
      return true;
    default:
      return false;
  }
}

/**
 * The bucket two candidates must share before either can dominate the other.
 *
 * Every axis the issue names is in it. `deliveryKnown` is in it because an
 * offer whose postage nobody published is a different proposition from one
 * whose postage is known, whatever the item prices are — collapsing them is how
 * an offer with a hidden shipping cost buries one that quoted it.
 */
export function distinctionKeyOf(candidate: BasketCandidate): string {
  return [
    candidate.merchantKey,
    candidate.conditionGroup ?? 'condition_unknown',
    candidate.channel,
    candidate.relationship ?? 'none',
    hasKnownComparisonMoney(candidate.delivery) ? 'delivery_known' : 'delivery_unknown',
  ].join('|');
}

/**
 * Whether `left` is at least as good as `right` on every axis and better on one.
 *
 * The BUCKET check is the first line and is inside the function rather than
 * left to the caller. `removeDominated` already groups before comparing, so it
 * is redundant there — and this function is exported, which means the next
 * caller is somebody who has not read `removeDominated`. A dominance predicate
 * whose correctness depends on where it is called from is the shape in which a
 * refurbished unit quietly disappears behind a cheaper new one.
 *
 * Inside a bucket the merchant, the condition, the channel and the standing are
 * equal by construction. What remains is FOUR axes — item price, delivery cost,
 * the quoted window and freshness — and each one is gated in the same shape:
 * `left` may not be WORSE on it. Only after all four is "better on at least
 * one" asked. An incomparable pair on any axis answers `false`, which keeps
 * both.
 *
 * The four gates are the whole of "at least as good everywhere", and the count
 * is stated because the gate that was missing is the one nobody notices: item
 * price appeared only in the better-on-one test, so a cheaper delivery bought a
 * dominance the offer had not earned.
 */
export function dominates(left: BasketCandidate, right: BasketCandidate): boolean {
  if (distinctionKeyOf(left) !== distinctionKeyOf(right)) return false;
  if (!hasKnownComparisonMoney(left.unitItemPrice)) return false;
  if (!hasKnownComparisonMoney(right.unitItemPrice)) return false;
  if (left.unitItemPrice.amount.currency !== right.unitItemPrice.amount.currency) return false;

  // ITEM PRICE, gated like every other axis. Its absence was a real defect:
  // with only the "better on at least one axis" test below, a marginally
  // cheaper DELIVERY let a dearer offer dominate — X at 100.00 + 0.10 deleted
  // Y at 50.00 + 0.11 before the solver ever saw it. Every objective read the
  // survivor, so the corruption was silent and total.
  if (left.unitItemPrice.amount.amount > right.unitItemPrice.amount.amount) return false;

  const leftDelivery = hasKnownComparisonMoney(left.delivery) ? left.delivery.amount.amount : undefined;
  const rightDelivery = hasKnownComparisonMoney(right.delivery)
    ? right.delivery.amount.amount
    : undefined;
  // Same bucket, so either both are known or neither is.
  if ((leftDelivery === undefined) !== (rightDelivery === undefined)) return false;
  if (leftDelivery !== undefined && rightDelivery !== undefined && leftDelivery > rightDelivery) {
    return false;
  }

  // An unquoted window is INCOMPARABLE, not worse: neither side may dominate.
  if ((left.deliveryMaxDays === undefined) !== (right.deliveryMaxDays === undefined)) return false;
  if (
    left.deliveryMaxDays !== undefined &&
    right.deliveryMaxDays !== undefined &&
    left.deliveryMaxDays > right.deliveryMaxDays
  ) {
    return false;
  }

  if (freshnessRank(left.freshness) > freshnessRank(right.freshness)) return false;

  const cheaper = left.unitItemPrice.amount.amount < right.unitItemPrice.amount.amount;
  const fasterOrEqual =
    left.deliveryMaxDays === undefined ||
    right.deliveryMaxDays === undefined ||
    left.deliveryMaxDays <= right.deliveryMaxDays;
  const fresher = freshnessRank(left.freshness) < freshnessRank(right.freshness);
  const cheaperDelivery =
    leftDelivery !== undefined && rightDelivery !== undefined && leftDelivery < rightDelivery;

  // "At least as good everywhere" is established above; this is "better
  // somewhere". A pair equal on every axis is NOT dominated in either
  // direction, so both survive and the tie-break decides the order.
  return (cheaper || cheaperDelivery || fresher) && fasterOrEqual;
}

/** `current` beats `ageing` beats `unknown`. Lower is better. */
function freshnessRank(freshness: ComparisonOfferFreshness): number {
  if (freshness === 'current') return 0;
  return freshness === 'ageing' ? 1 : 2;
}

/** Drop every candidate another candidate in its own bucket dominates. */
function removeDominated(candidates: readonly BasketCandidate[]): readonly BasketCandidate[] {
  const buckets = new Map<string, BasketCandidate[]>();
  for (const candidate of candidates) {
    const key = distinctionKeyOf(candidate);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const kept: BasketCandidate[] = [];
  for (const bucket of buckets.values()) {
    for (const candidate of bucket) {
      const beaten = bucket.some(
        (other) => other.offerId !== candidate.offerId && dominates(other, candidate),
      );
      if (!beaten) kept.push(candidate);
    }
  }
  return kept;
}

/**
 * The order a cap is applied in.
 *
 * Cheapest known item price first, then the stable digest — never the offer id
 * and never the input order, so which candidates survive a cap does not depend
 * on which source crawled the product first. The consequence is stated rather
 * than hidden: a cap can remove the offer that would have won by consolidating
 * merchants, which is exactly why hitting one downgrades the result to
 * `approximate` with `candidate_limit_reached`.
 */
function sortForCap(candidates: readonly BasketCandidate[]): readonly BasketCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftPrice = hasKnownComparisonMoney(left.unitItemPrice)
      ? left.unitItemPrice.amount.amount
      : Number.POSITIVE_INFINITY;
    const rightPrice = hasKnownComparisonMoney(right.unitItemPrice)
      ? right.unitItemPrice.amount.amount
      : Number.POSITIVE_INFINITY;
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    return left.tieBreak < right.tieBreak ? -1 : left.tieBreak > right.tieBreak ? 1 : 0;
  });
}

/**
 * Everything about one candidate that can make a plan's numbers move.
 *
 * The item price, the delivery cost and the free-shipping THRESHOLD, rendered
 * by `render.ts` and joined. One string, one comparison, one authority — used
 * by the snapshot when a plan is built and by the revalidation that decides
 * whether it is still true.
 *
 * The threshold is in it because it is a term of the offer even when it changes
 * nothing today: a merchant raising "free over 50" to "free over 80" moves a
 * plan's delivery from zero to charged without either published amount
 * changing, and a fingerprint that watched only the two amounts would call that
 * `unchanged`.
 *
 * An unknown component renders as the literal `unknown`, so a fact appearing or
 * disappearing is a change like any other rather than a silent match.
 */
export function renderCandidateTerms(candidate: BasketCandidate): string {
  const item = hasKnownComparisonMoney(candidate.unitItemPrice)
    ? candidate.unitItemPrice.rendered
    : 'unknown';
  const delivery = hasKnownComparisonMoney(candidate.delivery)
    ? candidate.delivery.rendered
    : 'unknown';
  const freeOver = hasKnownComparisonMoney(candidate.deliveryFreeOver)
    ? candidate.deliveryFreeOver.rendered
    : 'unknown';
  return `${item}|${delivery}|${freeOver}`;
}
