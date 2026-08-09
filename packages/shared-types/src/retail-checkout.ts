/**
 * Mercaria-retail checkout vocabulary (#123, ADR 0004 D4/D5/D7/D8/D9).
 *
 * The closed value sets the retail half of native checkout reads: why a retail
 * line may not be bought, what a durable procurement intent is, how a
 * procurement failure is classified, and the shape of the reconciliation input
 * #128 books.
 *
 * ## Everything here describes a COST or a REFUSAL, and nothing describes a margin
 *
 * That is the `RetailCostComponentKind` device (#120) applied one domain over.
 * There is no member anywhere in this file that could name a Mercaria profit, a
 * markup, an uplift, a service charge or a handling premium, and
 * {@link RETAIL_FORBIDDEN_CHECKOUT_OUTCOMES} states the prohibitions as values
 * disjoint from the outcomes that exist — so an addition that would create one
 * fails a test rather than passing review as a plausible new enum member.
 *
 * ## Why a refusal is a CODE and not a sentence
 *
 * `services/checkout/refusal.ts` (#106) already established that a refusal owes
 * an error CODE rather than message text, because #77's analytics classifies on
 * one and matching a sentence is how a copy edit silently empties a metric.
 * These are that vocabulary for the retail gate, and they are deliberately
 * COARSE on the buyer's side: a refusal tells a buyer their remedy (deselect
 * this item, change the destination, come back later) and never which supplier,
 * which stock level or which kill switch produced it.
 */

import type { CurrencyCode } from './money';

/**
 * Why one retail line may not enter native checkout — #123's ten-way
 * conjunction, as the ten answers it can give.
 *
 * Ordered as the issue lists them, and every one of them is a REFUSAL: there is
 * no `eligible` member, because eligibility is the other branch of a
 * discriminated union and cannot be spelled as a reason (the
 * `ProcurementAuthorizationRefusal` rule, #124).
 *
 *  1. `binding_inactive` — the offer/variant binding is retired or absent, so
 *     there is no current retail offer for this exact canonical variant.
 *  2. `not_eligible` — #121's verdict is `ineligible` OR `unknown`. The two are
 *     deliberately COLLAPSED here and only here: they route differently
 *     internally (an evidence queue versus a report of what Mercaria decided
 *     not to sell) and a buyer's remedy is identical, so distinguishing them in
 *     a refusal would publish Mercaria's compliance posture per item.
 *  3. `no_procurement_path` — no supplier account, agreement or procurement
 *     offer can serve this line.
 *  4. `destination_unsupported` — the market, destination or quantity is
 *     outside what the supply agreement and the offer permit.
 *  5. `supplier_stock_unknown` — #122 could not answer availability freshly
 *     enough for the selected policy. Never read as "in stock".
 *  6. `cost_incomplete` — #120 cannot produce a complete authoritative cost
 *     quote; an unknown direct cost is never zero (ADR 0004 D3).
 *  7. `currency_unsupported` — the presentment currency is outside what the
 *     rail may charge (ADR 0001 D8).
 *  8. `retail_disabled` — a supplier, market or platform kill switch is set,
 *     or `MERCARIA_RETAIL_ENABLED` is off. ONE code for every switch, so a
 *     client cannot map the switchboard one input at a time (ADR 0006's rule).
 *  9. `guest_not_eligible` — the signed-out buyer is outside the guest rollout
 *     for this exact supplier, market, destination, currency or fulfilment.
 * 10. `blocked` — a product, supplier, recall, moderation or risk block applies.
 */
export type RetailCheckoutRefusal =
  | 'binding_inactive'
  | 'not_eligible'
  | 'no_procurement_path'
  | 'destination_unsupported'
  | 'supplier_stock_unknown'
  | 'cost_incomplete'
  | 'currency_unsupported'
  | 'retail_disabled'
  | 'guest_not_eligible'
  | 'blocked';

/** {@link RetailCheckoutRefusal} as the tuple guards, DTOs and tests read. */
export const RETAIL_CHECKOUT_REFUSALS: readonly RetailCheckoutRefusal[] = [
  'binding_inactive',
  'not_eligible',
  'no_procurement_path',
  'destination_unsupported',
  'supplier_stock_unknown',
  'cost_incomplete',
  'currency_unsupported',
  'retail_disabled',
  'guest_not_eligible',
  'blocked',
];

/**
 * Outcomes a retail checkout may NEVER produce, named so the prohibition is a
 * value rather than a review comment.
 *
 * DISJOINT from every set in this file, asserted by
 * `retail-checkout-isolation.test.ts`. Each names a mechanism ADR 0004 forbids
 * outright, and the reason they are enumerated rather than merely absent is
 * that each is a plausible-sounding future addition:
 *
 *  - `surcharge_buyer` / `supplemental_charge` — D8.4: the charged amount never
 *    rises, in any branch, for any reason. There is no surcharge mechanism and
 *    nothing in #123–#128 may build one.
 *  - `apply_markup` / `apply_margin_target` — D3: markup and margin target are
 *    both zero and neither is a setting.
 *  - `retain_positive_variance` — D8.3: a positive variance is the customer's.
 *  - `transfer_to_supplier` — D6.8: a supplier is not a connected account and
 *    procurement never becomes a Connect transfer.
 *  - `book_commission` — D7 proof 1: no commission entry may reference a retail
 *    order.
 */
export type RetailForbiddenCheckoutOutcome =
  | 'surcharge_buyer'
  | 'supplemental_charge'
  | 'apply_markup'
  | 'apply_margin_target'
  | 'retain_positive_variance'
  | 'transfer_to_supplier'
  | 'book_commission';

/** {@link RetailForbiddenCheckoutOutcome} as the tuple the disjointness gate reads. */
export const RETAIL_FORBIDDEN_CHECKOUT_OUTCOMES: readonly RetailForbiddenCheckoutOutcome[] = [
  'surcharge_buyer',
  'supplemental_charge',
  'apply_markup',
  'apply_margin_target',
  'retain_positive_variance',
  'transfer_to_supplier',
  'book_commission',
];

/**
 * Where one durable procurement intent stands — #123's "create durable
 * procurement intent before submission".
 *
 * The intent is written IN the order's transaction at checkout and is the ONLY
 * input the procurement trigger reads, which is what makes "consume the exact
 * supplier/cost quote snapshotted at checkout" a property of the call graph: a
 * later catalogue, policy or supplier change cannot reach a placed order,
 * because nothing on this path re-reads any of them.
 *
 *  - `recorded` — composed and committed with the order; nothing has been
 *    requested of any supplier. The state every intent is born in, including
 *    on a deployment where procurement is switched off.
 *  - `requested` — the payment reached `paid` and the outbox row was enqueued.
 *  - `purchase_order_created` — #124 holds a PurchaseOrder for it. TERMINAL for
 *    this domain: everything after it is the purchase order's own state
 *    machine, and a second status here would be a second answer to a question
 *    `purchase_orders.status` already answers.
 *  - `failed` — procurement could not be started at all (an ineligible supply
 *    side at trigger time, an unregistered adapter). The compensating refund
 *    path owns what happens next.
 *  - `cancelled` — the order was cancelled or refunded before the intent was
 *    ever turned into a purchase order.
 */
export type RetailProcurementIntentStatus =
  | 'recorded'
  | 'requested'
  | 'purchase_order_created'
  | 'failed'
  | 'cancelled';

/** {@link RetailProcurementIntentStatus} as the tuple the columns and CHECKs read. */
export const RETAIL_PROCUREMENT_INTENT_STATUSES: readonly RetailProcurementIntentStatus[] = [
  'recorded',
  'requested',
  'purchase_order_created',
  'failed',
  'cancelled',
];

/**
 * Why procurement definitively failed, and therefore why a compensating refund
 * exists — ADR 0004's failure matrix, as the five causes it distinguishes.
 *
 * DEFINITIVE is the whole of what these mean. A retryable provider error, an
 * ambiguous submission and an unanswered poll are none of them: those are
 * #124's own machinery and produce no refund, because a buyer refunded for a
 * timeout that resolves an hour later has been refunded for goods that are on
 * their way.
 *
 *  - `supplier_rejected` — the supplier said no (out of stock, refused).
 *  - `acceptance_expired` — the acceptance deadline passed with no answer.
 *  - `cost_increase_over_cap` — the supplier re-priced beyond the policy's
 *    absorption cap. Within the cap Mercaria absorbs and this never fires:
 *    absorption is the DEFAULT and cancellation is the exception (D3).
 *  - `supply_side_ineligible` — the supplier, account or agreement stopped
 *    permitting this order between checkout and submission.
 *  - `operator_cancelled` — a person cancelled an unaccepted purchase order,
 *    which is the rollback runbook's bulk action (D4 concern 13).
 */
export type RetailProcurementFailureKind =
  | 'supplier_rejected'
  | 'acceptance_expired'
  | 'cost_increase_over_cap'
  | 'supply_side_ineligible'
  | 'operator_cancelled';

/** {@link RetailProcurementFailureKind} as the tuple the columns and CHECKs read. */
export const RETAIL_PROCUREMENT_FAILURE_KINDS: readonly RetailProcurementFailureKind[] = [
  'supplier_rejected',
  'acceptance_expired',
  'cost_increase_over_cap',
  'supply_side_ineligible',
  'operator_cancelled',
];

/**
 * Which way a reconciled actual cost moved against the locked customer amount —
 * ADR 0004 D8.3/D8.4.
 *
 * The two are NOT symmetric and the type says so by having them at all rather
 * than one signed number: a `customer_owed` delta becomes a customer adjustment
 * or an automatic refund, and an `absorbed` one becomes a Mercaria loss with no
 * customer-facing consequence whatsoever. Storing a sign and letting each
 * reader decide is how one of them eventually gets read as the other.
 *
 * `none` exists so a reconciliation that found NO variance is recordable.
 * Absence of a row and "the cost was exactly what we charged" are different
 * facts, and only the second is evidence.
 */
export type RetailCostVarianceDirection = 'none' | 'customer_owed' | 'absorbed';

/** {@link RetailCostVarianceDirection} as the tuple the columns and CHECKs read. */
export const RETAIL_COST_VARIANCE_DIRECTIONS: readonly RetailCostVarianceDirection[] = [
  'none',
  'customer_owed',
  'absorbed',
];

/**
 * What observed the actual cost this variance record compares against the lock.
 *
 * Named rather than free text because #128 reconciles one-to-one against these
 * sources, and "which document said so" is the first question an unmatched
 * variance raises.
 *
 *  - `supplier_acceptance` — the cost the supplier accepted the purchase order
 *    at, which is the earliest actual #123 can observe.
 *  - `purchase_order_cancelled` — procurement did not happen, so the
 *    attributable supplier cost is zero and the whole locked amount is owed
 *    back. The compensating-refund path records this, so the refund and the
 *    reconciliation input describe one event rather than two.
 */
export type RetailCostVarianceSource = 'supplier_acceptance' | 'purchase_order_cancelled';

/** {@link RetailCostVarianceSource} as the tuple the columns and CHECKs read. */
export const RETAIL_COST_VARIANCE_SOURCES: readonly RetailCostVarianceSource[] = [
  'supplier_acceptance',
  'purchase_order_cancelled',
];

/**
 * One recorded comparison of an actual cost against a locked customer amount —
 * the durable reconciliation input #128 BOOKS and #123 only OBSERVES.
 *
 * The division is exact and both halves matter. #123 can see an actual cost the
 * moment a supplier accepts, and losing that observation until an invoice
 * arrives weeks later would leave the surplus invisible for the whole window in
 * which a buyer might ask about it. But recognizing it — moving it to
 * `customer_adjustment`, deciding whether it clears the automatic-refund
 * threshold, disposing of it at finality — is a set of decisions D8 assigns to
 * #128, and a record #123 writes cannot pre-empt any of them.
 *
 * So this carries no account, no transaction and no threshold verdict. It says
 * what was locked, what it actually cost, which way the difference went, and
 * which document said so.
 */
export interface RetailCostVarianceRecord {
  id: string;
  orderId: string;
  purchaseOrderId: string | null;
  /** The #120 acceptance whose locked total this compares against. */
  acceptanceId: string;
  source: RetailCostVarianceSource;
  direction: RetailCostVarianceDirection;
  /** The locked customer amount, presentment side. Never changes. */
  lockedAmount: number;
  /** The attributable actual cost this source observed, in the same currency. */
  actualAmount: number;
  /**
   * `lockedAmount − actualAmount`, non-negative for `customer_owed` and
   * negative for `absorbed`. Stored rather than derived so a query answering
   * "what does Mercaria owe buyers" needs no arithmetic it could get wrong.
   */
  deltaAmount: number;
  currency: CurrencyCode;
  observedAt: string;
}
