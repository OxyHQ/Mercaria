import type {
  PriceAlertComparisonBasis,
  PriceAlertSellerScope,
} from "@mercaria/shared-types";

/**
 * `PriceAlertCard`'s own copy (#437, #79's surface).
 *
 * ## The two vocabularies are exhaustive `Record`s, not ternary chains
 *
 * `basis` and `sellerScope` are closed unions in `@mercaria/shared-types`, and
 * they rendered as a two-branch ternary and a THREE-deep nested one whose last
 * `else` silently covered `any`. That shape has the defect the map exists to
 * remove: adding a fifth seller scope compiles, falls through to the final
 * branch, and tells a buyer their alert watches "any seller" when it does not.
 * A `Readonly<Record<Union, string>>` fails `tsc` on the member nobody added
 * copy for — which is the property #437 kept from option (1) and the reason
 * these maps live in this package rather than in each app.
 *
 * ## `splitChoice` has three answers here and two on the agent card
 *
 * `keep_both` exists for an alert and not for a shopping agent, because
 * watching two products for a price is coherent where running one agent against
 * both is not. Two separate key sets rather than one shared one: the sentences
 * differ ("this alert is paused" against "this agent is waiting"), and a single
 * set would have to be worded so blandly it described neither.
 */
export const PRICE_ALERT_BASIS_LABEL_KEYS: Readonly<
  Record<PriceAlertComparisonBasis, string>
> = {
  item_price: "ui.priceAlert.basis.item_price",
  known_total: "ui.priceAlert.basis.known_total",
};

export const PRICE_ALERT_SELLER_SCOPE_LABEL_KEYS: Readonly<
  Record<PriceAlertSellerScope, string>
> = {
  any: "ui.priceAlert.sellerScope.any",
  native_only: "ui.priceAlert.sellerScope.native_only",
  external_only: "ui.priceAlert.sellerScope.external_only",
  official_only: "ui.priceAlert.sellerScope.official_only",
};

export const PRICE_ALERT_ANY_CONDITION_KEY = "ui.priceAlert.card.anyCondition";
export const PRICE_ALERT_SCOPE_LINE_KEY = "ui.priceAlert.card.scopeLine";
export const PRICE_ALERT_LIST_SEPARATOR_KEY = "ui.priceAlert.card.listSeparator";
export const PRICE_ALERT_OPEN_PRODUCT_KEY = "ui.priceAlert.card.openProduct";
export const PRICE_ALERT_SAVED_PRODUCT_KEY = "ui.priceAlert.card.savedProduct";
export const PRICE_ALERT_TARGET_PREFIX_KEY = "ui.priceAlert.card.targetPrefix";
export const PRICE_ALERT_NOTIFIED_KEY = "ui.priceAlert.card.notified";
export const PRICE_ALERT_PAUSED_KEY = "ui.priceAlert.card.paused";
export const PRICE_ALERT_SPLIT_EXPLANATION_KEY = "ui.priceAlert.card.splitExplanation";
export const PRICE_ALERT_KEEP_SOURCE_KEY = "ui.priceAlert.card.keepSource";
export const PRICE_ALERT_MOVE_TO_TARGET_KEY = "ui.priceAlert.card.moveToTarget";
export const PRICE_ALERT_KEEP_BOTH_KEY = "ui.priceAlert.card.keepBoth";
export const PRICE_ALERT_PAUSE_KEY = "ui.priceAlert.card.pause";
export const PRICE_ALERT_PAUSE_A11Y_KEY = "ui.priceAlert.card.pauseA11y";
export const PRICE_ALERT_RESUME_KEY = "ui.priceAlert.card.resume";
export const PRICE_ALERT_RESUME_A11Y_KEY = "ui.priceAlert.card.resumeA11y";
export const PRICE_ALERT_DELETE_KEY = "ui.priceAlert.card.delete";
export const PRICE_ALERT_DELETE_A11Y_KEY = "ui.priceAlert.card.deleteA11y";
