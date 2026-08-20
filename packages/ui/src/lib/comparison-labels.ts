/**
 * The COPY for #96's comparison and basket vocabularies — as TRANSLATION KEYS.
 *
 * Keyed on the REASON and STATE codes rather than on a rendered sentence, the
 * `offer-labels.ts` decision one issue over: two surfaces rendering the same
 * refusal cannot drift, and a copy change is not a contract change.
 *
 * Since #437 the wording is not here either — it is in
 * `packages/ui/src/i18n/locales/*.json`, translated once for all three apps,
 * and these maps hold the message ids that resolve it. See `condition.ts` for
 * why that is a third identifier rather than a collapse of the first two.
 *
 * Every `Record` is exhaustive over its union, so a code added to
 * `@mercaria/shared-types` without copy here is a `tsc` error rather than a
 * blank chip a shopper cannot act on.
 *
 * ## Every sentence that SPLICES one of these is a key too
 *
 * A reason ("too many offers to examine all of them") is a TERM and a plan's
 * verdict ("Best plan found — …") is a SENTENCE, and English is the only
 * language in which gluing the second onto the first with an em dash happens to
 * work. So {@link BASKET_OPTIMALITY_APPROXIMATE_KEY} and
 * {@link COMPARISON_CELL_A11Y_KEY} carry the whole frame with a `%{}` slot, and
 * the render site resolves both halves — never a `${}` around a translated
 * fragment. That is #442's rule applied before it could be broken here: these
 * terms are never rendered as an action control's own label, so they may fill a
 * slot, and the frame they fill has to be one key per language.
 *
 * Even the list separator is a key. A basket's unresolved reasons are joined
 * for display, and `"; "` is not what Japanese (`、`) or Arabic (`؛`) use.
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
const RESULT_KIND_KEYS: Readonly<Record<BasketResultKind, string>> = {
  cheapest_known_item_prices: "ui.basket.result.cheapestKnownItemPrices",
  cheapest_known_total: "ui.basket.result.cheapestKnownTotal",
  fewest_merchants: "ui.basket.result.fewestMerchants",
  best_native_plan: "ui.basket.result.bestNativePlan",
  official_channel_plan: "ui.basket.result.officialChannelPlan",
  best_nearby_pickup: "ui.basket.result.bestNearbyPickup",
  used_or_refurbished_value: "ui.basket.result.usedOrRefurbishedValue",
  partial_coverage: "ui.basket.result.partialCoverage",
};

export function basketResultTextKey(kind: BasketResultKind): string {
  return RESULT_KIND_KEYS[kind];
}

/**
 * What a result kind actually compared.
 *
 * Shipped beside the name because "cheapest" and "cheapest known item prices"
 * mean different things and only the second one is true — #77's rule that a
 * number whose definition is unstated cannot be served, applied to a plan.
 *
 * `best_nearby_pickup`'s sentence is the one to read before editing any
 * translation of it. #93 published collection points, so the ORIGINAL wording
 * ("collection points are not published yet") became FALSE on that merge — the
 * comment-sweep hazard, in reader-facing copy. The result is still never
 * produced, but for a DIFFERENT reason, and stating the expired one would send
 * a shopper to look for a feature nobody is missing: a basket comparison request
 * carries no viewer position, so `resolvePickupProximity` answers
 * `viewer_location_absent` for every item. Nearby collection is answered on the
 * product page instead, where a shopper has chosen to share an origin. Every
 * locale has to preserve that distinction, not just the English.
 */
const RESULT_KIND_DEFINITION_KEYS: Readonly<Record<BasketResultKind, string>> = {
  cheapest_known_item_prices: "ui.basket.resultDefinition.cheapestKnownItemPrices",
  cheapest_known_total: "ui.basket.resultDefinition.cheapestKnownTotal",
  fewest_merchants: "ui.basket.resultDefinition.fewestMerchants",
  best_native_plan: "ui.basket.resultDefinition.bestNativePlan",
  official_channel_plan: "ui.basket.resultDefinition.officialChannelPlan",
  best_nearby_pickup: "ui.basket.resultDefinition.bestNearbyPickup",
  used_or_refurbished_value: "ui.basket.resultDefinition.usedOrRefurbishedValue",
  partial_coverage: "ui.basket.resultDefinition.partialCoverage",
};

export function basketResultDefinitionKey(kind: BasketResultKind): string {
  return RESULT_KIND_DEFINITION_KEYS[kind];
}

/**
 * Why an item or a plan is what it is.
 *
 * `pickup_data_unavailable` carries the same #93 correction as the
 * `best_nearby_pickup` definition above, in a second string the first sweep did
 * not reach: it means Mercaria has nowhere to measure FROM, not that there is
 * nothing to measure TO.
 */
const REASON_KEYS: Readonly<Record<BasketReasonCode, string>> = {
  no_eligible_offer: "ui.basket.reason.noEligibleOffer",
  no_offer_in_requested_condition: "ui.basket.reason.noOfferInRequestedCondition",
  no_offer_from_requested_merchant: "ui.basket.reason.noOfferFromRequestedMerchant",
  every_offer_from_excluded_merchant: "ui.basket.reason.everyOfferFromExcludedMerchant",
  no_offer_in_channel_policy: "ui.basket.reason.noOfferInChannelPolicy",
  no_convertible_price: "ui.basket.reason.noConvertiblePrice",
  quantity_exceeds_available_stock: "ui.basket.reason.quantityExceedsAvailableStock",
  quantity_not_splittable: "ui.basket.reason.quantityNotSplittable",
  merchant_limit_would_be_exceeded: "ui.basket.reason.merchantLimitWouldBeExceeded",
  hard_constraint_failed: "ui.basket.reason.hardConstraintFailed",
  watchlist_item_unresolved: "ui.basket.reason.watchlistItemUnresolved",
  delivery_cost_unknown: "ui.basket.reason.deliveryCostUnknown",
  tax_inclusion_unknown: "ui.basket.reason.taxInclusionUnknown",
  objective_requires_complete_costs: "ui.basket.reason.objectiveRequiresCompleteCosts",
  objective_requires_native_offer: "ui.basket.reason.objectiveRequiresNativeOffer",
  objective_requires_official_channel: "ui.basket.reason.objectiveRequiresOfficialChannel",
  objective_requires_used_offer: "ui.basket.reason.objectiveRequiresUsedOffer",
  pickup_data_unavailable: "ui.basket.reason.pickupDataUnavailable",
  offer_no_longer_eligible: "ui.basket.reason.offerNoLongerEligible",
  offer_price_changed: "ui.basket.reason.offerPriceChanged",
};

export function basketReasonTextKey(reason: BasketReasonCode): string {
  return REASON_KEYS[reason];
}

/** Why an answer is not proven optimal. A TERM, filled into the frame below. */
const APPROXIMATION_KEYS: Readonly<Record<BasketApproximationReason, string>> = {
  candidate_limit_reached: "ui.basket.approximation.candidateLimitReached",
  merchant_limit_reached: "ui.basket.approximation.merchantLimitReached",
  time_limit_reached: "ui.basket.approximation.timeLimitReached",
};

export function basketApproximationTextKey(reason: BasketApproximationReason): string {
  return APPROXIMATION_KEYS[reason];
}

/** "Best possible plan from the offers we can see." */
export const BASKET_OPTIMALITY_PROVEN_KEY = "ui.basket.optimalityProven";

/**
 * "Best plan found — %{reason}." — the WHOLE sentence, so a language that puts
 * the qualification first, or joins it with something other than an em dash,
 * can. `%{reason}` is resolved from {@link basketApproximationTextKey}.
 */
export const BASKET_OPTIMALITY_APPROXIMATE_KEY = "ui.basket.optimalityApproximate";

/** What separates two joined reasons. `"; "` in English, `、` in Japanese. */
export const COMPARISON_LIST_SEPARATOR_KEY = "ui.comparison.listSeparator";

/**
 * `BasketPlanCard`'s own copy (#437).
 *
 * ## Four hand-rolled English plurals came out of this card, and none went back
 *
 * `item`/`items`, `merchant`/`merchants` twice over, and a `merchantCount === 1`
 * branch inside `totalText`. Each was a ternary picking one of two English
 * words, which has no correct form in `ru` (three) or `ar` (six), so keeping the
 * shape and translating both halves would have shipped a wrong number-noun
 * agreement in ten of the twelve.
 *
 * They are gone rather than pluralised, because `%{count}` would move #436's
 * `pluralCategoryResidual` pin. Two devices replace them:
 *
 *   * A **parenthesised count** — `Add to Mercaria cart (%{items})`,
 *     `%{merchant} (%{items})` — which agrees with nothing and so is correct at
 *     every quantity in every language.
 *   * A **labelled value** — `Items: %{covered}/%{total}` — where the noun is a
 *     heading rather than a thing being counted.
 *
 * `deliveryMultiple` drops its numeral outright. It was `plus delivery from
 * %{n} merchants` on a branch only reachable at two or more, which is
 * plural-safe in English and not in Russian, where 2–4 and 5+ decline
 * differently. Nothing is lost: the merchant count is on the line above, in the
 * same card.
 *
 * ## `atLeast` is two frames because the dash was inside the fragment
 *
 * `At least %{floor}` and `At least %{floor} — %{missing}` rather than one plus
 * a conditional ` — ` glued on. An em dash is not how every language joins a
 * figure to its caveat, and in a right-to-left run its side was decided by the
 * text around it rather than by the sentence.
 */
export const BASKET_CARD_REFUSED_KEY = "ui.basket.card.refused";
export const BASKET_CARD_TALLY_KEY = "ui.basket.card.tally";
export const BASKET_CARD_ITEM_PRICES_KEY = "ui.basket.card.itemPrices";
export const BASKET_CARD_STALE_PRICES_KEY = "ui.basket.card.stalePrices";
export const BASKET_CARD_NOT_INCLUDED_KEY = "ui.basket.card.notIncluded";
export const BASKET_CARD_ADD_TO_CART_KEY = "ui.basket.card.addToCart";
export const BASKET_CARD_ADD_TO_CART_A11Y_KEY = "ui.basket.card.addToCartA11y";
export const BASKET_CARD_OPEN_RETAILERS_KEY = "ui.basket.card.openRetailers";
export const BASKET_CARD_OPEN_RETAILERS_NOTE_KEY = "ui.basket.card.openRetailersNote";
export const BASKET_CARD_MERCHANT_LINE_KEY = "ui.basket.card.merchantLine";
export const BASKET_CARD_MERCHANT_LINE_A11Y_KEY = "ui.basket.card.merchantLineA11y";
export const BASKET_CARD_AT_LEAST_KEY = "ui.basket.card.atLeast";
export const BASKET_CARD_AT_LEAST_MISSING_KEY = "ui.basket.card.atLeastMissing";
export const BASKET_CARD_DELIVERY_ONE_KEY = "ui.basket.card.deliveryOne";
export const BASKET_CARD_DELIVERY_MULTIPLE_KEY = "ui.basket.card.deliveryMultiple";
export const BASKET_CARD_TAX_UNKNOWN_KEY = "ui.basket.card.taxUnknown";
export const BASKET_CARD_PRICES_UNKNOWN_KEY = "ui.basket.card.pricesUnknown";

/** Why a comparison cell has no value. */
const UNKNOWN_KEYS: Readonly<Record<ComparisonUnknownReason, string>> = {
  not_recorded: "ui.comparison.unknown.notRecorded",
  conflicting_sources: "ui.comparison.unknown.conflictingSources",
  low_confidence: "ui.comparison.unknown.lowConfidence",
  unit_not_comparable: "ui.comparison.unknown.unitNotComparable",
  definition_not_published: "ui.comparison.unknown.definitionNotPublished",
};

export function comparisonUnknownTextKey(reason: ComparisonUnknownReason): string {
  return UNKNOWN_KEYS[reason];
}

/** Why a fact does not apply to a product at all. */
const NOT_APPLICABLE_KEYS: Readonly<Record<ComparisonNotApplicableReason, string>> = {
  attribute_out_of_category: "ui.comparison.notApplicable.attributeOutOfCategory",
  attribute_not_comparable: "ui.comparison.notApplicable.attributeNotComparable",
};

export function comparisonNotApplicableTextKey(reason: ComparisonNotApplicableReason): string {
  return NOT_APPLICABLE_KEYS[reason];
}

/**
 * "%{label}: %{value}" — one cell's accessible label.
 *
 * A key rather than a template literal because the separator is not a colon in
 * every language, and because the value it carries is itself translated.
 */
export const COMPARISON_CELL_A11Y_KEY = "ui.comparison.cellA11y";

/**
 * "%{label}: %{value}, inferred" — the same frame for a cell whose value
 * Mercaria CONVERTED rather than read.
 *
 * Its own key rather than the frame above plus an appended word: #96 product
 * comparison rule 5 asks an inference to be labelled distinctly from a
 * source-backed fact, and where that qualifier sits in the sentence is a
 * per-language decision.
 */
export const COMPARISON_CELL_INFERRED_A11Y_KEY = "ui.comparison.cellInferredA11y";

/** The visible note under an inferred cell — "converted, not stated". */
export const COMPARISON_CELL_INFERRED_NOTE_KEY = "ui.comparison.cellInferredNote";

/**
 * The comparison TABLE's own chrome (#437).
 *
 * Not a `Record` over a union, because none of these is keyed on a code — they
 * are the table's column header, its empty state, its unit frame and the two
 * directions it states in words. A constant apiece is the `COMPARISON_CELL_*`
 * shape above, for the same reason: there is nothing to be exhaustive over.
 *
 * `IN_UNIT` carries the whole frame with a `%{unit}` slot rather than a
 * translated preposition glued to the unit — the preposition inflects, and in
 * several of the twelve the unit does not follow it at all.
 *
 * `UNNAMED_PRODUCT` exists because the table carries subject REFS and the name
 * map is keyed by ref, so it can never be exhaustive: the miss branch has to
 * render something, and rendering the ref would put a wire identifier in front
 * of a shopper (#596's finding, one component over).
 */
export const COMPARISON_TABLE_SPECIFICATION_KEY = "ui.comparison.table.specification";
export const COMPARISON_TABLE_UNNAMED_PRODUCT_KEY = "ui.comparison.table.unnamedProduct";
export const COMPARISON_TABLE_NO_DIFFERENCES_KEY = "ui.comparison.table.noDifferences";
export const COMPARISON_TABLE_IN_UNIT_KEY = "ui.comparison.table.inUnit";
export const COMPARISON_TABLE_HIGHER_IS_BETTER_KEY = "ui.comparison.table.higherIsBetter";
export const COMPARISON_TABLE_LOWER_IS_BETTER_KEY = "ui.comparison.table.lowerIsBetter";

/** Why a product cannot be bought. */
const UNAVAILABLE_KEYS: Readonly<Record<ComparisonUnavailableReason, string>> = {
  no_eligible_offer: "ui.comparison.unavailable.noEligibleOffer",
  all_offers_constrained_out: "ui.comparison.unavailable.allOffersConstrainedOut",
  no_convertible_price: "ui.comparison.unavailable.noConvertiblePrice",
  offer_comparison_withheld: "ui.comparison.unavailable.offerComparisonWithheld",
};

export function comparisonUnavailableTextKey(reason: ComparisonUnavailableReason): string {
  return UNAVAILABLE_KEYS[reason];
}

/**
 * Why a generated explanation was refused.
 *
 * Shown to a shopper only as the one neutral sentence
 * {@link COMPARISON_EXPLANATION_FALLBACK_NOTICE_KEY} carries — the codes below
 * are for an operator reading a response, and naming a provider's failure mode
 * on a shopping page would be telling them about somebody else's outage.
 */
const REJECTION_KEYS: Readonly<Record<ExplanationRejectionReason, string>> = {
  unknown_record_reference: "ui.comparison.explanationRejection.unknownRecordReference",
  uncited_statement: "ui.comparison.explanationRejection.uncitedStatement",
  introduced_number: "ui.comparison.explanationRejection.introducedNumber",
  constraint_result_changed: "ui.comparison.explanationRejection.constraintResultChanged",
  unknown_constraint_reference: "ui.comparison.explanationRejection.unknownConstraintReference",
  forbidden_topic: "ui.comparison.explanationRejection.forbiddenTopic",
  schema_invalid: "ui.comparison.explanationRejection.schemaInvalid",
  output_too_long: "ui.comparison.explanationRejection.outputTooLong",
  provider_unavailable: "ui.comparison.explanationRejection.providerUnavailable",
  provider_error: "ui.comparison.explanationRejection.providerError",
};

export function explanationRejectionTextKey(reason: ExplanationRejectionReason): string {
  return REJECTION_KEYS[reason];
}

/**
 * The ONE sentence a shopper sees when the narrative was not generated.
 *
 * Deliberately says nothing about a provider: what matters to them is that the
 * table below is the real comparison and was not written by a model, which is
 * true in every branch and is the more useful fact.
 */
export const COMPARISON_EXPLANATION_FALLBACK_NOTICE_KEY =
  "ui.comparison.explanationFallbackNotice";

/**
 * The provenance line, keyed on WHO wrote the narrative (#560).
 *
 * This sentence was hardcoded English with `provenance.provider` spliced into
 * it — "Written by deterministic_template under comparison policy v3" — so it
 * was a check-A finding and a check-J finding at once.
 *
 * ## Keyed on `state`, deliberately, and NOT on `provenance.provider`
 *
 * `ExplanationProvenance.provider` is documented as an OPAQUE id: the template
 * renderer's own `deterministic_template`, or a vendor slug. It is an OPEN set,
 * so a `Record` over it is impossible and the honest alternatives were a lookup
 * with a fallback — which renders the raw slug again, the defect — or naming
 * the vendor to a shopper, which {@link SHOPPING_AGENT_SUMMARY_SOURCE_KEYS} one
 * domain over already declined to do.
 *
 * `ComparisonExplanation.state` carries the same distinction as a CLOSED union
 * and the correspondence is exact rather than approximate: the service emits
 * `state: 'generated'` with the provider's own id, and `renderTemplateExplanation`
 * is the only producer of `state: 'template'` and hardcodes
 * `provider: 'deterministic_template'`. `unavailable` has no provenance at all
 * and its branch returns before this line. So the two members below are total
 * over what can reach it, and no slug can be rendered from here.
 *
 * The POLICY VERSION is still interpolated, and that is not the same decision:
 * it is the audit handle #96 explanation rule 10 asks a shopper to be able to
 * inspect, it has no localized form, and it is shown verbatim by design — the
 * `{code.code}` case on the referral screen, one package over.
 */
export const COMPARISON_PROVENANCE_KEYS: Readonly<
  Record<"generated" | "template", string>
> = {
  generated: "ui.comparison.provenance.generated",
  template: "ui.comparison.provenance.template",
};
