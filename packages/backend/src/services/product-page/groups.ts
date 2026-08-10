/**
 * How the served offers are grouped and highlighted (#71 §"Offer groups").
 *
 * PURE, and the only module in this domain that decides anything about
 * presentation. It is here rather than in a component for the reason #74 states
 * about its own weights: a rule that lives in a UI file is a rule three
 * surfaces will eventually each hold a slightly different copy of, and this one
 * decides whether a shopper sees a refurbished unit under "New".
 *
 * ## The partition, and why CONDITION is the primary axis
 *
 * Every served offer lands in exactly ONE group. #90's taxonomy is what decides
 * which — new, open box, refurbished, used, for parts — and the `new` segment is
 * then split on verified official standing, which is #71's groups 3 and 4.
 *
 * Condition wins over standing where the two disagree, and Apple's certified
 * refurbished store is the case that makes it matter: those offers belong under
 * refurbished, with their official badge still on the row. Putting them in the
 * official group would blend a refurbished unit into a list a shopper reads as
 * new, which is the one thing #90's segments exist to prevent.
 *
 * An `authorized_reseller` is deliberately NOT official: #55 keeps the brand's
 * own channel and a reseller the brand authorised as separate kinds with
 * separate badges, and collapsing them here would undo that in the one place a
 * shopper actually reads it.
 *
 * ## A highlight is a POINTER, never a copy
 *
 * #71 asks that groups "not duplicate the same offer in misleading ways". A
 * highlight therefore carries an offer ID and the #74 award that earned it — so
 * a client renders the row once, in its group, and the highlight points at it.
 * Every highlight comes from a label the ranking domain awarded; this module
 * selects nothing and compares nothing, because a "cheapest" this file computed
 * would be a second comparison outside the versioned policy.
 */

import {
  OFFER_LABEL_KIND,
  type ConditionGroup,
  type OfferLabelAward,
  type ProductPageHighlight,
  type ProductPageOfferGroup,
  type ProductPageOfferGroupKey,
} from '@mercaria/shared-types';

/**
 * The order groups are rendered in, and the whole of the vocabulary.
 *
 * Declared as a list rather than sorted at render time: "which group comes
 * first" is a product decision that must be the same on every surface, and a
 * client that ordered them itself would be free to put used copies above the
 * official store.
 */
const GROUP_ORDER: readonly ProductPageOfferGroupKey[] = [
  'official_direct',
  'new_retail',
  'open_box',
  'refurbished',
  'used',
  'for_parts',
  'condition_unknown',
];

/**
 * Which group one offer belongs to.
 *
 * A `Record` over {@link ConditionGroup} rather than a `switch` with a default:
 * a segment added to #90's taxonomy without a group here is a compile error,
 * where a default branch would quietly absorb it into whatever the author
 * happened to choose — and the direction that absorption fails in is a shopper
 * reading an unclassified item as new.
 */
const GROUP_FOR_CONDITION: Readonly<Record<ConditionGroup, ProductPageOfferGroupKey>> = {
  new: 'new_retail',
  open_box: 'open_box',
  refurbished: 'refurbished',
  used: 'used',
  for_parts: 'for_parts',
};

/** What the partition needs to know about one served offer. */
export interface GroupableOffer {
  readonly offerId: string;
  /** #90's segment. ABSENT when the source published no condition. */
  readonly conditionGroup?: ConditionGroup;
  /** Every label #74 awarded this offer. */
  readonly labels: readonly OfferLabelAward[];
}

/**
 * The group one offer belongs to — exported so the partition can be asserted
 * per offer rather than only through the assembled list.
 */
export function groupForOffer(offer: GroupableOffer): ProductPageOfferGroupKey {
  if (offer.conditionGroup === undefined) return 'condition_unknown';
  const byCondition = GROUP_FOR_CONDITION[offer.conditionGroup];
  if (byCondition !== 'new_retail') return byCondition;
  const official = offer.labels.some((award) => award.label === 'official_direct_store');
  return official ? 'official_direct' : 'new_retail';
}

/**
 * Partition the served offers, preserving the comparison's own order inside
 * each group and dropping every group that is empty.
 *
 * The input is the RANKED order and nothing is sorted here. That is the whole
 * contract: a group is a filter over an ordering #74 produced under a named
 * policy version, so two shoppers on the same policy see the same page and an
 * operator can reproduce it from a trace.
 */
export function assignOfferGroups(
  offers: readonly GroupableOffer[],
): readonly ProductPageOfferGroup[] {
  const buckets = new Map<ProductPageOfferGroupKey, string[]>();
  for (const offer of offers) {
    const key = groupForOffer(offer);
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, [offer.offerId]);
    else existing.push(offer.offerId);
  }

  const groups: ProductPageOfferGroup[] = [];
  for (const key of GROUP_ORDER) {
    const offerIds = buckets.get(key);
    if (offerIds === undefined || offerIds.length === 0) continue;
    groups.push({ key, offerIds });
  }
  return groups;
}

/**
 * The highlights, taken from the COMPARISON labels the ranking awarded.
 *
 * `OFFER_LABEL_KIND` is what tells a comparison label from a standing one, and
 * it is read rather than pattern-matched: a highlight derived from a label's
 * spelling would silently include a future `best_seller_rating` and silently
 * drop a renamed `cheapest_item_price`.
 *
 * Standing labels — official channel, authorised reseller, buyable on Mercaria
 * — are BADGES on their rows and deliberately produce no highlight: they are
 * facts about one offer rather than a comparison against the others, and
 * "official direct store" repeated as a highlight for each of a brand's four
 * channels is a list of highlights nobody can read.
 */
export function collectHighlights(
  offers: readonly GroupableOffer[],
): readonly ProductPageHighlight[] {
  const highlights: ProductPageHighlight[] = [];
  for (const offer of offers) {
    for (const award of offer.labels) {
      if (OFFER_LABEL_KIND[award.label] !== 'comparison') continue;
      highlights.push({ offerId: offer.offerId, award });
    }
  }
  return highlights;
}
