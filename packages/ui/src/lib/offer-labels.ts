/**
 * The reader-facing copy for the #74 comparison labels.
 *
 * The LABELS and their REASON CODES live in `@mercaria/shared-types` and are
 * what an impression and an operator trace carry; this file is the part that is
 * deliberately free to change, exactly as `condition.ts` is for the #90
 * taxonomy. A label's meaning is stable, its wording is not, and keeping the two
 * apart is what stops a copy change becoming a contract change.
 *
 * ## Every label is explained INDEPENDENTLY (#74 §"Labels")
 *
 * One offer may carry several — cheapest item price AND the official store AND
 * buyable on Mercaria — and the issue is explicit that the UI must explain each
 * one on its own rather than summarising them. So there is one sentence per
 * label and no combined form, and `explainOfferLabel` takes ONE award.
 *
 * ## No sentence claims more than the server established
 *
 * `cheapest_known_total` says "including delivery" because the total is only
 * awarded when the delivery cost is KNOWN — an offer whose shipping nobody
 * published cannot carry it, structurally. `fastest_known_delivery` and
 * `best_nearby_pickup` say "known" and "nearest we know of" for the same reason.
 * A sentence that dropped those qualifiers would be the surface claiming
 * something the ranking deliberately refused to.
 */

import type {
  OfferComparisonLabel,
  OfferLabelAward,
  OfferLabelReason,
} from "@mercaria/shared-types";

/** The short badge text. */
export const OFFER_LABEL_TEXT: Readonly<Record<OfferComparisonLabel, string>> = {
  best_overall: "Best overall",
  cheapest_item_price: "Cheapest item price",
  cheapest_known_total: "Cheapest known total",
  official_direct_store: "Official direct store",
  authorized_reseller: "Authorised reseller",
  fastest_known_delivery: "Fastest known delivery",
  best_nearby_pickup: "Best nearby pickup",
  cheapest_used: "Cheapest used",
  native_mercaria_checkout: "Buy on Mercaria",
};

/**
 * One sentence saying WHY this offer carries the label — the user-facing half of
 * acceptance 6, whose machine-readable half is the reason code beside it.
 *
 * Keyed on the REASON rather than on the label, because the reason code is what
 * travels in an impression and in a trace: two surfaces rendering the same
 * explanation from the same code cannot drift, and a label renamed for copy
 * reasons does not orphan the sentence.
 */
export const OFFER_LABEL_EXPLANATIONS: Readonly<Record<OfferLabelReason, string>> = {
  highest_policy_score:
    "Scores best across everything we know about these offers — price, delivery, condition, seller rating and how recently we checked.",
  lowest_item_price: "The lowest item price of the offers we can compare in this currency.",
  lowest_known_total:
    "The lowest total including delivery, among the offers whose delivery cost we know.",
  verified_official_channel: "A channel the brand has verified as its own.",
  verified_authorized_reseller: "A reseller the brand has verified as authorised.",
  shortest_known_delivery: "The shortest delivery estimate any of these sellers published.",
  nearest_collection_point: "The nearest collection point we know of.",
  lowest_item_price_used_segment: "The lowest item price among the second-hand offers.",
  buyable_on_mercaria: "You can buy this here, without leaving Mercaria.",
};

/** The badge text for one award. */
export function offerLabelText(label: OfferComparisonLabel): string {
  return OFFER_LABEL_TEXT[label];
}

/**
 * The full explanation for ONE award, with its own figure where it has one.
 *
 * The figure comes from the award rather than being recomputed, so what a
 * shopper reads is the number the server actually ranked on. A `Money` is
 * rendered by the caller through `formatMoney`, which is why this returns the
 * sentence and the raw award rather than a pre-formatted string.
 */
export function explainOfferLabel(award: OfferLabelAward): string {
  return OFFER_LABEL_EXPLANATIONS[award.reason];
}
