/**
 * The reader-facing copy for the #74 comparison labels — as TRANSLATION KEYS.
 *
 * The LABELS and their REASON CODES live in `@mercaria/shared-types` and are
 * what an impression and an operator trace carry; this file is the part that is
 * deliberately free to change, exactly as `condition.ts` is for the #90
 * taxonomy. A label's meaning is stable, its wording is not, and keeping the two
 * apart is what stops a copy change becoming a contract change.
 *
 * Since #437 the wording is not here either — it is in
 * `packages/ui/src/i18n/locales/*.json`, translated once for all three apps,
 * and these maps hold the message ids that resolve it. See `condition.ts` for
 * why that is a third identifier rather than a collapse of the first two.
 *
 * ## Every label is explained INDEPENDENTLY (#74 §"Labels")
 *
 * One offer may carry several — cheapest item price AND the official store AND
 * buyable on Mercaria — and the issue is explicit that the UI must explain each
 * one on its own rather than summarising them. So there is one sentence per
 * label and no combined form, and `offerLabelExplanationKey` takes ONE award.
 *
 * ## No sentence claims more than the server established
 *
 * `cheapest_known_total` says "including delivery" because the total is only
 * awarded when the delivery cost is KNOWN — an offer whose shipping nobody
 * published cannot carry it, structurally. `fastest_known_delivery` and
 * `best_nearby_pickup` say "known" and "nearest we know of" for the same reason.
 * A sentence that dropped those qualifiers would be the surface claiming
 * something the ranking deliberately refused to, which is now a property every
 * TRANSLATION has to preserve as well as the English.
 */

import type {
  OfferComparisonLabel,
  OfferLabelAward,
  OfferLabelReason,
} from "@mercaria/shared-types";

/** The short badge text. */
export const OFFER_LABEL_TEXT_KEYS: Readonly<Record<OfferComparisonLabel, string>> = {
  best_overall: "ui.offer.label.best_overall",
  cheapest_item_price: "ui.offer.label.cheapest_item_price",
  cheapest_known_total: "ui.offer.label.cheapest_known_total",
  official_direct_store: "ui.offer.label.official_direct_store",
  authorized_reseller: "ui.offer.label.authorized_reseller",
  fastest_known_delivery: "ui.offer.label.fastest_known_delivery",
  best_nearby_pickup: "ui.offer.label.best_nearby_pickup",
  cheapest_new: "ui.offer.label.cheapest_new",
  cheapest_used: "ui.offer.label.cheapest_used",
  native_mercaria_checkout: "ui.offer.label.native_mercaria_checkout",
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
export const OFFER_LABEL_EXPLANATION_KEYS: Readonly<Record<OfferLabelReason, string>> = {
  highest_policy_score: "ui.offer.explanation.highest_policy_score",
  lowest_item_price: "ui.offer.explanation.lowest_item_price",
  lowest_known_total: "ui.offer.explanation.lowest_known_total",
  verified_official_channel: "ui.offer.explanation.verified_official_channel",
  verified_authorized_reseller: "ui.offer.explanation.verified_authorized_reseller",
  shortest_known_delivery: "ui.offer.explanation.shortest_known_delivery",
  nearest_collection_point: "ui.offer.explanation.nearest_collection_point",
  lowest_item_price_new_segment: "ui.offer.explanation.lowest_item_price_new_segment",
  lowest_item_price_used_segment: "ui.offer.explanation.lowest_item_price_used_segment",
  buyable_on_mercaria: "ui.offer.explanation.buyable_on_mercaria",
};

/**
 * `%{label} · %{basis}` — the chip's visible text when the award carries a
 * figure, and `%{label}: %{basis}` for the name a screen reader announces.
 *
 * Keys rather than templates built at the call site: the separator and the
 * colon are both punctuation a language decides (French spaces its colon,
 * Chinese and Japanese use a full-width one), and a translator can see a key.
 */
export const OFFER_LABEL_BADGE_WITH_BASIS_KEY = "ui.offer.badgeWithBasis";
export const OFFER_LABEL_A11Y_WITH_BASIS_KEY = "ui.offer.a11yLabelWithBasis";

/**
 * `%{count} day` / `%{count} days` — a delivery estimate's own figure.
 *
 * A pluralised key rather than a ternary over `=== 1`, which is the English
 * plural rule hardcoded into a component. i18n-js's DEFAULT pluralizer is still
 * English-shaped, so Russian and Arabic get the `other` form where a `few` or
 * `many` form is correct; that is the known, documented limitation #436 owns,
 * and it is one a per-locale pluralizer fixes without touching this call site.
 */
export const OFFER_LABEL_DAYS_KEY = "ui.offer.days";

/** The translation key for one award's badge text. */
export function offerLabelTextKey(label: OfferComparisonLabel): string {
  return OFFER_LABEL_TEXT_KEYS[label];
}

/**
 * The translation key for ONE award's full explanation.
 *
 * The award's own figure is rendered beside it by the caller rather than
 * interpolated here, so what a shopper reads is the number the server actually
 * ranked on — and `Money` goes through `formatMoney`, which is why this returns
 * a key rather than a finished sentence.
 */
export function offerLabelExplanationKey(award: OfferLabelAward): string {
  return OFFER_LABEL_EXPLANATION_KEYS[award.reason];
}
