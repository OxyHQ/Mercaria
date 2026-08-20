/**
 * `SavedItemCard`'s own copy (#437, #80's surface).
 *
 * ## `saveCount` is a labelled value, not a counted noun
 *
 * It rendered `%{n} people saved this`. #80 discloses that figure only at ten or
 * more, so English never sees `1 people` — but `ru` declines 10–20 one way and
 * 22 another, and `ar` has a different form again at 11 and at 100. The count
 * being large does not make it plural-free; it only hides the bug from the
 * language it was written in. `peopleSaved` is therefore a heading with a value
 * after it, which agrees with nothing.
 *
 * ## The no-offer reasons are a KEY function over an OPEN set
 *
 * `SavedOffer.reason` is a plain `string` — #80's absence reasons come off the
 * wire — so this cannot be an exhaustive `Record` the way a union-keyed map is.
 * {@link savedItemNoOfferKey} maps the four it knows and falls back to the
 * generic key, which is the same shape `comparisonUnknownTextKey` uses one
 * module over.
 *
 * Worth stating: these four sentences were inside a `switch` that RETURNED
 * copy, which is on check A's blind-spot list. Extracting them moves the
 * guard's count by nothing at all and takes four English sentences off the
 * screen.
 */
export const SAVED_ITEM_REMOVE_PRODUCT_KEY = "ui.savedItem.removeProduct";
export const SAVED_ITEM_REMOVE_LISTING_KEY = "ui.savedItem.removeListing";
export const SAVED_ITEM_SAVED_PRODUCT_KEY = "ui.savedItem.savedProduct";
export const SAVED_ITEM_SAVED_LISTING_KEY = "ui.savedItem.savedListing";
export const SAVED_ITEM_PINNED_LISTING_KEY = "ui.savedItem.pinnedListing";
export const SAVED_ITEM_CHEAPER_KEY = "ui.savedItem.cheaper";
export const SAVED_ITEM_DEARER_KEY = "ui.savedItem.dearer";
export const SAVED_ITEM_PEOPLE_SAVED_KEY = "ui.savedItem.peopleSaved";
export const SAVED_ITEM_SPLIT_CHOOSE_KEY = "ui.savedItem.splitChoose";
export const SAVED_ITEM_SPLIT_CHOOSE_A11Y_KEY = "ui.savedItem.splitChooseA11y";
export const SAVED_ITEM_SET_ALERT_KEY = "ui.savedItem.setAlert";
export const SAVED_ITEM_SET_ALERT_A11Y_KEY = "ui.savedItem.setAlertA11y";
export const SAVED_ITEM_UNAVAILABLE_KEY = "ui.savedItem.unavailable";
export const SAVED_ITEM_PRICE_UNPUBLISHED_KEY = "ui.savedItem.priceUnpublished";
export const SAVED_ITEM_PRICE_IN_CURRENCY_KEY = "ui.savedItem.priceInCurrency";
export const SAVED_ITEM_NO_OFFER_RECORDED_KEY = "ui.savedItem.noOffer.recorded";
export const SAVED_ITEM_NO_OFFER_RETIRED_KEY = "ui.savedItem.noOffer.retired";
export const SAVED_ITEM_NO_OFFER_FILTERED_KEY = "ui.savedItem.noOffer.filtered";
export const SAVED_ITEM_NO_OFFER_GENERIC_KEY = "ui.savedItem.noOffer.generic";

/** Why a saved product has nothing to buy, in the buyer's own language. */
export function savedItemNoOfferKey(reason: string): string {
  switch (reason) {
    case "no_offers_recorded":
      return SAVED_ITEM_NO_OFFER_RECORDED_KEY;
    case "all_offers_retired":
      return SAVED_ITEM_NO_OFFER_RETIRED_KEY;
    case "no_eligible_offer":
      return SAVED_ITEM_NO_OFFER_FILTERED_KEY;
    default:
      return SAVED_ITEM_NO_OFFER_GENERIC_KEY;
  }
}
