/**
 * The COPY for #96's comparison and basket vocabularies.
 *
 * Keyed on the REASON and STATE codes rather than on a rendered sentence, the
 * `offer-labels.ts` decision one issue over: two surfaces rendering the same
 * refusal cannot drift, and a copy change is not a contract change.
 *
 * Every `Record` is exhaustive over its union, so a code added to
 * `@mercaria/shared-types` without copy here is a `tsc` error rather than a
 * blank chip a shopper cannot act on.
 */

import type {
  BasketApproximationReason,
  BasketReasonCode,
  BasketResultKind,
  ComparisonNotApplicableReason,
  ComparisonUnavailableReason,
  ComparisonUnknownReason,
  ExplanationRejectionReason,
} from "@mercaria/shared-types";

/** The named alternatives, as a shopper reads them. */
const RESULT_KIND_TEXT: Readonly<Record<BasketResultKind, string>> = {
  cheapest_known_item_prices: "Cheapest known item prices",
  cheapest_known_total: "Cheapest known total",
  fewest_merchants: "Fewest merchants",
  best_native_plan: "Best Mercaria plan",
  official_channel_plan: "Official channel plan",
  best_nearby_pickup: "Nearby pickup",
  used_or_refurbished_value: "Used or refurbished value",
  partial_coverage: "Partial plan",
};

export function basketResultText(kind: BasketResultKind): string {
  return RESULT_KIND_TEXT[kind];
}

/**
 * What a result kind actually compared.
 *
 * Shipped beside the name because "cheapest" and "cheapest known item prices"
 * mean different things and only the second one is true — #77's rule that a
 * number whose definition is unstated cannot be served, applied to a plan.
 */
const RESULT_KIND_DEFINITION: Readonly<Record<BasketResultKind, string>> = {
  cheapest_known_item_prices:
    "Compares item prices only. Delivery and tax are not included in this figure.",
  cheapest_known_total:
    "Compares the full delivered total. Produced only when every item price, every merchant's delivery and the tax treatment are known.",
  fewest_merchants: "The plan that spreads your basket across the fewest separate checkouts.",
  best_native_plan: "The items you can buy directly on Mercaria, in one cart.",
  official_channel_plan: "Every item from a brand's verified official channel.",
  best_nearby_pickup: "Collection points are not published yet, so this cannot be planned.",
  used_or_refurbished_value: "Every item second-hand or refurbished.",
  partial_coverage: "Some items could not be planned. The rest are shown with the reasons.",
};

export function basketResultDefinition(kind: BasketResultKind): string {
  return RESULT_KIND_DEFINITION[kind];
}

/** Why an item or a plan is what it is. */
const REASON_TEXT: Readonly<Record<BasketReasonCode, string>> = {
  no_eligible_offer: "Nobody is offering this right now",
  no_offer_in_requested_condition: "No offer in the condition you asked for",
  no_offer_from_requested_merchant: "No offer from the merchant you asked for",
  every_offer_from_excluded_merchant: "Every offer is from a merchant you excluded",
  no_offer_in_channel_policy: "No offer matches the channel you chose",
  no_convertible_price: "Priced in a currency we cannot convert",
  quantity_exceeds_available_stock: "The seller states there is not enough stock",
  quantity_not_splittable: "This quantity cannot be split across sellers",
  merchant_limit_would_be_exceeded: "Adding this item would exceed your merchant limit",
  hard_constraint_failed: "A requirement you set is not met",
  watchlist_item_unresolved:
    "This item needs you to say which product you meant after a catalogue change",
  delivery_cost_unknown: "Delivery cost is not published",
  tax_inclusion_unknown: "Whether tax is included is not published",
  objective_requires_complete_costs: "Some costs are unknown, so no full total can be claimed",
  objective_requires_native_offer: "Not available to buy on Mercaria",
  objective_requires_official_channel: "Not sold by a verified official channel",
  objective_requires_used_offer: "No second-hand or refurbished offer",
  pickup_data_unavailable: "Collection points are not published yet",
  offer_no_longer_eligible: "This offer is no longer available",
  offer_price_changed: "The price has changed since this plan was calculated",
};

export function basketReasonText(reason: BasketReasonCode): string {
  return REASON_TEXT[reason];
}

/** Why an answer is not proven optimal. */
const APPROXIMATION_TEXT: Readonly<Record<BasketApproximationReason, string>> = {
  candidate_limit_reached: "too many offers to examine all of them",
  merchant_limit_reached: "too many merchants to examine every combination",
  time_limit_reached: "the search ran out of time",
};

export function basketApproximationText(reason: BasketApproximationReason): string {
  return APPROXIMATION_TEXT[reason];
}

/** Why a comparison cell has no value. */
const UNKNOWN_TEXT: Readonly<Record<ComparisonUnknownReason, string>> = {
  not_recorded: "Not recorded",
  conflicting_sources: "Sources disagree",
  low_confidence: "Not confident enough to state",
  unit_not_comparable: "Recorded in a different unit",
  definition_not_published: "Not being shown here",
};

export function comparisonUnknownText(reason: ComparisonUnknownReason): string {
  return UNKNOWN_TEXT[reason];
}

/** Why a fact does not apply to a product at all. */
const NOT_APPLICABLE_TEXT: Readonly<Record<ComparisonNotApplicableReason, string>> = {
  attribute_out_of_category: "Does not apply",
  attribute_not_comparable: "Not comparable",
};

export function comparisonNotApplicableText(reason: ComparisonNotApplicableReason): string {
  return NOT_APPLICABLE_TEXT[reason];
}

/** Why a product cannot be bought. */
const UNAVAILABLE_TEXT: Readonly<Record<ComparisonUnavailableReason, string>> = {
  no_eligible_offer: "No offers available",
  all_offers_constrained_out: "No offer meets your requirements",
  no_convertible_price: "No offer we can price in this currency",
  offer_comparison_withheld: "Offers are not being shown here",
};

export function comparisonUnavailableText(reason: ComparisonUnavailableReason): string {
  return UNAVAILABLE_TEXT[reason];
}

/**
 * Why a generated explanation was refused.
 *
 * Shown to a shopper only as the one neutral sentence
 * {@link explanationFallbackNotice} composes — the codes below are for an
 * operator reading a response, and naming a provider's failure mode on a
 * shopping page would be telling them about somebody else's outage.
 */
const REJECTION_TEXT: Readonly<Record<ExplanationRejectionReason, string>> = {
  unknown_record_reference: "cited a record that was not supplied",
  uncited_statement: "made a claim with no record behind it",
  introduced_number: "introduced a number that is not in the data",
  constraint_result_changed: "changed a requirement's result",
  unknown_constraint_reference: "cited a requirement that was not supplied",
  forbidden_topic: "mentioned a topic recommendations may not consider",
  schema_invalid: "did not match the expected shape",
  output_too_long: "was longer than permitted",
  provider_unavailable: "is not configured",
  provider_error: "could not be reached",
};

export function explanationRejectionText(reason: ExplanationRejectionReason): string {
  return REJECTION_TEXT[reason];
}

/**
 * The ONE sentence a shopper sees when the narrative was not generated.
 *
 * Deliberately says nothing about a provider: what matters to them is that the
 * table below is the real comparison and was not written by a model, which is
 * true in every branch and is the more useful fact.
 */
export function explanationFallbackNotice(): string {
  return "This summary is generated from the comparison table below, without a language model.";
}
