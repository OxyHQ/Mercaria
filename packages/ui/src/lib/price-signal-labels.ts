/**
 * The reader-facing copy for the #82 price signals.
 *
 * The KINDS, the LABELS, the REASON CODES and the POSITIONS live in
 * `@mercaria/shared-types` and are what a recorded evaluation and an operator
 * trace carry; this file is the part that is deliberately free to change, exactly
 * as `offer-labels.ts` is for #74 and `condition.ts` is for #90. A signal's
 * meaning is stable, its wording is not, and keeping the two apart is what stops
 * a copy change becoming a contract change.
 *
 * ## Every sentence is written for the state it belongs to (#82 §"UI" 1–3)
 *
 * THREE states, three sets of copy, and the middle one is the one people
 * collapse. `unmeasured` says what is missing; `not_present` says the derivation
 * ran and the condition does not hold; `measured` says the claim. A surface that
 * rendered `not_present` with the unmeasured copy would tell a merchant their
 * data is too thin when it is fine.
 *
 * ## No sentence claims more than the server established
 *
 * `lowest_observed_known_total` says "including delivery, among the offers whose
 * delivery cost we know" because that measure EXCLUDES an offer whose postage
 * nobody published rather than treating it as free. `price_quality_label` never
 * says "cheapest" or "best deal" — it says where a price sits against a median
 * over a named sample. A sentence that dropped those qualifiers would be the
 * surface claiming something the derivation deliberately refused to.
 *
 * ## Accessibility: never colour alone (#82 UI 5)
 *
 * {@link PRICE_POSITION_TEXT} and {@link PRICE_QUALITY_LABEL_TEXT} are WORDS, and
 * {@link priceSignalAccessibleSummary} composes a sentence that carries the
 * position, the distance and the sample size. A badge rendered from these is
 * legible with every colour removed, which is the requirement — colour may
 * reinforce the word and may never replace it.
 */

import type {
  MerchantCompetitivenessInsightKind,
  MerchantEligibilityLossReason,
  PriceMarketPosition,
  PriceQualityConfidence,
  PriceQualityLabel,
  PriceSignal,
  PriceSignalKind,
  PriceSignalRecommendationKind,
  PriceSignalUnmeasuredReason,
} from "@mercaria/shared-types";

/** The short badge text for a quality label. */
export const PRICE_QUALITY_LABEL_TEXT: Readonly<Record<PriceQualityLabel, string>> = {
  good_price: "Good price",
  typical_price: "Typical price",
  above_typical: "Above typical",
};

/** How strong the sample behind a label is, in words rather than in stars. */
export const PRICE_QUALITY_CONFIDENCE_TEXT: Readonly<Record<PriceQualityConfidence, string>> = {
  sufficient: "Based on enough comparable offers to say",
  strong: "Based on a wide sample of comparable offers",
};

/** Where a price sits, as a WORD — never a colour on its own. */
export const PRICE_POSITION_TEXT: Readonly<Record<PriceMarketPosition, string>> = {
  below: "below",
  near: "about the same as",
  above: "above",
};

/** What each signal is, for the explanation drawer heading. */
export const PRICE_SIGNAL_TITLE: Readonly<Record<PriceSignalKind, string>> = {
  lowest_observed_item_price: "Lowest price we have seen",
  lowest_observed_known_total: "Lowest total we have seen",
  current_vs_recent_median: "Against the recent typical price",
  material_price_drop: "Recent price drop",
  typical_recent_range: "Typical recent range",
  official_store_position: "The official store's price",
  price_quality_label: "How this price compares",
};

/** What each signal MEANS, in one sentence, for the drawer body. */
export const PRICE_SIGNAL_MEANING: Readonly<Record<PriceSignalKind, string>> = {
  lowest_observed_item_price:
    "The lowest item price we recorded in this condition, in this market and over this window. Prices we judged to be data errors are set aside and listed separately.",
  lowest_observed_known_total:
    "The lowest total including delivery, among the offers whose delivery cost the seller actually published. Offers that published none are excluded rather than treated as free.",
  current_vs_recent_median:
    "Today's price against the middle of what we recorded over this window — how it compares with itself lately, not with other sellers today.",
  material_price_drop:
    "How far the current price has fallen against the most recent earlier price we recorded and judged sound.",
  typical_recent_range:
    "The middle half of the prices we recorded over this window. Both ends are prices somebody actually charged.",
  official_store_position:
    "The price at a store the brand has verified as its own, against the other new offers we can compare. It excludes the official store's own price from that comparison.",
  price_quality_label:
    "Today's price against the middle of the offers we can compare right now, one price per seller.",
};

/** The badge text for one signal, whatever its state. */
export function priceSignalBadgeText(signal: PriceSignal): string | undefined {
  if (signal.state !== "measured") return undefined;
  if (signal.value.measure === "label") return PRICE_QUALITY_LABEL_TEXT[signal.value.label];
  if (signal.value.measure === "drop") return "Price drop";
  return undefined;
}

/** Why a signal could not be computed, in words a shopper or a merchant can act on. */
export const PRICE_SIGNAL_UNMEASURED_TEXT: Readonly<
  Record<PriceSignalUnmeasuredReason, string>
> = {
  no_active_policy: "We have not published a definition for this comparison yet.",
  insufficient_observations: "We have not recorded enough prices to say.",
  insufficient_distinct_sellers: "Too few different sellers to call this a market.",
  insufficient_distinct_offers: "Too few separate offers to compare.",
  insufficient_time_coverage: "We have not been watching this for long enough.",
  no_eligible_current_offer: "There is no offer we can compare right now.",
  no_comparable_history: "We have no comparable price history for this.",
  currency_not_convertible: "We cannot express these prices in the currency you asked for.",
  segment_not_applicable: "This comparison is only defined for new items.",
  measure_not_applicable: "This measure does not apply here.",
  demand_measurement_unavailable: "We do not measure demand for a product yet.",
};

/** What a merchant's competitiveness row is about. */
export const MERCHANT_COMPETITIVENESS_TITLE: Readonly<
  Record<MerchantCompetitivenessInsightKind, string>
> = {
  position_vs_eligible_median: "Against the market median",
  cheapest_item_price: "Against the cheapest item price",
  cheapest_known_total: "Against the cheapest known total",
  losing_eligibility: "Why this offer is not being compared",
  demand_without_native_offer: "Demand without an offer from you",
  own_price_movement: "Against your own previous price",
  official_channel_position: "Your official-store position",
};

/** What a merchant can DO about an offer that is losing eligibility. */
export const MERCHANT_ELIGIBILITY_LOSS_TEXT: Readonly<
  Record<MerchantEligibilityLossReason, string>
> = {
  observation_stale: "We have not seen a fresh reading of this offer recently.",
  availability_unknown: "The source does not say whether this is in stock.",
  delivery_cost_unknown:
    "No delivery cost is published, so this offer cannot appear in a total-price comparison.",
  destination_missing: "There is no link a buyer can follow to this offer.",
  condition_unknown: "The condition of this item is not stated in a form we can map.",
  price_missing: "No price is published for this offer.",
};

/**
 * The recommendation sentences — informational, and each one derived from a row
 * that has already been computed.
 *
 * Not one of them says what a price should BE, and none promises a sales
 * outcome. `would_be_cheapest_item_price` is conditional on purpose: the offer
 * it describes is not currently being compared, so "is the cheapest" would be
 * false and saying nothing would withhold the one fact that makes fixing the
 * eligibility worth a merchant's time.
 */
export const PRICE_SIGNAL_RECOMMENDATION_TEXT: Readonly<
  Record<PriceSignalRecommendationKind, string>
> = {
  above_eligible_median: "Your current price is above the median of the offers we can compare.",
  delivery_unknown_blocks_known_total:
    "Delivery is unknown for this offer, so we cannot calculate a total price for it.",
  refresh_would_restore_eligibility:
    "Refreshing this offer would bring it back into the comparison.",
  would_be_cheapest_item_price:
    "At this observed price, this offer would be the cheapest item price once it is being compared again.",
};

/**
 * One accessible sentence for a signal, carrying the position, the distance and
 * the sample — issue UI 5's "accessible text and not colour alone", composed
 * once here rather than on three clients.
 *
 * It deliberately does NOT format money: an amount is a `PriceHistoryValue` whose
 * FX basis a caller must see, and `PriceDisplay` is the one place in this package
 * that renders one.
 */
export function priceSignalAccessibleSummary(signal: PriceSignal): string {
  const title = PRICE_SIGNAL_TITLE[signal.kind];

  if (signal.state === "unmeasured") {
    return `${title}: ${PRICE_SIGNAL_UNMEASURED_TEXT[signal.reason]}`;
  }
  if (signal.state === "not_present") {
    return `${title}: we compared ${signal.sample.observations} prices from ${signal.sample.distinctSellers} sellers and found none.`;
  }

  const sample = `Based on ${signal.sample.observations} prices from ${signal.sample.distinctSellers} sellers.`;
  const value = signal.value;

  if (value.measure === "label") {
    const distance = formatPercent(value.deltaBps);
    const direction = value.deltaBps < 0 ? "below" : value.deltaBps > 0 ? "above" : "the same as";
    return `${title}: ${PRICE_QUALITY_LABEL_TEXT[value.label]} — ${distance} ${direction} the middle of what we can compare. ${PRICE_QUALITY_CONFIDENCE_TEXT[value.confidence]}. ${sample}`;
  }
  if (value.measure === "relative") {
    return `${title}: ${formatPercent(value.deltaBps)} ${PRICE_POSITION_TEXT[value.position]} the reference. ${sample}`;
  }
  if (value.measure === "drop") {
    return `${title}: down ${formatPercent(value.deltaBps)} on the last price we recorded. ${sample}`;
  }
  if (value.measure === "money_range") {
    return `${title}: the middle half of what we recorded. ${sample}`;
  }
  return `${title}. ${sample}`;
}

/**
 * Basis points as a percentage, to one decimal, always positive.
 *
 * The DIRECTION is a word in the sentence rather than a minus sign, because a
 * screen reader announcing "minus eight percent" beside the word "below" reads as
 * two different claims.
 */
function formatPercent(deltaBps: number): string {
  const percent = Math.abs(deltaBps) / 100;
  return `${percent.toFixed(1)}%`;
}
