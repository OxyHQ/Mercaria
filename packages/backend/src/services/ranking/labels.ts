/**
 * The comparison labels (#74 §"Labels", acceptance 2, 5 and 6).
 *
 * PURE, and awarded independently of one another: an offer may carry several,
 * each with its own reason code and its own basis, and none of them is a summary
 * of the others. "Official direct store and cheapest offer can be different and
 * both visible" (acceptance 5) is therefore not a case anybody has to handle —
 * it is what independent awards do.
 *
 * ## `cheapest_known_total` is UNREACHABLE for an unknown shipping cost
 *
 * Not guarded — unreachable. {@link selectCheapestKnownTotal} takes a
 * {@link KnownTotalEntry}, whose `total` is a required `Money`, and the only way
 * to build one is to narrow an `OfferComparisonTotal` through `hasKnownTotal`.
 * An offer whose delivery cost the source did not publish produces the union's
 * `known: false` branch, which has no `amount` property at all — so there is
 * nothing to construct the entry FROM. That is acceptance 2 held by the
 * compiler, and it is why this selection is a separate function with a narrow
 * parameter type rather than a filter inside one big loop.
 *
 * ## A "cheapest" label is awarded to exactly ONE offer, deterministically
 *
 * Two offers at the same price is an ordinary state, and labelling both would
 * put "cheapest" twice in one list, which reads as a bug. The entries arrive in
 * RANKED order — already tie-broken by the policy's documented chain — so taking
 * the first of the tied set is deterministic for one policy version and needs no
 * second tie-break rule to disagree with the first.
 *
 * A STANDING label (`official_direct_store`, `authorized_reseller`,
 * `native_mercaria_checkout`) is awarded to every offer that has it, because it
 * states a fact about that offer rather than a comparison against the others.
 */

import {
  OFFER_LABEL_REASON,
  hasKnownPrice,
  hasKnownTotal,
  isUsedConditionGroup,
  type EligibleOffer,
  type Money,
  type OfferLabelAward,
} from '@mercaria/shared-types';

/** One candidate with the score the policy gave it, in ranked order. */
export interface LabelCandidate {
  readonly candidate: EligibleOffer;
  readonly score: number;
}

/**
 * An offer whose FULL cost is known.
 *
 * The type that makes `cheapest_known_total` impossible to award wrongly: it
 * carries a non-optional `Money`, and the unknown branch of
 * `OfferComparisonTotal` has no amount to supply one.
 */
interface KnownTotalEntry {
  readonly offerId: string;
  readonly total: Money;
}

/**
 * The cheapest of a set whose totals are all KNOWN.
 *
 * Its parameter type is the whole point — see the module docblock. It takes no
 * offers, no facts and no union: there is no unknown-shipping value it could be
 * handed, so no branch inside it decides anything about one.
 */
function selectCheapestKnownTotal(
  entries: readonly KnownTotalEntry[],
): KnownTotalEntry | undefined {
  let best: KnownTotalEntry | undefined;
  for (const entry of entries) {
    if (best === undefined || entry.total.amount < best.total.amount) best = entry;
  }
  return best;
}

/** The first entry minimising `value`, or `undefined` when nothing has one. */
function selectMinimum<T>(
  entries: readonly T[],
  value: (entry: T) => number | undefined,
): T | undefined {
  let best: T | undefined;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const candidate = value(entry);
    if (candidate === undefined) continue;
    if (candidate < bestValue) {
      best = entry;
      bestValue = candidate;
    }
  }
  return best;
}

function award(map: Map<string, OfferLabelAward[]>, offerId: string, entry: OfferLabelAward): void {
  const existing = map.get(offerId);
  if (existing === undefined) map.set(offerId, [entry]);
  else existing.push(entry);
}

/**
 * Award every label over one ranked comparison.
 *
 * Returns a map rather than mutating the ranked entries, so the ranker composes
 * the two rather than one reaching into the other — and so this function stays
 * callable on its own from a test with nine hand-built candidates.
 */
export function awardComparisonLabels(
  entries: readonly LabelCandidate[],
): ReadonlyMap<string, readonly OfferLabelAward[]> {
  const awards = new Map<string, OfferLabelAward[]>();
  if (entries.length === 0) return awards;

  // `best_overall` — the top of the ranked list, but only when the policy
  // actually scored it. A comparison in which nothing at all is known scores
  // every offer zero, and calling one of them "best overall" would present a
  // digest tie-break as a judgement.
  const leader = entries[0];
  if (leader !== undefined && leader.score > 0) {
    award(awards, leader.candidate.offerId, {
      label: 'best_overall',
      reason: OFFER_LABEL_REASON.best_overall,
      score: leader.score,
    });
  }

  // `cheapest_item_price` — over the offers whose price this comparison could
  // express in its own currency. An unconvertible price is not a cheap one.
  const cheapestItem = selectMinimum(entries, (entry) =>
    hasKnownPrice(entry.candidate.facts.itemPrice)
      ? entry.candidate.facts.itemPrice.amount.amount
      : undefined,
  );
  if (cheapestItem !== undefined && hasKnownPrice(cheapestItem.candidate.facts.itemPrice)) {
    award(awards, cheapestItem.candidate.offerId, {
      label: 'cheapest_item_price',
      reason: OFFER_LABEL_REASON.cheapest_item_price,
      amount: cheapestItem.candidate.facts.itemPrice.amount,
    });
  }

  // `cheapest_known_total` — see the docblock. The filter below is the ONLY
  // place an offer becomes eligible for it, and it is a narrowing rather than a
  // condition.
  const knownTotals: KnownTotalEntry[] = [];
  for (const entry of entries) {
    const total = entry.candidate.facts.total;
    if (!hasKnownTotal(total)) continue;
    knownTotals.push({ offerId: entry.candidate.offerId, total: total.amount });
  }
  const cheapestTotal = selectCheapestKnownTotal(knownTotals);
  if (cheapestTotal !== undefined) {
    award(awards, cheapestTotal.offerId, {
      label: 'cheapest_known_total',
      reason: OFFER_LABEL_REASON.cheapest_known_total,
      amount: cheapestTotal.total,
    });
  }

  // The STANDING labels — facts about one offer, awarded to every offer holding
  // them. A brand may have several official channels, and #55 lists them
  // separately for exactly that reason.
  for (const entry of entries) {
    const facts = entry.candidate.facts;
    if (facts.relationship === 'official_channel') {
      award(awards, entry.candidate.offerId, {
        label: 'official_direct_store',
        reason: OFFER_LABEL_REASON.official_direct_store,
      });
    }
    if (facts.relationship === 'authorized_reseller') {
      award(awards, entry.candidate.offerId, {
        label: 'authorized_reseller',
        reason: OFFER_LABEL_REASON.authorized_reseller,
      });
    }
    if (facts.nativeCheckoutEligible) {
      award(awards, entry.candidate.offerId, {
        label: 'native_mercaria_checkout',
        reason: OFFER_LABEL_REASON.native_mercaria_checkout,
      });
    }
  }

  // `fastest_known_delivery` — over quoted windows only. An unquoted delivery is
  // not a fast one, which is the same rule the total obeys.
  const fastest = selectMinimum(entries, (entry) => entry.candidate.facts.deliveryMaxDays);
  const fastestDays = fastest?.candidate.facts.deliveryMaxDays;
  if (fastest !== undefined && fastestDays !== undefined) {
    award(awards, fastest.candidate.offerId, {
      label: 'fastest_known_delivery',
      reason: OFFER_LABEL_REASON.fastest_known_delivery,
      days: fastestDays,
    });
  }

  // `best_nearby_pickup` — never awarded today, because no collection point is
  // published (`seams.ts`). It is written out rather than omitted so #93 needs
  // to fill one function body and nothing here.
  const nearest = selectMinimum(entries, (entry) => entry.candidate.facts.pickupDistanceMetres);
  const nearestMetres = nearest?.candidate.facts.pickupDistanceMetres;
  if (nearest !== undefined && nearestMetres !== undefined) {
    award(awards, nearest.candidate.offerId, {
      label: 'best_nearby_pickup',
      reason: OFFER_LABEL_REASON.best_nearby_pickup,
      metres: nearestMetres,
    });
  }

  // `cheapest_new` — within the NEW segment only, and the exact twin of
  // `cheapest_used` below. #71's product page needs a "cheapest new" beside its
  // "best overall"; deriving one on the page would be a second comparison
  // outside this policy version, so it is awarded here, from the same ranked
  // order, under the same tie-break. An offer whose condition the source did
  // not publish is NOT in the segment — `conditionGroup` is undefined for it,
  // and reading that as `new` is the coercion `deriveOfferCondition` refuses.
  const cheapestNew = selectMinimum(entries, (entry) => {
    const facts = entry.candidate.facts;
    if (facts.conditionGroup !== 'new') return undefined;
    return hasKnownPrice(facts.itemPrice) ? facts.itemPrice.amount.amount : undefined;
  });
  if (cheapestNew !== undefined && hasKnownPrice(cheapestNew.candidate.facts.itemPrice)) {
    award(awards, cheapestNew.candidate.offerId, {
      label: 'cheapest_new',
      reason: OFFER_LABEL_REASON.cheapest_new,
      amount: cheapestNew.candidate.facts.itemPrice.amount,
    });
  }

  // `cheapest_used` — within the USED segment only. `open_box` and
  // `refurbished` are deliberately outside it (`isUsedConditionGroup`): a
  // refurbished unit with a manufacturer warranty is a different proposition,
  // and labelling it "cheapest used" would answer a question nobody asked.
  const cheapestUsed = selectMinimum(entries, (entry) => {
    const facts = entry.candidate.facts;
    if (facts.conditionGroup === undefined || !isUsedConditionGroup(facts.conditionGroup)) {
      return undefined;
    }
    return hasKnownPrice(facts.itemPrice) ? facts.itemPrice.amount.amount : undefined;
  });
  if (cheapestUsed !== undefined && hasKnownPrice(cheapestUsed.candidate.facts.itemPrice)) {
    award(awards, cheapestUsed.candidate.offerId, {
      label: 'cheapest_used',
      reason: OFFER_LABEL_REASON.cheapest_used,
      amount: cheapestUsed.candidate.facts.itemPrice.amount,
    });
  }

  return awards;
}
