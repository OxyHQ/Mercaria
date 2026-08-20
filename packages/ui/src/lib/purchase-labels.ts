/**
 * `PurchaseOptions`'s own copy (#437).
 *
 * ## The frequency list is five WHOLE sentences and carries no number slot
 *
 * `Delivers every month` / `Delivers every 2 months` is a counted noun, and the
 * tempting extraction is one frame with a `%{months}`. That would need plural
 * forms — and the one-month case is not the plural-one form of the others in
 * several of the twelve, it is a different word order ("mensualmente",
 * "monatlich"). Five fixed keys have no agreement to get wrong and let each
 * language use its own idiom for the first one.
 *
 * The list stays module-scope and decorative: subscribe is not wired to
 * checkout, and these keys do not change that.
 *
 * ## Two labels are deliberately one key each, spoken and seen
 *
 * `One time purchase`, `Subscribe`, `Buy now` and `Subscribe now` each render as
 * both an `accessibilityLabel` and the visible text of the same control. One key
 * used twice rather than an `…A11y` twin: a control whose spoken name differs
 * from its printed name is what #442 exists to prevent, and here they are
 * genuinely the same words.
 */
export const PURCHASE_ONE_TIME_KEY = "ui.purchase.oneTime";
export const PURCHASE_SUBSCRIBE_KEY = "ui.purchase.subscribe";
export const PURCHASE_ADD_TO_CART_KEY = "ui.purchase.addToCart";
export const PURCHASE_SELECT_OPTIONS_KEY = "ui.purchase.selectOptions";
export const PURCHASE_BUY_NOW_KEY = "ui.purchase.buyNow";
export const PURCHASE_SUBSCRIBE_NOW_KEY = "ui.purchase.subscribeNow";

/**
 * Delivery frequencies, in the order they are offered.
 *
 * A `readonly` tuple rather than a `Record` over a union: there is no
 * `SubscriptionFrequency` type in `@mercaria/shared-types` to be exhaustive
 * over, because nothing in the commerce model has one — subscribe is decorative.
 * Inventing a union here would publish a vocabulary the backend does not have.
 */
export const PURCHASE_FREQUENCY_KEYS = [
  "ui.purchase.frequency.monthly",
  "ui.purchase.frequency.every2Months",
  "ui.purchase.frequency.every3Months",
  "ui.purchase.frequency.every4Months",
  "ui.purchase.frequency.every6Months",
] as const;
