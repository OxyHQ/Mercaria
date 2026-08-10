/**
 * `OfferRankingService` (#74 §"Ranking inputs", §"Labels", policy rules 2 and 7)
 * — scoring the set eligibility already admitted, and explaining every position.
 *
 * PURE: no database, no clock, no configuration, no FX call. Everything it reads
 * is on the candidates or on the policy, which is what makes the scenario
 * fixtures the issue asks for a table of inputs rather than a seeded catalogue —
 * and what makes "the same eligible input produces the same order for one policy
 * version" (acceptance 1) checkable by running it twice.
 *
 * ## It cannot reach an eligibility fact, and eligibility cannot reach a weight
 *
 * `EligibleOffer.facts` is the whole of what a scorer sees. There is no listing
 * status on it, no moderation state, no freshness level and no suppression set —
 * so no weight, however set, can make an ineligible offer appear. The one thing
 * it does check about admission is that every rule was EVALUATED, and it throws
 * when one was not: a rule added to `OFFER_ELIGIBILITY_RULES` and not wired into
 * the derivation fails the first comparison loudly instead of quietly widening
 * what may be shown.
 *
 * ## Unknown is left out of the DENOMINATOR (#58's rule, one domain over)
 *
 * A signal nobody published contributes to neither half of the weighted mean. It
 * is worth stating why a PENALTY would be wrong rather than merely harsh: a
 * penalty asserts something about the offer, and the only thing actually known
 * is a gap in Mercaria's information. Reading it as a zero would be worse still
 * — an unknown shipping cost read as free is exactly the failure this issue
 * names, and the type system refuses it here, because the `unknown` branch of a
 * `RankingSignalOutcome` carries no `normalized` and no `weight` to sum.
 *
 * ## The tie-break is a digest, never an id
 *
 * `generatedId()` is a uuid v7 and its leading bits are a timestamp, so ordering
 * ties by id is ordering by INGESTION TIME — which policy rule 7 forbids by
 * name, and which would hand a permanent advantage to whichever source crawled a
 * product first. The digest is deterministic for one policy version, stable
 * across re-reads and uncorrelated with when a row was written.
 */

import { createHash } from 'node:crypto';
import {
  ITEM_CONDITION_KEYS,
  OFFER_ELIGIBILITY_RULES,
  OFFER_RANKING_SIGNALS,
  hasKnownPrice,
  hasKnownTotal,
  normalizeHigherIsBetter,
  normalizeLowerIsBetter,
  weightedSignalScore,
  type EligibleOffer,
  type OfferComparisonIntent,
  type OfferRankingFacts,
  type OfferRankingSignal,
  type OfferTieBreaker,
  type RankedOffer,
  type RankingPolicy,
  type RankingSignalOutcome,
  type RankingUnknownReason,
} from '@mercaria/shared-types';
import { awardComparisonLabels } from './labels.js';

/** What the ranker is handed for one comparison. */
export interface OfferRankingInput {
  readonly candidates: readonly EligibleOffer[];
  readonly policy: RankingPolicy;
  readonly intent: OfferComparisonIntent;
  /**
   * Whether the shopper shared a location at all.
   *
   * A REQUEST-level fact rather than a per-offer one, so the pickup signal can
   * tell "you have not shared a location" from "we have no collection point for
   * this offer" — two different reason codes leading to two different next
   * actions, and one of them is something the shopper can fix.
   */
  readonly viewerLocationProvided: boolean;
}

/** The min/max present in this comparison set, per signal that needs a range. */
interface SignalRanges {
  readonly itemPrice: { min: number; max: number } | null;
  readonly deliveryCost: { min: number; max: number } | null;
  readonly deliveryDays: { min: number; max: number } | null;
  readonly returnWindow: { min: number; max: number } | null;
  readonly pickupMetres: { min: number; max: number } | null;
  /** Only ratings at or above the policy's confidence floor enter this range. */
  readonly merchantRating: { min: number; max: number } | null;
}

function rangeOf(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

function computeRanges(candidates: readonly EligibleOffer[], policy: RankingPolicy): SignalRanges {
  const itemPrices: number[] = [];
  const deliveryCosts: number[] = [];
  const deliveryDays: number[] = [];
  const returnWindows: number[] = [];
  const pickupMetres: number[] = [];
  const merchantRatings: number[] = [];

  for (const candidate of candidates) {
    const facts = candidate.facts;
    if (hasKnownPrice(facts.itemPrice)) itemPrices.push(facts.itemPrice.amount.amount);
    if (hasKnownPrice(facts.deliveryCost)) deliveryCosts.push(facts.deliveryCost.amount.amount);
    if (facts.deliveryMaxDays !== undefined) deliveryDays.push(facts.deliveryMaxDays);
    if (facts.returnWindowDays !== undefined) returnWindows.push(facts.returnWindowDays);
    if (facts.pickupDistanceMetres !== undefined) pickupMetres.push(facts.pickupDistanceMetres);
    if (
      facts.merchantRating !== undefined &&
      (facts.merchantReviewCount ?? 0) >= policy.minReviewCount
    ) {
      merchantRatings.push(facts.merchantRating);
    }
  }

  return {
    itemPrice: rangeOf(itemPrices),
    deliveryCost: rangeOf(deliveryCosts),
    deliveryDays: rangeOf(deliveryDays),
    returnWindow: rangeOf(returnWindows),
    pickupMetres: rangeOf(pickupMetres),
    merchantRating: rangeOf(merchantRatings),
  };
}

/**
 * How good a condition is, 0–1, from its position in the taxonomy tuple.
 *
 * Derived from `ITEM_CONDITION_KEYS`' order rather than from
 * `compareConditionQuality`, whose own doc comment says it deliberately returns
 * an ORDERING and not a score "so nothing can multiply it by a fee, a bid or a
 * margin". That instruction is respected: what is multiplied here is a policy
 * weight, and the only way to get one is a column that exists — there is no fee,
 * bid or margin column anywhere in this domain to reach for.
 */
function conditionQualityScore(key: string): number | null {
  const index = ITEM_CONDITION_KEYS.indexOf(key as (typeof ITEM_CONDITION_KEYS)[number]);
  if (index < 0 || ITEM_CONDITION_KEYS.length < 2) return null;
  return 1 - index / (ITEM_CONDITION_KEYS.length - 1);
}

/** A scored outcome, with the policy's weight echoed so an explanation stands alone. */
function scored(
  signal: OfferRankingSignal,
  normalized: number,
  policy: RankingPolicy,
  detail: string,
): RankingSignalOutcome {
  return { signal, state: 'scored', normalized, weight: policy.weights[signal], detail };
}

function unknown(
  signal: OfferRankingSignal,
  reason: RankingUnknownReason,
  detail: string,
): RankingSignalOutcome {
  return { signal, state: 'unknown', reason, detail };
}

/**
 * Every signal's outcome for one candidate, in the tuple's own order.
 *
 * The order is `OFFER_RANKING_SIGNALS`' so an explanation reads the same way
 * every time, and the completeness is asserted below: a signal added to the
 * tuple and not produced here would silently drop out of every explanation while
 * still carrying a weight nothing applied.
 */
function deriveSignals(
  facts: OfferRankingFacts,
  policy: RankingPolicy,
  ranges: SignalRanges,
  viewerLocationProvided: boolean,
): readonly RankingSignalOutcome[] {
  const outcomes: RankingSignalOutcome[] = [];

  // 1 — item price, in the comparison currency. An unconvertible price says so.
  if (hasKnownPrice(facts.itemPrice) && ranges.itemPrice !== null) {
    outcomes.push(
      scored(
        'item_price',
        normalizeLowerIsBetter(facts.itemPrice.amount.amount, ranges.itemPrice.min, ranges.itemPrice.max),
        policy,
        `${facts.itemPrice.amount.amount} ${facts.itemPrice.amount.currency}`,
      ),
    );
  } else {
    outcomes.push(
      unknown(
        'item_price',
        hasKnownPrice(facts.itemPrice) ? 'no_comparable_basis' : facts.itemPrice.reason,
        'no comparable item price in this comparison currency',
      ),
    );
  }

  // 2 — delivery. An unknown delivery cost is NOT free, and the label writer
  // cannot be handed this offer's total at all.
  if (hasKnownPrice(facts.deliveryCost) && ranges.deliveryCost !== null) {
    outcomes.push(
      scored(
        'delivery_cost',
        normalizeLowerIsBetter(
          facts.deliveryCost.amount.amount,
          ranges.deliveryCost.min,
          ranges.deliveryCost.max,
        ),
        policy,
        `${facts.deliveryCost.amount.amount} ${facts.deliveryCost.amount.currency}`,
      ),
    );
  } else {
    outcomes.push(
      unknown(
        'delivery_cost',
        hasKnownPrice(facts.deliveryCost) ? 'no_comparable_basis' : facts.deliveryCost.reason,
        'the source published no delivery cost — which is not the same as free',
      ),
    );
  }

  // 3 — tax inclusion. An inclusive price is the amount a buyer pays and an
  // exclusive one is not, which is the same completeness argument the total
  // rests on. Always unknown today; see `seams.ts`.
  if (facts.taxInclusion === 'unknown') {
    outcomes.push(unknown('tax_inclusion', 'no_provider', 'no source publishes tax inclusion'));
  } else {
    outcomes.push(
      scored(
        'tax_inclusion',
        facts.taxInclusion === 'inclusive' ? 1 : 0,
        policy,
        `price is tax ${facts.taxInclusion}`,
      ),
    );
  }

  // 4 — delivery speed, from the SLOWEST end of the quoted window. Ranking on
  // the optimistic end would reward a seller for a wide quote.
  if (facts.deliveryMaxDays !== undefined && ranges.deliveryDays !== null) {
    outcomes.push(
      scored(
        'delivery_speed',
        normalizeLowerIsBetter(facts.deliveryMaxDays, ranges.deliveryDays.min, ranges.deliveryDays.max),
        policy,
        `up to ${facts.deliveryMaxDays} days`,
      ),
    );
  } else {
    outcomes.push(unknown('delivery_speed', 'not_published', 'no delivery estimate published'));
  }

  // 5 — condition.
  const conditionScore = facts.condition === undefined ? null : conditionQualityScore(facts.condition);
  if (conditionScore === null) {
    outcomes.push(unknown('condition', 'not_published', 'condition did not map onto the taxonomy'));
  } else {
    outcomes.push(scored('condition', conditionScore, policy, `condition ${facts.condition}`));
  }

  // 6 — merchant rating, and the CONFIDENCE half of it. A single five-star
  // review is not evidence, and scoring it as one would put a brand-new merchant
  // above an established one on a sample of one.
  if (facts.merchantRating === undefined) {
    outcomes.push(unknown('merchant_rating', 'not_published', 'no verified review aggregate'));
  } else if ((facts.merchantReviewCount ?? 0) < policy.minReviewCount) {
    outcomes.push(
      unknown(
        'merchant_rating',
        'below_confidence_floor',
        `${facts.merchantReviewCount ?? 0} verified reviews, floor ${policy.minReviewCount}`,
      ),
    );
  } else if (ranges.merchantRating !== null) {
    /**
     * Normalized against the ratings PRESENT IN THIS COMPARISON, like every
     * other set-relative signal — and NOT against the 0–5 scale.
     *
     * The absolute form was written first and a scenario test caught what it
     * does: real ratings live in roughly [3.5, 5], so `4.5 / 5 = 0.9` is a LOW
     * normalized value, and since an unknown signal is left out of the
     * denominator (which imputes the offer's own mean, typically near 1.0), a
     * merchant with a genuine 4.5 scored BELOW a merchant with no rating at all.
     * That is a comparison surface rewarding the absence of a fact, which is the
     * "unknown silently wins" failure this issue is about, in its subtlest form.
     *
     * Set-relative removes it and costs the thing every set-relative signal
     * costs: with two merchants at 4.4 and 4.5 the first normalizes to 0. That
     * is the same property `item_price` already has for a one-cent difference,
     * it is bounded by the signal's WEIGHT, and a flat set answers 1 for
     * everybody rather than 0 (see `normalizeHigherIsBetter`).
     */
    outcomes.push(
      scored(
        'merchant_rating',
        normalizeHigherIsBetter(
          facts.merchantRating,
          ranges.merchantRating.min,
          ranges.merchantRating.max,
        ),
        policy,
        `${facts.merchantRating.toFixed(2)} over ${facts.merchantReviewCount ?? 0} verified reviews`,
      ),
    );
  } else {
    outcomes.push(
      unknown('merchant_rating', 'no_comparable_basis', 'no rating cleared the confidence floor'),
    );
  }

  // 7 — return policy, normalized against the windows present in this set.
  if (facts.returnWindowDays !== undefined && ranges.returnWindow !== null) {
    outcomes.push(
      scored(
        'return_policy',
        normalizeHigherIsBetter(
          facts.returnWindowDays,
          ranges.returnWindow.min,
          ranges.returnWindow.max,
        ),
        policy,
        `${facts.returnWindowDays}-day return window`,
      ),
    );
  } else {
    outcomes.push(unknown('return_policy', 'not_published', 'no normalized return-policy facts'));
  }

  // 8 — availability confidence. `unknown` is the commonest published value in
  // an external catalogue and it scores nothing rather than being read either
  // way (#57's `OfferAvailability` docblock).
  if (facts.availability === 'unknown') {
    outcomes.push(unknown('availability_confidence', 'not_published', 'no availability published'));
  } else {
    outcomes.push(
      scored(
        'availability_confidence',
        facts.availability === 'in_stock' ? 1 : facts.availability === 'preorder' ? 0.5 : 0,
        policy,
        `availability ${facts.availability}`,
      ),
    );
  }

  // 9 — freshness, as a share of the offer's OWN lifetime elapsed (#68). A
  // native offer has no bounded deadline, so it scores nothing here rather than
  // being measured on the convergence dispatcher's clock — which would be a
  // hidden native preference in either direction.
  if (facts.freshnessElapsedFraction === undefined) {
    outcomes.push(
      unknown('observation_freshness', 'no_comparable_basis', 'no bounded source deadline'),
    );
  } else {
    outcomes.push(
      scored(
        'observation_freshness',
        Math.min(Math.max(1 - facts.freshnessElapsedFraction, 0), 1),
        policy,
        `${Math.round(facts.freshnessElapsedFraction * 100)}% through its source lifetime`,
      ),
    );
  }

  // 10 — a VERIFIED relationship (#55). `none` is a real fact scoring zero, not
  // an unknown: most merchants hold no relationship row and that is the normal
  // state. Absent means the question could not be asked at all — the comparison
  // subject resolves to no brand — and that IS unknown.
  if (facts.relationship === undefined) {
    outcomes.push(
      unknown('verified_relationship', 'no_comparable_basis', 'the subject resolves to no brand'),
    );
  } else {
    outcomes.push(
      scored(
        'verified_relationship',
        facts.relationship === 'official_channel' ? 1 : facts.relationship === 'authorized_reseller' ? 0.7 : 0,
        policy,
        `verified relationship: ${facts.relationship}`,
      ),
    );
  }

  // 11 — pickup proximity, only when the viewer enabled location AND a
  // collection point exists. Both refusals are named separately because only one
  // of them is something the shopper can do anything about.
  if (facts.pickupDistanceMetres !== undefined && ranges.pickupMetres !== null) {
    outcomes.push(
      scored(
        'pickup_proximity',
        normalizeLowerIsBetter(
          facts.pickupDistanceMetres,
          ranges.pickupMetres.min,
          ranges.pickupMetres.max,
        ),
        policy,
        `${facts.pickupDistanceMetres} m to the nearest collection point`,
      ),
    );
  } else {
    outcomes.push(
      unknown(
        'pickup_proximity',
        viewerLocationProvided ? 'no_provider' : 'viewer_location_absent',
        viewerLocationProvided
          ? 'no collection point is published for this offer'
          : 'no viewer location was provided',
      ),
    );
  }

  return outcomes;
}

/** The stable last-resort tie-break. See the module docblock for why not an id. */
export function tieBreakDigest(policyVersion: string, offerId: string): string {
  return createHash('sha256').update(`${policyVersion}:${offerId}`).digest('hex');
}

/** One candidate, scored, before ordering. */
interface ScoredCandidate {
  readonly candidate: EligibleOffer;
  readonly signals: readonly RankingSignalOutcome[];
  readonly score: number;
  readonly digest: string;
}

/**
 * The intent's primary key, LOWER is better, with unknowns pushed past every
 * known value.
 *
 * `Number.POSITIVE_INFINITY` for an unknown is the whole of "an unknown never
 * wins under an intent that reads it": a shopper who asked for the cheapest is
 * never handed an offer whose price nobody knows, and one who asked for the
 * fastest is never handed an unquoted delivery.
 *
 * `cheapest` is THREE tiers rather than one, and that is the honest reading: an
 * offer with a known TOTAL is comparable on total, an offer with only a known
 * item price is comparable on that, and neither may be claimed cheaper than the
 * other. Collapsing them would either bury a genuinely cheap offer whose seller
 * did not publish postage, or let it outrank an offer whose full price is known
 * and lower.
 */
function intentKey(entry: ScoredCandidate, intent: OfferComparisonIntent): readonly number[] {
  const facts = entry.candidate.facts;
  const infinity = Number.POSITIVE_INFINITY;

  switch (intent) {
    case 'balanced':
      return [0];
    case 'cheapest':
      if (hasKnownTotal(facts.total)) return [0, facts.total.amount.amount];
      if (hasKnownPrice(facts.itemPrice)) return [1, facts.itemPrice.amount.amount];
      return [2, infinity];
    case 'fastest':
      return facts.deliveryMaxDays === undefined ? [1, infinity] : [0, facts.deliveryMaxDays];
    case 'official':
      return [
        facts.relationship === 'official_channel'
          ? 0
          : facts.relationship === 'authorized_reseller'
            ? 1
            : 2,
      ];
    case 'used':
      return [
        facts.conditionGroup === 'used' ? 0 : 1,
        hasKnownPrice(facts.itemPrice) ? facts.itemPrice.amount.amount : infinity,
      ];
  }
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Which comparison decided one offer's place against the one above it.
 *
 * Reported per offer so an explanation can say "these two scored identically and
 * were ordered by total, then by a stable digest" instead of leaving a shopper
 * to guess. `undefined` means the score alone decided it.
 */
function tieBreakerBetween(above: ScoredCandidate, below: ScoredCandidate): OfferTieBreaker | undefined {
  if (above.score !== below.score) return undefined;
  const aTotal = hasKnownTotal(above.candidate.facts.total)
    ? above.candidate.facts.total.amount.amount
    : null;
  const bTotal = hasKnownTotal(below.candidate.facts.total)
    ? below.candidate.facts.total.amount.amount
    : null;
  if (aTotal !== null && bTotal !== null && aTotal !== bTotal) return 'known_total';

  const aPrice = hasKnownPrice(above.candidate.facts.itemPrice)
    ? above.candidate.facts.itemPrice.amount.amount
    : null;
  const bPrice = hasKnownPrice(below.candidate.facts.itemPrice)
    ? below.candidate.facts.itemPrice.amount.amount
    : null;
  if (aPrice !== null && bPrice !== null && aPrice !== bPrice) return 'item_price';

  return 'stable_digest';
}

/**
 * Refuse a candidate whose admission did not evaluate every rule.
 *
 * A RUNTIME assertion, stated as one rather than dressed up as a proof:
 * TypeScript is structural, so nothing stops a caller hand-writing an
 * `EligibleOffer`. What it does buy is the case that actually happens — a rule
 * added to `OFFER_ELIGIBILITY_RULES` and not wired into the derivation — and it
 * buys it loudly, on the first comparison, instead of by quietly admitting
 * whatever the new rule was meant to exclude.
 */
function assertFullyAdmitted(candidates: readonly EligibleOffer[]): void {
  for (const candidate of candidates) {
    const evaluated = new Set(candidate.admission.rulesEvaluated);
    const missing = OFFER_ELIGIBILITY_RULES.filter((rule) => !evaluated.has(rule));
    if (missing.length > 0) {
      throw new Error(
        `Offer ${candidate.offerId} reached ranking without every eligibility rule evaluated: ` +
          `${missing.join(', ')}. Ranking may only score what eligibility admitted.`,
      );
    }
  }
}

/**
 * Rank the eligible set and award its labels.
 *
 * Ordering is: the intent's primary key, then the policy score, then the
 * documented tie-breakers. The comparator is TOTAL — the digest never ties, so
 * `Array.prototype.sort`'s stability cannot leak the input order into the
 * result, which is policy rule 7 ("stable tie-breaking independent of ingestion
 * order") held by construction rather than by hoping the caller shuffled
 * nothing.
 */
export function rankOffers(input: OfferRankingInput): readonly RankedOffer[] {
  assertFullyAdmitted(input.candidates);

  const ranges = computeRanges(input.candidates, input.policy);
  const scoredCandidates: ScoredCandidate[] = input.candidates.map((candidate) => {
    const signals = deriveSignals(
      candidate.facts,
      input.policy,
      ranges,
      input.viewerLocationProvided,
    );
    return {
      candidate,
      signals,
      score: weightedSignalScore(signals),
      digest: tieBreakDigest(input.policy.version, candidate.offerId),
    };
  });

  const ordered = [...scoredCandidates].sort((a, b) => {
    const byIntent = compareKeys(intentKey(a, input.intent), intentKey(b, input.intent));
    if (byIntent !== 0) return byIntent;
    if (a.score !== b.score) return a.score > b.score ? -1 : 1;

    const aTotal = hasKnownTotal(a.candidate.facts.total) ? a.candidate.facts.total.amount.amount : null;
    const bTotal = hasKnownTotal(b.candidate.facts.total) ? b.candidate.facts.total.amount.amount : null;
    if (aTotal !== null && bTotal !== null && aTotal !== bTotal) return aTotal - bTotal;

    const aPrice = hasKnownPrice(a.candidate.facts.itemPrice)
      ? a.candidate.facts.itemPrice.amount.amount
      : null;
    const bPrice = hasKnownPrice(b.candidate.facts.itemPrice)
      ? b.candidate.facts.itemPrice.amount.amount
      : null;
    if (aPrice !== null && bPrice !== null && aPrice !== bPrice) return aPrice - bPrice;

    return a.digest < b.digest ? -1 : 1;
  });

  const labels = awardComparisonLabels(
    ordered.map((entry) => ({ candidate: entry.candidate, score: entry.score })),
  );

  return ordered.map((entry, index) => {
    const previous = ordered[index - 1];
    const tieBreaker = previous === undefined ? undefined : tieBreakerBetween(previous, entry);
    return {
      offerId: entry.candidate.offerId,
      rank: index + 1,
      score: entry.score,
      signals: entry.signals,
      labels: labels.get(entry.candidate.offerId) ?? [],
      cost: {
        itemPrice: entry.candidate.facts.itemPrice,
        deliveryCost: entry.candidate.facts.deliveryCost,
        total: entry.candidate.facts.total,
        taxInclusion: entry.candidate.facts.taxInclusion,
      },
      ...(tieBreaker === undefined ? {} : { tieBreakerApplied: tieBreaker }),
    };
  });
}

/**
 * The signals a scorer produces, exported so a gate can assert the derivation
 * covers the whole tuple.
 *
 * Without it a signal added to `OFFER_RANKING_SIGNALS` and forgotten in
 * `deriveSignals` would carry a weight nothing ever applied, and every
 * explanation would silently be one line shorter — which reads exactly like a
 * signal that was legitimately unknown.
 */
export const RANKED_SIGNAL_COUNT = OFFER_RANKING_SIGNALS.length;
