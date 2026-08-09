/**
 * The reader-facing copy for the #90 condition taxonomy.
 *
 * The KEYS live in `@mercaria/shared-types` and never change; this file is the
 * part that is deliberately free to. #90's base taxonomy says the exact labels
 * are still to be finalized with localization and marketplace-policy review, so
 * keeping them out of shared-types is not tidiness — it is what makes "stored
 * keys remain stable when the copy changes" a fact about where the strings live
 * rather than a promise somebody keeps.
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
 * those is a thing a label can establish.
 */

import type { ConditionGroup, ItemConditionKey } from "@mercaria/shared-types";

/** The short label a badge and a picker row show. */
export const CONDITION_LABELS: Readonly<Record<ItemConditionKey, string>> = {
  new: "New",
  open_box: "Open box",
  refurbished_manufacturer: "Refurbished by the manufacturer",
  refurbished_seller: "Refurbished by the seller",
  used_like_new: "Used — like new",
  used_good: "Used — good",
  used_fair: "Used — fair",
  used_poor: "Used — poor",
  for_parts: "For parts or not working",
};

/** One sentence saying what the seller is actually claiming. */
export const CONDITION_EXPLANATIONS: Readonly<Record<ItemConditionKey, string>> = {
  new: "Unused and unopened, in the packaging the manufacturer shipped it in.",
  open_box: "Never used, but the packaging has been opened — a return or a display unit.",
  refurbished_manufacturer:
    "Restored and re-certified by the manufacturer or its authorised programme.",
  refurbished_seller: "Restored by the seller or a third party, who is named on this listing.",
  used_like_new: "Used, with no wear the seller can see at normal viewing distance.",
  used_good: "Used, with light wear the seller says does not affect how it works.",
  used_fair: "Used, with obvious wear or a fault the seller has described.",
  used_poor: "Used, heavily worn or with a described fault that affects using it.",
  for_parts: "Sold as not working — for repair, salvage or components.",
};

/** The label a filter facet and a price-history segment show. */
export const CONDITION_GROUP_LABELS: Readonly<Record<ConditionGroup, string>> = {
  new: "New",
  open_box: "Open box",
  refurbished: "Refurbished",
  used: "Used",
  for_parts: "For parts",
};

/**
 * The one sentence a condition badge must never let a shopper forget.
 *
 * #90 policy rule 7 in a string: the label is the seller's statement, not
 * Mercaria's verification of it. Surfaced beside the explanation on any surface
 * where a shopper is choosing between conditions.
 */
export const CONDITION_DISCLAIMER =
  "A condition is what the seller states about their own item. It is not a Mercaria guarantee.";

/** The label for one key. */
export function conditionLabel(key: ItemConditionKey): string {
  return CONDITION_LABELS[key];
}

/** The plain-language explanation for one key. */
export function conditionExplanation(key: ItemConditionKey): string {
  return CONDITION_EXPLANATIONS[key];
}

/** The label for one segment. */
export function conditionGroupLabel(group: ConditionGroup): string {
  return CONDITION_GROUP_LABELS[group];
}
