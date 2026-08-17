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
 * short chip {@link COMMERCIAL_DISCLOSURE_LABEL_KEYS} or the sentence
 * {@link COMMERCIAL_DISCLOSURE_EXPLANATION_KEYS}.
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

import type { Translate } from "../i18n/create-app-i18n";
import type {
  CommercialDisclosureKey,
  CommercialPresentation,
  RetailCostBlockReason,
  RetailOfferUnquotedReason,
  RetailOrderProgressStage,
} from "@mercaria/shared-types";

/**
 * The chip text for one disclosure, as a TRANSLATION KEY (#490).
 *
 * The stored `CommercialDisclosureKey` is what a placed order's role snapshot
 * pins and what `commercialDisclosureKeys` decides; `ui.commercial.disclosure.*`
 * is a message id only a bundle resolves. Two identifiers for two jobs, which is
 * the split this file already existed for — #437's rule applied to the map that
 * was still holding sentences when `condition.ts` and `offer-labels.ts` stopped.
 */
export const COMMERCIAL_DISCLOSURE_LABEL_KEYS: Readonly<
  Record<CommercialDisclosureKey, string>
> = {
  sold_by_mercaria: "ui.commercial.disclosure.label.sold_by_mercaria",
  fulfilled_by_approved_partner: "ui.commercial.disclosure.label.fulfilled_by_approved_partner",
  sold_by_merchant: "ui.commercial.disclosure.label.sold_by_merchant",
  external_checkout: "ui.commercial.disclosure.label.external_checkout",
  affiliate_disclosure: "ui.commercial.disclosure.label.affiliate_disclosure",
  referral_disclosure: "ui.commercial.disclosure.label.referral_disclosure",
  supply_confirmation_pending: "ui.commercial.disclosure.label.supply_confirmation_pending",
  price_or_availability_changed: "ui.commercial.disclosure.label.price_or_availability_changed",
  procurement_failed_refund_pending:
    "ui.commercial.disclosure.label.procurement_failed_refund_pending",
  returns_and_warranty: "ui.commercial.disclosure.label.returns_and_warranty",
  tax_or_import_uncertainty: "ui.commercial.disclosure.label.tax_or_import_uncertainty",
  product_recall_or_safety_notice: "ui.commercial.disclosure.label.product_recall_or_safety_notice",
};

/** One sentence saying what the disclosure means for this buyer, as a KEY. */
export const COMMERCIAL_DISCLOSURE_EXPLANATION_KEYS: Readonly<
  Record<CommercialDisclosureKey, string>
> = {
  sold_by_mercaria: "ui.commercial.disclosure.explanation.sold_by_mercaria",
  fulfilled_by_approved_partner:
    "ui.commercial.disclosure.explanation.fulfilled_by_approved_partner",
  sold_by_merchant: "ui.commercial.disclosure.explanation.sold_by_merchant",
  external_checkout: "ui.commercial.disclosure.explanation.external_checkout",
  affiliate_disclosure: "ui.commercial.disclosure.explanation.affiliate_disclosure",
  referral_disclosure: "ui.commercial.disclosure.explanation.referral_disclosure",
  supply_confirmation_pending: "ui.commercial.disclosure.explanation.supply_confirmation_pending",
  price_or_availability_changed:
    "ui.commercial.disclosure.explanation.price_or_availability_changed",
  procurement_failed_refund_pending:
    "ui.commercial.disclosure.explanation.procurement_failed_refund_pending",
  returns_and_warranty: "ui.commercial.disclosure.explanation.returns_and_warranty",
  tax_or_import_uncertainty: "ui.commercial.disclosure.explanation.tax_or_import_uncertainty",
  product_recall_or_safety_notice:
    "ui.commercial.disclosure.explanation.product_recall_or_safety_notice",
};

/** The accessibility prefixes, which name the ROLE a value is playing. */
export const COMMERCIAL_A11Y_SELLER_KEY = "ui.commercial.a11ySeller";
export const COMMERCIAL_A11Y_DISCLOSURE_KEY = "ui.commercial.a11yDisclosure";

/**
 * The four consumer-rights windows, as ONE key with four slots.
 *
 * One key is one whole sentence: the clauses were four `+`-joined fragments
 * until #490, which is unorderable and untranslatable — a language that puts the
 * duration before the verb, or that inflects "days" by number, cannot be served
 * by concatenation. The NUMBERS still come from the presentation (#126's role
 * snapshot), so a copy change here can never restate what somebody agreed to.
 */
export const COMMERCIAL_RIGHTS_KEY = "ui.commercial.rights";

/** The chip text for one disclosure. */
export function commercialDisclosureLabel(t: Translate, key: CommercialDisclosureKey): string {
  return t(COMMERCIAL_DISCLOSURE_LABEL_KEYS[key]);
}

/** The full sentence for one disclosure. */
export function commercialDisclosureExplanation(
  t: Translate,
  key: CommercialDisclosureKey,
): string {
  return t(COMMERCIAL_DISCLOSURE_EXPLANATION_KEYS[key]);
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
export function commercialSellerLabel(
  t: Translate,
  presentation: CommercialPresentation,
): string {
  switch (presentation.mode) {
    case "mercaria_retail":
      return presentation.sellerLegalEntityName;
    case "connected_marketplace":
      return presentation.sellerLabel;
    case "external_referral":
      // The retailer's own NAME is data and is never translated; only the
      // fallback for "Mercaria resolved no retailer" is copy.
      return presentation.destinationMerchantLabel ?? t("ui.commercial.seller.externalFallback");
    case "informational":
      return t("ui.commercial.seller.notForSale");
  }
}

/** ADR 0004 D9.1's stages, as keys. */
export const RETAIL_ORDER_PROGRESS_LABEL_KEYS: Readonly<
  Record<RetailOrderProgressStage, string>
> = {
  awaiting_payment: "ui.commercial.progress.label.awaiting_payment",
  confirming_availability: "ui.commercial.progress.label.confirming_availability",
  confirmed: "ui.commercial.progress.label.confirmed",
  on_the_way: "ui.commercial.progress.label.on_the_way",
  delivered: "ui.commercial.progress.label.delivered",
  cancelled: "ui.commercial.progress.label.cancelled",
  partially_refunded: "ui.commercial.progress.label.partially_refunded",
  refunded: "ui.commercial.progress.label.refunded",
};

/**
 * What each stage means, in one sentence, as keys.
 *
 * `confirming_availability` is the load-bearing one and its wording is ADR 0004
 * D9.1's, near enough verbatim: the ADR states the truthful sentence and states
 * that "confirmed" may not be used until every purchase order is accepted. That
 * constraint now lives in the BUNDLES, which means it is a property a translator
 * has to preserve — the `condition.ts` docblock makes the same point about not
 * promising quality, for the same reason.
 */
export const RETAIL_ORDER_PROGRESS_EXPLANATION_KEYS: Readonly<
  Record<RetailOrderProgressStage, string>
> = {
  awaiting_payment: "ui.commercial.progress.explanation.awaiting_payment",
  confirming_availability: "ui.commercial.progress.explanation.confirming_availability",
  confirmed: "ui.commercial.progress.explanation.confirmed",
  on_the_way: "ui.commercial.progress.explanation.on_the_way",
  delivered: "ui.commercial.progress.explanation.delivered",
  cancelled: "ui.commercial.progress.explanation.cancelled",
  partially_refunded: "ui.commercial.progress.explanation.partially_refunded",
  refunded: "ui.commercial.progress.explanation.refunded",
};

/** The stage chip text. */
export function retailOrderProgressLabel(t: Translate, stage: RetailOrderProgressStage): string {
  return t(RETAIL_ORDER_PROGRESS_LABEL_KEYS[stage]);
}

/** The stage sentence. */
export function retailOrderProgressExplanation(
  t: Translate,
  stage: RetailOrderProgressStage,
): string {
  return t(RETAIL_ORDER_PROGRESS_EXPLANATION_KEYS[stage]);
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
export const RETAIL_BLOCK_REASON_EXPLANATION_KEYS: Readonly<
  Record<RetailCostBlockReason, string>
> = {
  destination_unknown: "ui.commercial.blockReason.destination_unknown",
  shipping_not_quotable: "ui.commercial.blockReason.shipping_not_quotable",
  undocumented_supplier_fee: "ui.commercial.blockReason.undocumented_supplier_fee",
  tax_undetermined: "ui.commercial.blockReason.tax_undetermined",
  market_not_supported: "ui.commercial.blockReason.market_not_supported",
  supplier_price_unavailable: "ui.commercial.blockReason.supplier_price_unavailable",
  fx_rate_unavailable: "ui.commercial.blockReason.fx_rate_unavailable",
  payment_cost_undetermined: "ui.commercial.blockReason.payment_cost_undetermined",
  component_not_permitted_by_policy: "ui.commercial.blockReason.component_not_permitted_by_policy",
  policy_missing: "ui.commercial.blockReason.policy_missing",
};

/** Why nothing has been quoted at all — #129's own fourth state. */
export const RETAIL_UNQUOTED_EXPLANATION_KEYS: Readonly<
  Record<RetailOfferUnquotedReason, string>
> = {
  no_current_quote: "ui.commercial.unquoted.no_current_quote",
  destination_not_supplied: "ui.commercial.unquoted.destination_not_supplied",
  retail_not_enabled: "ui.commercial.unquoted.retail_not_enabled",
};
