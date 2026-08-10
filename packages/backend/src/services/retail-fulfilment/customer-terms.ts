/**
 * The consumer terms a `mercaria_retail` purchase is made under, and the
 * disclosure that accompanies it (#126 order-role snapshot items 2 and 8).
 *
 * CODE CONSTANTS with a version string, not a table, and the reason is the
 * `CATALOG_BACKFILL_MAPPING_VERSION` one: these are not policy an operator
 * publishes, they are what Mercaria's shipped customer terms SAY. A table would
 * let somebody publish a withdrawal window nobody's terms document contains,
 * and the row would then be snapshotted onto real orders as the terms those
 * buyers agreed to. Changing them is a code change, a new version string and a
 * review — which is what changing consumer terms should cost.
 *
 * ## The four windows are legal minima, not product settings
 *
 * ADR 0004 D2.6: *"the EU 14-day withdrawal right and Spain's three-year legal
 * conformity guarantee (LGDCU as amended by RDL 7/2021) are Mercaria's to
 * honour, whatever the supply agreement says about recourse"*. So none of these
 * is read from the supply agreement — an agreement's `returnsResponsibility`
 * and `warrantyResponsibility` describe Mercaria's RECOURSE against a supplier,
 * which is a different question from what the buyer is owed, and reading one
 * for the other is how a customer right becomes contingent on a B2B term.
 *
 * The snapshot stores the resolved numbers rather than only this version
 * string, because a version pointer is only as durable as the code that can
 * still resolve it: a buyer asking in two years what their return window was
 * must be answered from the order, not from whatever the constant says today.
 * The version travels beside them so the wording can be produced too.
 */

/**
 * The version of Mercaria's customer terms these windows are read from.
 *
 * Bump it in the same change that moves any window below, or a snapshot claims
 * numbers that version does not contain.
 */
export const RETAIL_CUSTOMER_TERMS_VERSION = '2026-08-10.1';

/**
 * How long a buyer may cancel a retail order before it is dispatched.
 *
 * Distinct from the statutory withdrawal right below: cancellation is asking
 * Mercaria to stop a purchase that has not left a warehouse, withdrawal is
 * returning goods already received. #126 §"State separation" example 6 turns on
 * exactly that distinction — *return-to-sender is not ordinary cancellation* —
 * and collapsing them here would be the first place the two stopped being
 * different.
 */
export const RETAIL_CANCELLATION_WINDOW_HOURS = 24;

/** EU statutory withdrawal, ADR 0004 D2.6. */
export const RETAIL_WITHDRAWAL_WINDOW_DAYS = 14;

/** Mercaria's own return policy. Never shorter than the statutory window. */
export const RETAIL_RETURN_WINDOW_DAYS = 30;

/** Spain's legal conformity guarantee (LGDCU as amended by RDL 7/2021). */
export const RETAIL_WARRANTY_MONTHS = 36;

/**
 * The supplier-fulfilment disclosure #117 selected, by key and version.
 *
 * ADR 0004 D2.8: the customer-facing terms and the offer UX disclose that the
 * item is *fulfilled by a third-party partner from the partner's stock*, and
 * the supplier's IDENTITY is disclosed only where law requires it. The KEY is
 * what #129 renders and what the snapshot pins; the words live in the client,
 * which is deliberate — a copy correction must not require rewriting what
 * placed orders recorded, and pinning the key rather than the sentence is what
 * makes both true at once.
 */
export const RETAIL_SUPPLIER_FULFILMENT_DISCLOSURE_KEY = 'retail.supplier_fulfilled.v1';
export const RETAIL_SUPPLIER_FULFILMENT_DISCLOSURE_VERSION = 1;

/**
 * A retail order's terms, as one value.
 *
 * Assembled here rather than spread at the call site so a future window has one
 * place to be added and one place to be reviewed.
 */
export interface RetailCustomerTerms {
  customerTermsVersion: string;
  cancellationWindowHours: number;
  withdrawalWindowDays: number;
  returnWindowDays: number;
  warrantyMonths: number;
  supplierFulfilmentDisclosureKey: string;
  supplierFulfilmentDisclosureVersion: number;
}

/** The terms in force. */
export function currentRetailCustomerTerms(): RetailCustomerTerms {
  return {
    customerTermsVersion: RETAIL_CUSTOMER_TERMS_VERSION,
    cancellationWindowHours: RETAIL_CANCELLATION_WINDOW_HOURS,
    withdrawalWindowDays: RETAIL_WITHDRAWAL_WINDOW_DAYS,
    returnWindowDays: RETAIL_RETURN_WINDOW_DAYS,
    warrantyMonths: RETAIL_WARRANTY_MONTHS,
    supplierFulfilmentDisclosureKey: RETAIL_SUPPLIER_FULFILMENT_DISCLOSURE_KEY,
    supplierFulfilmentDisclosureVersion: RETAIL_SUPPLIER_FULFILMENT_DISCLOSURE_VERSION,
  };
}
