/**
 * The reader-facing copy for the #90 condition taxonomy — as TRANSLATION KEYS.
 *
 * The KEYS in `@mercaria/shared-types` never change; this file is the part that
 * is deliberately free to. #90's base taxonomy says the exact labels are still
 * to be finalized with localization and marketplace-policy review, so keeping
 * them out of shared-types is not tidiness — it is what makes "stored keys
 * remain stable when the copy changes" a fact about where the strings live
 * rather than a promise somebody keeps.
 *
 * ## Why these are keys and not sentences (#437)
 *
 * They were English sentences until #437. A dashboard screen could be fully
 * string-extracted, pass `validate:i18n-strings`, and still render an English
 * paragraph, because the paragraph came from here. Module-scope data now holds
 * KEYS and the render site resolves them — the rule the two apps already follow
 * — and the SENTENCES live in `packages/ui/src/i18n/locales/*.json`, translated
 * once for all three apps.
 *
 * This is not the taxonomy key becoming the label: `ItemConditionKey` is still
 * what a column and a CHECK carry, and `ui.condition.label.used_good` is a
 * message id that only a bundle resolves. Two different identifiers for two
 * different jobs, which is the split this file existed for in the first place.
 *
 * ## Every key carries a plain-language explanation (#90 policy rule 1)
 *
 * A label alone ("Good") tells a shopper nothing about what they are buying.
 * The explanation is what a picker, a tooltip and a product page all render, and
 * it is REQUIRED for every key by the `Record` type — adding a taxonomy key
 * without one is a compile error rather than a blank line in a picker.
 *
 * ## Nothing here promises quality (#90 policy rule 7)
 *
 * Each explanation describes what the SELLER is stating. None of them says the
 * item works, is guaranteed, or has been checked by Mercaria, because none of
 * those is a thing a label can establish. That property lives in the bundles
 * now, so it is a property a TRANSLATOR has to preserve — which is why the
 * disclaimer below is a key of its own rather than a sentence spliced onto each
 * explanation.
 */

import type { ConditionGroup, ItemConditionKey } from "@mercaria/shared-types";

/** The short label a badge and a picker row show. */
export const CONDITION_LABEL_KEYS: Readonly<Record<ItemConditionKey, string>> = {
  new: "ui.condition.label.new",
  open_box: "ui.condition.label.open_box",
  refurbished_manufacturer: "ui.condition.label.refurbished_manufacturer",
  refurbished_seller: "ui.condition.label.refurbished_seller",
  used_like_new: "ui.condition.label.used_like_new",
  used_good: "ui.condition.label.used_good",
  used_fair: "ui.condition.label.used_fair",
  used_poor: "ui.condition.label.used_poor",
  for_parts: "ui.condition.label.for_parts",
};

/** One sentence saying what the seller is actually claiming. */
export const CONDITION_EXPLANATION_KEYS: Readonly<Record<ItemConditionKey, string>> = {
  new: "ui.condition.explanation.new",
  open_box: "ui.condition.explanation.open_box",
  refurbished_manufacturer: "ui.condition.explanation.refurbished_manufacturer",
  refurbished_seller: "ui.condition.explanation.refurbished_seller",
  used_like_new: "ui.condition.explanation.used_like_new",
  used_good: "ui.condition.explanation.used_good",
  used_fair: "ui.condition.explanation.used_fair",
  used_poor: "ui.condition.explanation.used_poor",
  for_parts: "ui.condition.explanation.for_parts",
};

/** The label a filter facet and a price-history segment show. */
export const CONDITION_GROUP_LABEL_KEYS: Readonly<Record<ConditionGroup, string>> = {
  new: "ui.condition.group.new",
  open_box: "ui.condition.group.open_box",
  refurbished: "ui.condition.group.refurbished",
  used: "ui.condition.group.used",
  for_parts: "ui.condition.group.for_parts",
};

/**
 * The one sentence a condition badge must never let a shopper forget.
 *
 * #90 policy rule 7 in a string: the label is the seller's statement, not
 * Mercaria's verification of it. Surfaced beside the explanation on any surface
 * where a shopper is choosing between conditions.
 */
export const CONDITION_DISCLAIMER_KEY = "ui.condition.disclaimer";

/**
 * `Condition: %{label}` — the accessible name a badge announces.
 *
 * A key rather than a template built at the call site, because the punctuation
 * moves: French puts a space before the colon and Chinese uses a full-width one,
 * and a screen reader reads what the string actually says.
 */
export const CONDITION_A11Y_LABEL_KEY = "ui.condition.a11yLabel";

/** An OFFER whose source published no condition at all (#90). */
export const CONDITION_NOT_STATED_KEY = "ui.condition.notStated";

/** `The seller describes it as “%{label}”.` — #90 UI rule 4's source wording. */
export const CONDITION_SELLER_WORDING_KEY = "ui.condition.sellerWording";

/** The translation key for one taxonomy key's label. */
export function conditionLabelKey(key: ItemConditionKey): string {
  return CONDITION_LABEL_KEYS[key];
}

/** The translation key for one taxonomy key's plain-language explanation. */
export function conditionExplanationKey(key: ItemConditionKey): string {
  return CONDITION_EXPLANATION_KEYS[key];
}

/** The translation key for one segment's label. */
export function conditionGroupLabelKey(group: ConditionGroup): string {
  return CONDITION_GROUP_LABEL_KEYS[group];
}
