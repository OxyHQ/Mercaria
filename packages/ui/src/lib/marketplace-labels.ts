/**
 * The remaining marketplace cards' own copy (#437's extraction tail).
 *
 * ## One module rather than seventeen, and one `visitMerchant` rather than five
 *
 * `Visit %{name}` was written out five times — `MerchantCard`, `MerchantHeader`
 * twice, `MerchantCartCard` and `NearbyLocationCard`. Five keys would be five
 * translations of one sentence, which is exactly the drift #437 rejected
 * option (1) over, one level down. The same goes for `noImage`, which two
 * different cards render.
 *
 * Copy that is genuinely per-component keeps its own prefix below, so a wording
 * change to one card cannot silently reword another.
 *
 * ## Nothing here counts a noun
 *
 * Four sites did: `1 offer`/`%{n} offers`, `%{n} verified ratings`,
 * `based on %{n} reviews`, and `Show %{n} more %{option} options`. All four are
 * labelled values now (`Offers: %{offers}`), for the reason recorded on
 * `BASKET_CARD_TALLY_KEY` — a ternary over two English words has no correct
 * form in `ru` or `ar`, and `%{count}` would move #436's pin.
 *
 * ## `reviewsEmpty` dropped a `.toLowerCase()` and that is a fix, not a loss
 *
 * It read `No ${scopeLabel.toLowerCase()} yet.` — case surgery on an
 * already-translated string. German capitalises every noun, and Turkish maps
 * `I` to a dotless `ı`, so the lowercasing was wrong in both before anything was
 * translated. The scope now enters a frame verbatim.
 */
export const MARKETPLACE_VISIT_MERCHANT_KEY = "ui.marketplace.visitMerchant";
export const MARKETPLACE_NO_IMAGE_KEY = "ui.marketplace.noImage";

/** `CanonicalProductCard`. */
export const CANONICAL_CARD_PRICES_UNAVAILABLE_KEY = "ui.canonicalCard.pricesUnavailable";
export const CANONICAL_CARD_NO_OFFERS_KEY = "ui.canonicalCard.noOffers";
export const CANONICAL_CARD_PRICE_IN_CURRENCY_KEY = "ui.canonicalCard.priceInCurrency";
export const CANONICAL_CARD_FROM_PRICE_KEY = "ui.canonicalCard.fromPrice";
export const CANONICAL_CARD_OFFER_LINE_KEY = "ui.canonicalCard.offerLine";

/** `Carousel`. */
export const CAROUSEL_PREVIOUS_KEY = "ui.carousel.previous";
export const CAROUSEL_NEXT_KEY = "ui.carousel.next";

/** `CartLineItem`. */
export const CART_SAVE_FOR_LATER_KEY = "ui.cart.saveForLater";

/** `CategoryCard`. */
export const CATEGORY_BROWSE_KEY = "ui.category.browse";

/** `ComparisonExplanationBlock`. */
export const COMPARISON_NO_SUMMARY_KEY = "ui.comparison.noSummary";

/** `MerchantCartCard`. */
export const MERCHANT_CART_CHECKOUT_KEY = "ui.merchantCart.checkout";
export const MERCHANT_CART_SUBTOTAL_KEY = "ui.merchantCart.subtotal";

/** `MerchantHeader`. */
export const MERCHANT_HEADER_VISIT_STORE_KEY = "ui.merchantHeader.visitStore";
export const MERCHANT_HEADER_MORE_OPTIONS_KEY = "ui.merchantHeader.moreOptions";

/** `NearbyLocationCard`. */
export const NEARBY_SOLD_BY_KEY = "ui.nearby.soldBy";
export const NEARBY_CHANNEL_KEY = "ui.nearby.channel";
export const NEARBY_SIGN_IN_KEY = "ui.nearby.signIn";
export const NEARBY_SIGN_IN_A11Y_KEY = "ui.nearby.signInA11y";
export const NEARBY_SELECT_AT_KEY = "ui.nearby.selectAt";

/** `PickupCollectionPanel`. */
export const PICKUP_PANEL_HEADING_KEY = "ui.pickupPanel.heading";
export const PICKUP_PANEL_CODE_HEADING_KEY = "ui.pickupPanel.codeHeading";
export const PICKUP_PANEL_CODE_A11Y_KEY = "ui.pickupPanel.codeA11y";
export const PICKUP_PANEL_CODE_NOTE_KEY = "ui.pickupPanel.codeNote";

/** `ProductCard`. */
export const PRODUCT_CARD_DISCOUNT_KEY = "ui.productCard.discount";
export const PRODUCT_CARD_SAVE_KEY = "ui.productCard.save";

/** `ProductGallery`. */
export const GALLERY_VIEW_IMAGE_KEY = "ui.gallery.viewImage";
export const GALLERY_PREVIOUS_KEY = "ui.gallery.previous";
export const GALLERY_NEXT_KEY = "ui.gallery.next";

/** `QuantityStepper`. */
export const QUANTITY_REMOVE_KEY = "ui.quantity.remove";
export const QUANTITY_DECREASE_KEY = "ui.quantity.decrease";
export const QUANTITY_INCREASE_KEY = "ui.quantity.increase";

/** `ReviewStars` and `ReviewSummaryCard`. */
export const REVIEW_DEFAULT_SCOPE_KEY = "ui.review.defaultScope";
export const REVIEW_STARS_A11Y_KEY = "ui.review.starsA11y";
export const REVIEW_STARS_SCOPED_A11Y_KEY = "ui.review.starsScopedA11y";
export const REVIEW_EMPTY_KEY = "ui.review.empty";
export const REVIEW_VERIFIED_RATINGS_KEY = "ui.review.verifiedRatings";
export const REVIEW_UNVERIFIED_KEY = "ui.review.unverified";
export const REVIEW_READ_MORE_KEY = "ui.review.readMore";

/** `SearchInterpretation`. */
export const SEARCH_CHIP_KEY = "ui.searchInterpretation.chip";
export const SEARCH_CHIP_PREFERENCE_KEY = "ui.searchInterpretation.chipPreference";
export const SEARCH_CHIP_REMOVE_KEY = "ui.searchInterpretation.chipRemove";
export const SEARCH_MODE_MODEL_KEY = "ui.searchInterpretation.modeModel";
export const SEARCH_MODE_RULES_KEY = "ui.searchInterpretation.modeRules";

/** `VariantSwatches`. */
export const SWATCH_SHOW_MORE_A11Y_KEY = "ui.variantSwatches.showMoreA11y";
export const SWATCH_SHOW_MORE_KEY = "ui.variantSwatches.showMore";
