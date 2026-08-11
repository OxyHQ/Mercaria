/**
 * The reader-facing copy for #129's commercial disclosures.
 *
 * The KEYS live in `@mercaria/shared-types` and are what a placed order's role
 * snapshot pins and what `commercialDisclosureKeys` decides; this file is the
 * part that is deliberately free to change — exactly as `condition.ts` is for
 * the #90 taxonomy and `offer-labels.ts` is for #74's comparison labels. A
 * disclosure's meaning is stable, its wording is not, and keeping the two apart
 * is what lets a copy correction apply to orders already placed rather than
 * requiring a rewrite of what those buyers recorded.
 *
 * ## One place decides a legal role
 *
 * #129 §"Content and legal copy" says outright: *do not scatter legal role
 * logic across individual components*. So a screen renders
 * `presentation.disclosures` — a list the SERVER composed — through these maps,
 * and never decides for itself that an offer needs an affiliate notice. The
 * only thing a component chooses is which of the two registers to read: the
 * short chip {@link COMMERCIAL_DISCLOSURE_LABELS} or the sentence
 * {@link COMMERCIAL_DISCLOSURE_EXPLANATIONS}.
 *
 * ## No sentence claims more than the server established
 *
 * `supply_confirmation_pending` says *we are confirming availability with our
 * fulfilment partner* because ADR 0004 D9.1 says that is what is true between
 * the charge and every purchase order being accepted, and specifically that the
 * word "confirmed" may not be used there. `price_or_availability_changed` and
 * `tax_or_import_uncertainty` are qualified for the same reason: the domain
 * refuses to certify a total it cannot compose, and a confident sentence over
 * an uncertain figure would be the surface making the claim the domain would
 * not.
 *
 * ## The partner is never named
 *
 * `fulfilled_by_approved_partner` is deliberately about *an approved partner*
 * and not about a company. ADR 0004 D2.8 discloses that the item ships from a
 * third party's stock and discloses the party's IDENTITY only where law
 * requires it, and the type a screen renders from carries no supplier name to
 * put in a sentence even if one were written here.
 */

import type {
  CommercialDisclosureKey,
  CommercialPresentation,
  RetailCostBlockReason,
  RetailOfferUnquotedReason,
  RetailOrderProgressStage,
} from "@mercaria/shared-types";

/** The short chip text for one disclosure. */
export const COMMERCIAL_DISCLOSURE_LABELS: Readonly<Record<CommercialDisclosureKey, string>> = {
  sold_by_mercaria: "Sold by Mercaria",
  fulfilled_by_approved_partner: "Fulfilled by an approved partner",
  sold_by_merchant: "Sold by the merchant",
  external_checkout: "Checkout on the retailer's own site",
  affiliate_disclosure: "We may earn a commission",
  referral_disclosure: "Shared through a partner link",
  supply_confirmation_pending: "Confirming availability",
  price_or_availability_changed: "Price or availability changed",
  procurement_failed_refund_pending: "Could not be sourced — refund on its way",
  returns_and_warranty: "Returns and warranty",
  tax_or_import_uncertainty: "Import charges may apply",
  product_recall_or_safety_notice: "Safety notice",
};

/** One sentence saying what the disclosure means for this buyer. */
export const COMMERCIAL_DISCLOSURE_EXPLANATIONS: Readonly<
  Record<CommercialDisclosureKey, string>
> = {
  sold_by_mercaria:
    "Mercaria is the seller for this item. Your contract, your payment and your returns are with Mercaria.",
  fulfilled_by_approved_partner:
    "An approved fulfilment partner ships this item from their own stock. Mercaria remains the seller.",
  sold_by_merchant:
    "This item is sold by the merchant named above. Mercaria processes the payment.",
  external_checkout:
    "You will finish this purchase on the retailer's own site. Mercaria does not take the payment, hold the order or handle the return.",
  affiliate_disclosure:
    "Mercaria may be paid a commission if you buy through this link. It does not change the price you pay, and it does not affect how offers are ordered.",
  referral_disclosure:
    "You arrived through a partner link. It does not change the price, the seller or your rights.",
  supply_confirmation_pending:
    "Payment received. We are confirming availability with our fulfilment partner before this order is confirmed.",
  price_or_availability_changed:
    "The price or availability of something in your basket has changed since you added it. Check it before paying.",
  procurement_failed_refund_pending:
    "We could not source this item. Your refund has already been started; it will reach the card you paid with.",
  returns_and_warranty:
    "Return it within the window shown, and the legal guarantee applies for the period shown.",
  tax_or_import_uncertainty:
    "Import duties or taxes may be charged on delivery for this destination. We cannot state a final amount.",
  product_recall_or_safety_notice:
    "There is a safety notice affecting this product. Do not use it before reading the notice.",
};

/** The chip text for one disclosure. */
export function commercialDisclosureLabel(key: CommercialDisclosureKey): string {
  return COMMERCIAL_DISCLOSURE_LABELS[key];
}

/** The full sentence for one disclosure. */
export function commercialDisclosureExplanation(key: CommercialDisclosureKey): string {
  return COMMERCIAL_DISCLOSURE_EXPLANATIONS[key];
}

/**
 * The seller a buyer reads, for one presentation.
 *
 * A `switch` over the union rather than a `sellerLabel` field, because the
 * union deliberately has no common one: a marketplace seller's display name and
 * Mercaria's legal entity are different facts about different parties, and one
 * accessor reading both is how they get swapped. `external_referral` returns
 * the destination retailer when Mercaria resolved one and a neutral phrase when
 * it did not — never "Mercaria", which is the one answer that would be wrong.
 */
export function commercialSellerLabel(presentation: CommercialPresentation): string {
  switch (presentation.mode) {
    case "mercaria_retail":
      return presentation.sellerLegalEntityName;
    case "connected_marketplace":
      return presentation.sellerLabel;
    case "external_referral":
      return presentation.destinationMerchantLabel ?? "Another retailer";
    case "informational":
      return "Not for sale here";
  }
}

/** ADR 0004 D9.1's stages, in the words a buyer reads. */
export const RETAIL_ORDER_PROGRESS_LABELS: Readonly<Record<RetailOrderProgressStage, string>> = {
  awaiting_payment: "Waiting for payment",
  confirming_availability: "Confirming availability",
  confirmed: "Confirmed",
  on_the_way: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
};

/**
 * What each stage means, in one sentence.
 *
 * `confirming_availability` is the load-bearing one and its wording is ADR 0004
 * D9.1's, near enough verbatim: the ADR states the truthful sentence and states
 * that "confirmed" may not be used until every purchase order is accepted.
 */
export const RETAIL_ORDER_PROGRESS_EXPLANATIONS: Readonly<
  Record<RetailOrderProgressStage, string>
> = {
  awaiting_payment: "We have not received your payment yet.",
  confirming_availability:
    "Payment received — we are confirming availability with our fulfilment partner.",
  confirmed: "Our fulfilment partner has accepted your order and is preparing it.",
  on_the_way: "Your order has left our fulfilment partner.",
  delivered: "Your order has been delivered.",
  cancelled: "This order was cancelled.",
  partially_refunded: "Part of this order has been refunded.",
  refunded: "This order has been refunded.",
};

/** The stage chip text. */
export function retailOrderProgressLabel(stage: RetailOrderProgressStage): string {
  return RETAIL_ORDER_PROGRESS_LABELS[stage];
}

/** The stage sentence. */
export function retailOrderProgressExplanation(stage: RetailOrderProgressStage): string {
  return RETAIL_ORDER_PROGRESS_EXPLANATIONS[stage];
}

/**
 * Why a Mercaria-retail price cannot be shown — #120's block reasons, in
 * customer language.
 *
 * Every sentence says what is MISSING and none says what the price would be.
 * That is #120's rule surviving into the copy layer: a blocked quote may not be
 * stored claiming an exact price, and a sentence like "roughly X" would put the
 * claim back on the screen the domain refused to make.
 */
export const RETAIL_BLOCK_REASON_EXPLANATIONS: Readonly<Record<RetailCostBlockReason, string>> = {
  destination_unknown: "Tell us where this is going and we can price it.",
  shipping_not_quotable: "We cannot get a delivery price for this destination right now.",
  undocumented_supplier_fee: "There is a cost we cannot account for, so we will not quote a total.",
  tax_undetermined: "We cannot determine the tax for this destination.",
  market_not_supported: "We cannot sell this item into that market.",
  supplier_price_unavailable: "We do not have a current price for this item.",
  fx_rate_unavailable: "We cannot convert this price into your currency right now.",
  payment_cost_undetermined: "We cannot determine the payment cost for this order.",
  component_not_permitted_by_policy: "Part of this item's cost is not one we may pass on.",
  policy_missing: "This item is not currently priced for sale.",
};

/** Why nothing has been quoted at all — #129's own fourth state. */
export const RETAIL_UNQUOTED_EXPLANATIONS: Readonly<Record<RetailOfferUnquotedReason, string>> = {
  no_current_quote: "We do not have a current price for this item.",
  destination_not_supplied: "Tell us where this is going and we can price it.",
  retail_not_enabled: "This item is not currently on sale.",
};
