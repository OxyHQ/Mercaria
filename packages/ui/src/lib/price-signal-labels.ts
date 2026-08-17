/**
 * The reader-facing copy for the #82 price signals — as TRANSLATION KEYS.
 *
 * The KINDS, the LABELS, the REASON CODES and the POSITIONS live in
 * `@mercaria/shared-types` and are what a recorded evaluation and an operator
 * trace carry; this file is the part that is deliberately free to change,
 * exactly as `offer-labels.ts` is for #74 and `condition.ts` is for #90. A
 * signal's meaning is stable, its wording is not, and keeping the two apart is
 * what stops a copy change becoming a contract change.
 *
 * Since #437 the wording is not here either — it is in
 * `packages/ui/src/i18n/locales/*.json`, translated once for all three apps,
 * and these maps hold the message ids that resolve it.
 *
 * ## Nothing here is rendered by anything yet, and that is worth knowing
 *
 * Every export below reaches the barrel and no component. This is #82's
 * merchant-competitiveness copy, waiting on #40's dashboard screens and #71's
 * product page. Converting it was safe PRECISELY because nothing renders it —
 * and nobody should read the conversion as evidence that the surface works.
 *
 * ## Every sentence is written for the state it belongs to (#82 §"UI" 1–3)
 *
 * THREE states, three sets of copy, and the middle one is the one people
 * collapse. `unmeasured` says what is missing; `not_present` says the
 * derivation ran and the condition does not hold; `measured` says the claim. A
 * surface that rendered `not_present` with the unmeasured copy would tell a
 * merchant their data is too thin when it is fine.
 *
 * ## No sentence claims more than the server established
 *
 * `lowest_observed_known_total` says "including delivery, among the offers
 * whose delivery cost we know" because that measure EXCLUDES an offer whose
 * postage nobody published rather than treating it as free.
 * `price_quality_label` never says "cheapest" or "best deal" — it says where a
 * price sits against a median over a named sample. A sentence that dropped
 * those qualifiers would be the surface claiming something the derivation
 * deliberately refused to, which is now a property every TRANSLATION has to
 * preserve as well as the English.
 *
 * ## The summary is ELEVEN whole sentences, not one with fragments in it
 *
 * The pre-#437 version glued a direction word ("below", "above") and a
 * position word into a template literal. That is #442's shape: those are TERMS
 * and the frame is a SENTENCE, and only English happens to work when you
 * concatenate them in that order. So each branch is a whole key with `%{}`
 * slots for the DATA, and the direction is chosen by picking a different
 * sentence rather than by filling a slot.
 *
 * ## Accessibility: never colour alone (#82 UI 5)
 *
 * {@link PRICE_POSITION_KEYS} and {@link PRICE_QUALITY_LABEL_KEYS} resolve to
 * WORDS, and {@link priceSignalAccessibleSummary} composes a sentence carrying
 * the position, the distance and the sample size. A badge rendered from these
 * is legible with every colour removed, which is the requirement — colour may
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
import type { Translate } from "../i18n/create-app-i18n";
import { formatPercent } from "./format";

/** The short badge text for a quality label. */
export const PRICE_QUALITY_LABEL_KEYS: Readonly<Record<PriceQualityLabel, string>> = {
  good_price: "ui.priceSignal.qualityLabel.goodPrice",
  typical_price: "ui.priceSignal.qualityLabel.typicalPrice",
  above_typical: "ui.priceSignal.qualityLabel.aboveTypical",
};

/** How strong the sample behind a label is, in words rather than in stars. */
export const PRICE_QUALITY_CONFIDENCE_KEYS: Readonly<
  Record<PriceQualityConfidence, string>
> = {
  sufficient: "ui.priceSignal.confidence.sufficient",
  strong: "ui.priceSignal.confidence.strong",
};

/**
 * Where a price sits, as a WORD — never a colour on its own.
 *
 * A standalone term for a badge. The accessible SUMMARY does not fill a slot
 * with it; it picks a whole sentence instead. See the module note.
 */
export const PRICE_POSITION_KEYS: Readonly<Record<PriceMarketPosition, string>> = {
  below: "ui.priceSignal.position.below",
  near: "ui.priceSignal.position.near",
  above: "ui.priceSignal.position.above",
};

/** What each signal is, for the explanation drawer heading. */
export const PRICE_SIGNAL_TITLE_KEYS: Readonly<Record<PriceSignalKind, string>> = {
  lowest_observed_item_price: "ui.priceSignal.title.lowestObservedItemPrice",
  lowest_observed_known_total: "ui.priceSignal.title.lowestObservedKnownTotal",
  current_vs_recent_median: "ui.priceSignal.title.currentVsRecentMedian",
  material_price_drop: "ui.priceSignal.title.materialPriceDrop",
  typical_recent_range: "ui.priceSignal.title.typicalRecentRange",
  official_store_position: "ui.priceSignal.title.officialStorePosition",
  price_quality_label: "ui.priceSignal.title.priceQualityLabel",
};

/** What each signal MEANS, in one sentence, for the drawer body. */
export const PRICE_SIGNAL_MEANING_KEYS: Readonly<Record<PriceSignalKind, string>> = {
  lowest_observed_item_price: "ui.priceSignal.meaning.lowestObservedItemPrice",
  lowest_observed_known_total: "ui.priceSignal.meaning.lowestObservedKnownTotal",
  current_vs_recent_median: "ui.priceSignal.meaning.currentVsRecentMedian",
  material_price_drop: "ui.priceSignal.meaning.materialPriceDrop",
  typical_recent_range: "ui.priceSignal.meaning.typicalRecentRange",
  official_store_position: "ui.priceSignal.meaning.officialStorePosition",
  price_quality_label: "ui.priceSignal.meaning.priceQualityLabel",
};

/** The badge shown for a measured DROP, which carries no label of its own. */
export const PRICE_SIGNAL_DROP_BADGE_KEY = "ui.priceSignal.badge.priceDrop";

/**
 * The badge KEY for one signal, or `undefined` when it has no badge.
 *
 * A lookup and a constant, never a built string: the pre-#437 version returned
 * the literal `"Price drop"` from one branch, which is copy that no extraction
 * scan could ever find because there was no map entry to read.
 */
export function priceSignalBadgeTextKey(signal: PriceSignal): string | undefined {
  if (signal.state !== "measured") return undefined;
  if (signal.value.measure === "label") return PRICE_QUALITY_LABEL_KEYS[signal.value.label];
  if (signal.value.measure === "drop") return PRICE_SIGNAL_DROP_BADGE_KEY;
  return undefined;
}

/** Why a signal could not be computed, in words a shopper or a merchant can act on. */
export const PRICE_SIGNAL_UNMEASURED_KEYS: Readonly<
  Record<PriceSignalUnmeasuredReason, string>
> = {
  no_active_policy: "ui.priceSignal.unmeasured.noActivePolicy",
  insufficient_observations: "ui.priceSignal.unmeasured.insufficientObservations",
  insufficient_distinct_sellers: "ui.priceSignal.unmeasured.insufficientDistinctSellers",
  insufficient_distinct_offers: "ui.priceSignal.unmeasured.insufficientDistinctOffers",
  insufficient_time_coverage: "ui.priceSignal.unmeasured.insufficientTimeCoverage",
  no_eligible_current_offer: "ui.priceSignal.unmeasured.noEligibleCurrentOffer",
  no_comparable_history: "ui.priceSignal.unmeasured.noComparableHistory",
  currency_not_convertible: "ui.priceSignal.unmeasured.currencyNotConvertible",
  segment_not_applicable: "ui.priceSignal.unmeasured.segmentNotApplicable",
  measure_not_applicable: "ui.priceSignal.unmeasured.measureNotApplicable",
  demand_measurement_unavailable: "ui.priceSignal.unmeasured.demandMeasurementUnavailable",
};

/** What a merchant's competitiveness row is about. */
export const MERCHANT_COMPETITIVENESS_TITLE_KEYS: Readonly<
  Record<MerchantCompetitivenessInsightKind, string>
> = {
  position_vs_eligible_median: "ui.priceSignal.competitiveness.positionVsEligibleMedian",
  cheapest_item_price: "ui.priceSignal.competitiveness.cheapestItemPrice",
  cheapest_known_total: "ui.priceSignal.competitiveness.cheapestKnownTotal",
  losing_eligibility: "ui.priceSignal.competitiveness.losingEligibility",
  demand_without_native_offer: "ui.priceSignal.competitiveness.demandWithoutNativeOffer",
  own_price_movement: "ui.priceSignal.competitiveness.ownPriceMovement",
  official_channel_position: "ui.priceSignal.competitiveness.officialChannelPosition",
};

/** What a merchant can DO about an offer that is losing eligibility. */
export const MERCHANT_ELIGIBILITY_LOSS_KEYS: Readonly<
  Record<MerchantEligibilityLossReason, string>
> = {
  observation_stale: "ui.priceSignal.eligibilityLoss.observationStale",
  availability_unknown: "ui.priceSignal.eligibilityLoss.availabilityUnknown",
  delivery_cost_unknown: "ui.priceSignal.eligibilityLoss.deliveryCostUnknown",
  destination_missing: "ui.priceSignal.eligibilityLoss.destinationMissing",
  condition_unknown: "ui.priceSignal.eligibilityLoss.conditionUnknown",
  price_missing: "ui.priceSignal.eligibilityLoss.priceMissing",
};

/**
 * The recommendation sentences — informational, and each one derived from a row
 * that has already been computed.
 *
 * Not one of them says what a price should BE, and none promises a sales
 * outcome. `would_be_cheapest_item_price` is conditional on purpose: the offer
 * it describes is not currently being compared, so "is the cheapest" would be
 * false and saying nothing would withhold the one fact that makes fixing the
 * eligibility worth a merchant's time. Every translation has to keep that
 * conditional.
 */
export const PRICE_SIGNAL_RECOMMENDATION_KEYS: Readonly<
  Record<PriceSignalRecommendationKind, string>
> = {
  above_eligible_median: "ui.priceSignal.recommendation.aboveEligibleMedian",
  delivery_unknown_blocks_known_total:
    "ui.priceSignal.recommendation.deliveryUnknownBlocksKnownTotal",
  refresh_would_restore_eligibility:
    "ui.priceSignal.recommendation.refreshWouldRestoreEligibility",
  would_be_cheapest_item_price: "ui.priceSignal.recommendation.wouldBeCheapestItemPrice",
};

/** "Based on %{observations} prices from %{sellers} sellers." */
const SAMPLE_KEY = "ui.priceSignal.sample";

/**
 * Every branch of the accessible summary, as a WHOLE sentence.
 *
 * The three `label*` and three `relative*` members exist instead of a
 * `%{direction}` slot: see the module note. Picking a sentence rather than
 * filling a slot is what lets a language put the comparison first, inflect the
 * verb, or drop the preposition entirely.
 */
const SUMMARY_KEYS = {
  unmeasured: "ui.priceSignal.summary.unmeasured",
  notPresent: "ui.priceSignal.summary.notPresent",
  labelBelow: "ui.priceSignal.summary.labelBelow",
  labelAbove: "ui.priceSignal.summary.labelAbove",
  labelSame: "ui.priceSignal.summary.labelSame",
  relativeBelow: "ui.priceSignal.summary.relativeBelow",
  relativeNear: "ui.priceSignal.summary.relativeNear",
  relativeAbove: "ui.priceSignal.summary.relativeAbove",
  drop: "ui.priceSignal.summary.drop",
  moneyRange: "ui.priceSignal.summary.moneyRange",
  plain: "ui.priceSignal.summary.plain",
} as const;

/** Which `relative` sentence a server-derived position selects. */
const RELATIVE_SUMMARY_KEYS: Readonly<Record<PriceMarketPosition, string>> = {
  below: SUMMARY_KEYS.relativeBelow,
  near: SUMMARY_KEYS.relativeNear,
  above: SUMMARY_KEYS.relativeAbove,
};

/**
 * One accessible sentence for a signal, carrying the position, the distance and
 * the sample — issue UI 5's "accessible text and not colour alone", composed
 * once here rather than on three clients.
 *
 * ## Why this takes `t` when every other export is a bare key
 *
 * The branching is DOMAIN logic over `PriceSignal`'s union — three states and
 * five measures — not a rendering decision, so it belongs here and not at a
 * call site. Returning a `{key, params}` descriptor was the obvious
 * alternative and is worse: four of the slots are themselves translated
 * (the title, the label, the confidence), so the descriptor would have to be
 * recursive and every caller would need to know how to walk it.
 *
 * Injecting the resolver moves NO exhaustive `Record` out of this package,
 * which is the property #437 rejected the props-based design to protect. The
 * caller passes what `useSharedUiTranslation()` already hands it.
 *
 * It deliberately does NOT format money: an amount is a `PriceHistoryValue`
 * whose FX basis a caller must see, and `PriceDisplay` is the one place in this
 * package that renders one.
 *
 * `locale` rides beside `t` for the same reason the two travel together on
 * `SharedUiTranslationProvider` (#500): the percentages this composes sit
 * INSIDE the sentence `t` resolves, so a caller able to supply one and not the
 * other could put an ASCII `8.2%` in the middle of a German sentence.
 */
export function priceSignalAccessibleSummary(
  t: Translate,
  locale: string,
  signal: PriceSignal,
): string {
  const title = t(PRICE_SIGNAL_TITLE_KEYS[signal.kind]);

  if (signal.state === "unmeasured") {
    return t(SUMMARY_KEYS.unmeasured, {
      title,
      reason: t(PRICE_SIGNAL_UNMEASURED_KEYS[signal.reason]),
    });
  }
  if (signal.state === "not_present") {
    return t(SUMMARY_KEYS.notPresent, {
      title,
      observations: signal.sample.observations,
      sellers: signal.sample.distinctSellers,
    });
  }

  const sample = t(SAMPLE_KEY, {
    observations: signal.sample.observations,
    sellers: signal.sample.distinctSellers,
  });
  const value = signal.value;

  if (value.measure === "label") {
    const key =
      value.deltaBps < 0
        ? SUMMARY_KEYS.labelBelow
        : value.deltaBps > 0
          ? SUMMARY_KEYS.labelAbove
          : SUMMARY_KEYS.labelSame;
    return t(key, {
      title,
      label: t(PRICE_QUALITY_LABEL_KEYS[value.label]),
      distance: formatPercent(value.deltaBps, locale),
      confidence: t(PRICE_QUALITY_CONFIDENCE_KEYS[value.confidence]),
      sample,
    });
  }
  if (value.measure === "relative") {
    return t(RELATIVE_SUMMARY_KEYS[value.position], {
      title,
      distance: formatPercent(value.deltaBps, locale),
      sample,
    });
  }
  if (value.measure === "drop") {
    return t(SUMMARY_KEYS.drop, { title, distance: formatPercent(value.deltaBps, locale), sample });
  }
  if (value.measure === "money_range") {
    return t(SUMMARY_KEYS.moneyRange, { title, sample });
  }
  return t(SUMMARY_KEYS.plain, { title, sample });
}
