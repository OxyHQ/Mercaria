/**
 * Payment and ledger DTOs — the provider-neutral vocabulary.
 *
 * Every closed value set the payment domain uses is declared HERE, once, as a
 * `readonly` tuple plus the union derived from it. The Postgres CHECK
 * constraints, the drizzle column types and the service-level guards all read
 * these same tuples, so a value that exists in one place exists in all of them.
 *
 * Nothing in this file names a provider's own vocabulary. `pi_…`, `charge`,
 * `transfer_group` and every other Stripe noun stay behind the `PaymentProvider`
 * interface in the backend; a future rail plugs into the same seams without any
 * provider leaking into the domain.
 *
 * ## What this file is NOT
 *
 * It is not the buyer-facing payment surface. What a buyer may see about a
 * payment is `PaymentInfo` on the order (`./order`) — status, provider, an
 * optional reference and the payment's id. Amounts, ledger entries, provider
 * events, transfers and payouts are operator and merchant financial detail and
 * are never projected onto an order DTO.
 */

import type { Money } from './money';

/**
 * The payment rails Mercaria can record a payment against.
 *
 * A closed set, and deliberately a SHORT one: a provider is added here together
 * with the code that can produce a row for it and its migration widening the
 * CHECK, never in advance. FairCoin is not listed because nothing can write one:
 * it is not a payment method in this roadmap, and if it is introduced it arrives
 * through OxyPay — the Oxy gateway that accepts FairCoin — under its own ADR. A
 * value the database accepts but no code can produce is an invitation to write a
 * row nothing can ever reconcile.
 *
 *  - `external` — the payment happened on a connected platform (Shopify,
 *    WooCommerce). Mercaria records it so the order is explicable, and books NO
 *    ledger entries: no Mercaria money moved. ADR 0001 D12.
 *  - `manual_pos` — cash or a card terminal at a physical register. The money
 *    never passes through Mercaria, so this books no ledger entries either.
 *  - `mock` — `SyntheticPaymentProvider`, an in-memory deterministic
 *    implementation of the whole `PaymentProvider` interface. It is what the
 *    contract test suite runs and what the dev-only `mockPay` seam uses,
 *    hard-gated by `config.orders.mockPayEnabled` and off in production.
 *  - `stripe` — the card rail of ADR 0001. Added by #48, which builds the
 *    webhook ingress: a verified Stripe event is written to
 *    `payment_provider_events` under this id, so the id has to exist before the
 *    `PaymentProvider` adapter that CREATES payments (#47) does. That is not the
 *    "value in advance" the rule above forbids — #48 ships the code that writes
 *    `stripe` rows and the migration that lets it, together, and the events it
 *    stores are real.
 *
 * `external` and `manual_pos` have NO adapter, and that is the distinction the
 * set encodes: they are payments Mercaria RECORDS, not payments Mercaria makes.
 * Nothing is authorized, captured or refunded through them, and neither books a
 * ledger entry — no Mercaria money moved.
 */
export type PaymentProviderId = 'external' | 'manual_pos' | 'mock' | 'stripe';

/** {@link PaymentProviderId} as the tuple the column types and CHECKs read. */
export const PAYMENT_PROVIDER_IDS: readonly PaymentProviderId[] = [
  'external',
  'manual_pos',
  'mock',
  'stripe',
];

/**
 * The payment state an ORDER carries — the coarse, buyer-safe projection.
 *
 * Deliberately NOT the same set as {@link PaymentStatus}, and deliberately not
 * merged into it. This one answers "may this order be fulfilled, and is money
 * owed back", which is what a buyer, a seller and the fulfilment path each need;
 * the aggregate's status answers "where is this payment in its own lifecycle",
 * which is operator detail. Collapsing them would put `requires_action` — a fact
 * about a provider's SCA challenge — into the order-status vocabulary every
 * report, notification and dashboard filter reads.
 */
export type OrderPaymentStatus = 'unpaid' | 'authorized' | 'paid' | 'refunded' | 'failed';

/** {@link OrderPaymentStatus} as the tuple the column types and CHECKs read. */
export const ORDER_PAYMENT_STATUSES: readonly OrderPaymentStatus[] = [
  'unpaid',
  'authorized',
  'paid',
  'refunded',
  'failed',
];

/**
 * The lifecycle of a payment AGGREGATE — Mercaria's own state, never a
 * provider's.
 *
 * Provider vocabularies differ and change; this set is the intersection every
 * rail can be mapped onto, and the adapter owns the mapping. `succeeded` means
 * the money is captured and Mercaria has verified it from a provider EVENT — a
 * client request can never assert it (issue #45 invariant 6).
 *
 * `refunded` and `partially_refunded` are reached only from `succeeded`: they
 * describe money coming back, which requires money to have arrived.
 */
export type PaymentStatus =
  | 'created'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'refunded'
  | 'partially_refunded';

/** {@link PaymentStatus} as the tuple the column types and CHECKs read. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'created',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded',
];

/**
 * The outcome of ONE provider authorization or confirmation attempt.
 *
 * An attempt is an append-only record of a call Mercaria made, so it has no
 * `canceled`: a cancelled PAYMENT is a payment-level fact, while an attempt
 * either is still running, worked, or did not.
 */
export type PaymentAttemptStatus = 'pending' | 'succeeded' | 'failed';

/** {@link PaymentAttemptStatus} as the tuple the column types and CHECKs read. */
export const PAYMENT_ATTEMPT_STATUSES: readonly PaymentAttemptStatus[] = [
  'pending',
  'succeeded',
  'failed',
];

/**
 * How far an inbound provider event has got through Mercaria's own processing.
 *
 * RECEIPT is separate from PROCESSING on purpose: the event row is committed the
 * moment the signature verifies, before anything is interpreted. A provider that
 * gets a 200 has been told "stored", never "understood" — so a bug in the
 * handler retries against a durable copy instead of losing the event to a
 * provider's finite redelivery schedule.
 */
export type ProviderEventStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'dead_letter';

/** {@link ProviderEventStatus} as the tuple the column types and CHECKs read. */
export const PROVIDER_EVENT_STATUSES: readonly ProviderEventStatus[] = [
  'received',
  'processing',
  'processed',
  'failed',
  'dead_letter',
];

/**
 * A transfer's lifecycle — Mercaria paying one seller order out of a settled
 * charge (ADR 0001 D3: one transfer per seller order).
 *
 * `reversed` is a state and `reversed_amount_minor` is the quantity, because a
 * reversal is routinely PARTIAL (a partial refund reverses the seller's
 * proportional share). A boolean here would make a half-reversed transfer
 * unrepresentable.
 */
export type TransferStatus = 'pending' | 'paid' | 'failed' | 'reversed' | 'canceled';

/** {@link TransferStatus} as the tuple the column types and CHECKs read. */
export const TRANSFER_STATUSES: readonly TransferStatus[] = [
  'pending',
  'paid',
  'failed',
  'reversed',
  'canceled',
];

/**
 * A payout's lifecycle — the provider moving a seller's balance to their bank.
 *
 * Mercaria records these to show payout health and correlate seller support
 * requests (ADR 0001 D7). It is not a party to the movement: a failed payout
 * does NOT reopen the merchant receivable, which was settled when the transfer
 * was created (D6).
 */
export type PayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';

/** {@link PayoutStatus} as the tuple the column types and CHECKs read. */
export const PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'pending',
  'in_transit',
  'paid',
  'failed',
  'canceled',
];

/**
 * Where a REFUND stands at the payment rail — distinct from where the payment
 * stands, and from where Mercaria's own refund record stands.
 *
 * Three states of one refund are genuinely three different facts and none of
 * them can stand in for the others. {@link RefundStatus} (`./refund`) is the
 * commerce lifecycle: what was approved, what came back on the shelf. This one
 * is the money leaving the platform balance. And {@link PaymentStatus} is the
 * payment aggregate, which a partial refund does not move at all.
 *
 * Mercaria commits the commerce record FIRST and moves the money afterwards
 * (ADR 0001 D7: the refund domain owns *what* is refundable, the rail records
 * the movement), so `pending` is the ordinary state of a refund that has been
 * approved and not yet paid out — not an error, and not something a buyer or a
 * merchant should be shown as complete.
 *
 * `canceled` is the rail's own: Stripe cancels a refund it could not deliver to
 * a closed account before it ever settles. It is separate from `failed` because
 * a cancelled refund never left, while a failed one bounced back.
 */
export type RefundProviderState = 'pending' | 'succeeded' | 'failed' | 'canceled';

/** {@link RefundProviderState} as the tuple the column types and CHECKs read. */
export const REFUND_PROVIDER_STATES: readonly RefundProviderState[] = [
  'pending',
  'succeeded',
  'failed',
  'canceled',
];

/**
 * Where the SELLER-side recovery of a refund stands.
 *
 * A buyer refund on a settled order is two movements, not one: Mercaria returns
 * the money to the buyer and reverses the seller's proportional share of that
 * order's transfer to recover it (ADR 0001 D7). The second can fail where the
 * first did not — an insufficient seller balance with no reserve behind it — and
 * the ADR is explicit that the buyer's refund is **not** blocked on it. So the
 * two states are carried separately, because "the buyer has their money" and
 * "Mercaria has recovered it" are independently true.
 *
 * `not_required` is the honest state for a refund with no seller money to
 * recover: the transfer was never made (it was withheld, or the payment never
 * settled), so the seller's receivable is still open and the refund posting
 * closes it directly. Collapsing that onto `succeeded` would claim a recovery
 * that never happened; onto `failed` it would raise an exception nobody can act
 * on.
 */
export type RefundReversalState = 'not_required' | 'pending' | 'succeeded' | 'failed';

/** {@link RefundReversalState} as the tuple the column types and CHECKs read. */
export const REFUND_REVERSAL_STATES: readonly RefundReversalState[] = [
  'not_required',
  'pending',
  'succeeded',
  'failed',
];

/**
 * A dispute's lifecycle — a buyer's bank reversing a charge through the card
 * network, which is not a refund and not a moderation case.
 *
 * `warning` is first and is the one that must not be collapsed into the others.
 * Some networks raise an INQUIRY before a chargeback: it carries a deadline and
 * needs evidence, and **no money moves**. Booking a ledger entry for one would
 * debit a platform balance nothing debited, and recovering the "principal" from
 * the seller would take money for a dispute that does not exist yet. What tells
 * the two apart is not the status string but whether the rail reported a balance
 * movement, which is what the backend reads.
 *
 * There is deliberately no `closed` beyond `won` and `lost`: a dispute that
 * closed without an outcome is one the platform withdrew from, which the rail
 * reports as `lost` because the money stays with the buyer either way.
 */
export type DisputeStatus = 'warning' | 'needs_response' | 'under_review' | 'won' | 'lost';

/** {@link DisputeStatus} as the tuple the column types and CHECKs read. */
export const DISPUTE_STATUSES: readonly DisputeStatus[] = [
  'warning',
  'needs_response',
  'under_review',
  'won',
  'lost',
];

/**
 * How a dispute ENDED, which is a different question from where it is.
 *
 * Carried beside {@link DisputeStatus} rather than derived from it because the
 * two are read by different consumers: an operator queue asks "is this still
 * open", the ledger reconciliation asks "who won". A closed dispute with no
 * outcome would be invisible to both, which is why the backend holds the pair
 * together with a CHECK rather than trusting whoever writes the update.
 */
export type DisputeOutcome = 'won' | 'lost';

/** {@link DisputeOutcome} as the tuple the column types and CHECKs read. */
export const DISPUTE_OUTCOMES: readonly DisputeOutcome[] = ['won', 'lost'];

/**
 * Mercaria's chart of accounts. Twelve accounts, and no more without a decision.
 *
 * ## The sign convention, stated once
 *
 * A ledger entry's `amountMinor` is SIGNED: **positive is a debit, negative is a
 * credit**, and every transaction sums to exactly zero PER CURRENCY. There is no
 * separate `direction` column, because two representations of one fact can
 * disagree — a `direction: 'credit'` beside a positive amount is a row nobody
 * can interpret, and nothing in a schema can stop it being written.
 *
 * Under that convention each account has a NORMAL BALANCE, which is what its
 * sign means in plain language:
 *
 * | Account | Normal balance | A positive (debit) entry means |
 * |---|---|---|
 * | `provider_clearing` | debit | funds arrived on the platform balance |
 * | `merchant_payable` | credit | a seller's receivable was reduced or settled |
 * | `commission_revenue` | credit | Mercaria's commission was reduced (a refund) |
 * | `processor_expense` | debit | a provider fee was incurred |
 * | `refunds` | debit | money was returned to a buyer |
 * | `disputes` | debit | a disputed amount was debited from the platform |
 * | `reserves` | debit | funds were withheld from a seller |
 * | `retail_cost_recovery` | credit | a buyer paid Mercaria's own costs back on a `mercaria_retail` order |
 * | `supplier_prepaid` | debit | Mercaria's money on deposit with a supplier grew (a top-up, a credit) or shrank (a purchase-order draw) |
 * | `platform_funds` | credit | Mercaria's own out-of-band cash entered or left the payment domain |
 * | `procurement_expense` | debit | goods or fulfilment cost was incurred for a retail order |
 * | `customer_adjustment` | credit | a positive cost variance is owed back to a buyer and not yet refunded |
 *
 * ## The five retail accounts, and why they landed across two issues
 *
 * ADR 0004 D7 names five and assigns them to #128 "together with the code that
 * writes them". #123 was that code for exactly one of them: a retail order's
 * share of a charge has to be credited SOMEWHERE the moment the charge is
 * booked, because `chargeSucceeded` defines Mercaria's commission as
 * `gross − Σ(seller nets)` and a retail order has no seller net. Leaving it out
 * would not have left it unbooked — it would have booked the whole retail share
 * as `commission_revenue`, which is D7 proof 1 broken in the direction that
 * reads as margin on a zero-markup sale.
 *
 * #128 is that code for the other four, and the rule held rather than being
 * waived: each arrives together with the posting builder that writes it
 * (`prefundTopUp`, `procurementSettled`, `directFulfilmentCost`,
 * `retailVarianceRecognized`, `customerAdjustmentRefunded` and
 * `supplierCreditReceived` in `services/payments/ledger-postings.ts`) and with
 * the migration that widens this CHECK, in one change.
 *
 * `retail_cost_recovery` is credit-normal and bounded by cost BY CONSTRUCTION
 * rather than by a constraint: nothing may credit it beyond what the buyer paid,
 * and every excess over actual cost is extracted to `customer_adjustment` before
 * finality (D8.3). There is deliberately no `retail_margin_revenue`, so a
 * positive variance has no account to be recognized as revenue in.
 *
 * ## Which accounts are carried PER OWNER, and the one that deliberately is not
 *
 * `merchant_payable` names the seller (`ownerType` + `ownerId`) and usually the
 * order, because "what do we owe this seller for this order" is the question the
 * account exists to answer. `supplier_prepaid` names the SUPPLIER whose deposit
 * it is, for the same reason and under its own owner type.
 *
 * `customer_adjustment` is carried per ORDER — the entry's existing `order_id`
 * column — and NOT per buyer, which is a privacy decision rather than an
 * omission. A guest buyer's credential is purged on its own retention clock, and
 * any per-buyer handle in a permanently retained financial record is a
 * correlation key wearing an owner id (#106 identity rule 11). The order is the
 * durable thing the money is about, and it resolves to a buyer only through the
 * paths that are already authorized to make that resolution.
 *
 * The remaining accounts are platform-wide and leave both owner columns NULL.
 *
 * There is deliberately no buyer-funds account. Mercaria is the merchant of
 * record (ADR 0001 D1) and never holds a buyer balance; money arrives already
 * captured, which `provider_clearing` is exactly the name for.
 */
export type LedgerAccount =
  | 'provider_clearing'
  | 'merchant_payable'
  | 'commission_revenue'
  | 'processor_expense'
  | 'refunds'
  | 'disputes'
  | 'reserves'
  | 'retail_cost_recovery'
  | 'supplier_prepaid'
  | 'platform_funds'
  | 'procurement_expense'
  | 'customer_adjustment';

/** {@link LedgerAccount} as the tuple the column types and CHECKs read. */
export const LEDGER_ACCOUNTS: readonly LedgerAccount[] = [
  'provider_clearing',
  'merchant_payable',
  'commission_revenue',
  'processor_expense',
  'refunds',
  'disputes',
  'reserves',
  'retail_cost_recovery',
  // ADR 0004 D7's four procurement accounts, landed by #128 with the builders
  // that write them.
  'supplier_prepaid',
  'platform_funds',
  'procurement_expense',
  'customer_adjustment',
];

/**
 * The accounts a `mercaria_retail` order's money may EVER be credited to — ADR
 * 0004 D7 proof 1, as a value a test can run rather than a paragraph.
 *
 * Stated positively and kept beside the chart itself, because the thing it
 * defends is an omission: `commission_revenue` is not in it, and cannot be
 * added without this line changing in the same diff as whatever made it
 * necessary.
 */
export const RETAIL_REVENUE_SIDE_ACCOUNTS: readonly LedgerAccount[] = [
  'retail_cost_recovery',
  // #128: recognizing a positive variance CREDITS this and DEBITS
  // `retail_cost_recovery` by the same amount, which is what makes recovery
  // bounded by cost at finality (D7 proof 2) an arithmetic fact rather than an
  // intention. It is on the credit side of a retail order's movements and
  // therefore belongs in this list — and it is not revenue: it is a liability to
  // the buyer, which is precisely why the surplus cannot be reported as margin.
  'customer_adjustment',
];

/**
 * Accounts that may never carry an entry naming a `mercaria_retail` order.
 *
 * `commission_revenue` — ADR 0004 D7 proof 1: Mercaria earns no commission on
 * its own retail sale, and there is no schedule that could produce one (#88's
 * `mercaria_retail` mode snapshots a NULL fee, never a zero).
 * `merchant_payable` — a retail order has no connected seller to owe; a payable
 * for one would be settled to somebody by the settlement step.
 */
export const RETAIL_FORBIDDEN_ACCOUNTS: readonly LedgerAccount[] = [
  'commission_revenue',
  'merchant_payable',
];

/**
 * Who an owned entry names — a business store, a P2P seller, or a supplier.
 *
 * The first two are the kinds `Order.sellerType` distinguishes, named the same
 * way, so a `merchant_payable` row and the order it came from can be joined
 * without a translation table.
 *
 * `supplier` is #128's, for `supplier_prepaid`. It is a THIRD kind rather than a
 * reuse of `store`: a supplier is Mercaria's B2B counterparty and has no
 * storefront, no connected account and no order on this marketplace (ADR 0004
 * D2.2/D6.8), so filing its deposit under a seller kind would put a wholesale
 * balance into the key space every payable query reads.
 */
export type LedgerOwnerType = 'store' | 'user' | 'supplier';

/** {@link LedgerOwnerType} as the tuple the column types and CHECKs read. */
export const LEDGER_OWNER_TYPES: readonly LedgerOwnerType[] = ['store', 'user', 'supplier'];

/**
 * What a ledger transaction records. One kind per row in ADR 0001's
 * "Ledger representability" table, and nothing that is not in it.
 *
 * `adjustment` is the operator escape hatch, and it is NOT a licence to edit
 * history: entries are append-only, so a correction is a new transaction whose
 * entries reverse the ones that were wrong (#45 invariant 2).
 *
 * ## The four procurement kinds (ADR 0004 D7, landed by #128)
 *
 * `prefund_top_up`, `procurement_settled`, `retail_variance` and
 * `supplier_credit` are the retail movements that are not also marketplace ones.
 * Retail charges and refunds deliberately do NOT get kinds of their own — they
 * reuse `charge_succeeded` and `refund`, because they are the same physical
 * events on the same rail and a separate kind would make every payment query
 * ask which sort of sale it was.
 *
 * `retail_variance` covers BOTH the recognition of a positive variance and the
 * refund that discharges it, which are two transactions of one kind rather than
 * two kinds: the pair has to net to zero on `customer_adjustment` for the
 * obligation to be closed, and reading that off one kind is what makes it a
 * query.
 */
export type LedgerTransactionKind =
  | 'charge_succeeded'
  | 'transfer_created'
  | 'refund'
  | 'transfer_reversal'
  | 'dispute_created'
  | 'dispute_won'
  | 'dispute_lost'
  | 'adjustment'
  | 'prefund_top_up'
  | 'procurement_settled'
  | 'retail_variance'
  | 'supplier_credit';

/** {@link LedgerTransactionKind} as the tuple the column types and CHECKs read. */
export const LEDGER_TRANSACTION_KINDS: readonly LedgerTransactionKind[] = [
  'charge_succeeded',
  'transfer_created',
  'refund',
  'transfer_reversal',
  'dispute_created',
  'dispute_won',
  'dispute_lost',
  'adjustment',
  // ADR 0004 D7's four, landed by #128 — see the note above.
  'prefund_top_up',
  'procurement_settled',
  'retail_variance',
  'supplier_credit',
];

/**
 * The domain events the payment outbox delivers.
 *
 * These carry Mercaria ids and Mercaria's own state only — never a provider
 * payload, never a secret, never a raw contact value (#45 API and events 6
 * and 8). A consumer that needs provider detail reads the operator surface
 * (#50) with its own authorization; it does not get it for free by subscribing
 * to an event.
 *
 * ## `payment_succeeded_after_release` is an EXCEPTION, not a lifecycle step
 *
 * The provider reported a capture for a payment Mercaria had already given up
 * on — the reservation timed out, the orders were cancelled and the stock went
 * back. Money arrived for goods nobody is holding, and no automatic answer is
 * correct: recommitting inventory that may have been sold since would oversell,
 * and refunding without a human deciding is a policy call the payment domain
 * does not get to make. So this event exists to make the condition DURABLE and
 * visible to the operator surface (#50), and its handler deliberately changes no
 * order, no inventory and no ledger.
 *
 * It is a separate type rather than a flag on `payment_succeeded` because the
 * two have opposite consequences: one fulfils an order, the other must not.
 *
 * ## `transfer_withheld` is the OTHER exception, and it is per ORDER
 *
 * The charge succeeded and the buyer is paid up, but one seller's share cannot
 * leave: their account lost readiness between funding and settlement, or the
 * rail refused the movement outright. ADR 0001 D4 is explicit that this must not
 * un-pay the order and must not block its siblings — Mercaria's controlled
 * analog of the "skipped transfer" a destination charge would produce — so the
 * settlement step records this and carries on with the next order.
 *
 * It is per order rather than per payment because that is the grain a resolution
 * acts on: one seller recovers their account and their transfer is made, while
 * another's is refunded, out of the same charge.
 *
 * ## `provider_account_changed` is about a SELLER, not a payment
 *
 * The one event here whose payload names no payment. A seller's standing with a
 * rail changing is a payment-domain consequence — it decides whether their next
 * checkout is permitted at all (ADR 0001 D4/D9) — and it needs the same durable,
 * at-least-once delivery every other consequence gets, so it rides the same
 * outbox rather than growing a second one. Its payload is the provider-account
 * row id plus the two states it moved between, which is the whole of what a
 * consumer can act on without re-reading.
 *
 * ## `payment_refunded` is WORK, where its neighbours are announcements
 *
 * Most types here say a thing HAS happened. This one says a refund record has
 * committed and its money has not moved yet: its handler is what calls the rail,
 * books the refund and reverses the seller's share (ADR 0001 D7). That is
 * deliberate rather than an inconsistency — a refund whose provider call lives
 * in the request that created it evaporates when the task restarts, and the
 * commerce record (with its restock already done) would be left claiming money
 * had gone back to a buyer who never received it.
 *
 * ## Three exceptions belong to the refund and dispute path (#49)
 *
 * Each is a distinct operator ACTION, which is why each is its own type rather
 * than a reason code on one:
 *
 *  - `refund_failed` — the rail refused or failed the BUYER's refund after
 *    Mercaria's own record had committed and restocked. The commerce state and
 *    the money now disagree, and only a person can decide which one moves.
 *  - `reversal_failed` — the buyer has their money and the seller's share could
 *    not be recovered (an insufficient balance, a restricted account). ADR 0001
 *    D7 is explicit that this must NOT block the buyer's refund, so the gap is
 *    booked honestly — the order's `merchant_payable` stays open in Mercaria's
 *    favour — and recovery is a decision, not a retry.
 *  - `refund_unmatched` — the rail reported a refund Mercaria never made (a
 *    dashboard refund, an issuer-forced one). It is NOT turned into a local
 *    refund: that would restock goods nobody returned and decrement a customer's
 *    lifetime spend for a decision Mercaria did not take.
 *
 * ## `guest_portal_initialization` is a HANDOFF, and the reason it is a row
 *
 * ADR 0006 G13: verified payment success on a guest-origin group has to produce
 * post-purchase access — the `post_checkout` portal grant and the confirmation
 * email #108 owns. #107 emits this row and creates no credential, and the two
 * halves of that sentence are the same decision: a grant token minted inside
 * payment processing would exist while the PaymentIntent's metadata is being
 * composed, and B4 says no token may ever be in a position to reach it. Minting
 * strictly AFTER a verified event, from a consumer of this row, is what makes
 * "it cannot be in metadata" a fact about the call graph rather than a rule
 * somebody has to remember.
 *
 * Its id is derived from the CHECKOUT GROUP, so a redelivered provider event, a
 * reclaimed lease and a reconciliation sweep re-deriving the same success all
 * converge on one row — which is what "one secure guest-portal initialization
 * event" (#107 acceptance 10) means mechanically, rather than one per delivery.
 *
 * ## `procurement_requested` is WORK, and it is where ADR 0004 D4 step 4 lands
 *
 * A `mercaria_retail` order reaching `paid` is the ONE moment supplier
 * procurement may begin: the customer's money is fully captured and the
 * customer amount can never rise again. The row carries the durable procurement
 * INTENT this checkout composed — one row per (order, supplier) — and its
 * handler turns that intent into a PurchaseOrder through #124's idempotent
 * orchestration. It is work rather than an announcement for the
 * `payment_refunded` reason: a supplier call living in the webhook handler
 * evaporates on a restart, leaving a paid order nobody ever procured.
 *
 * The direction is deliberate and one-way. Procurement is triggered BY payment
 * state and never the reverse — a supplier's acceptance is not payment truth
 * (ADR 0004 D1) — which is why there is no `procurement_accepted` type here.
 *
 * ## `retail_procurement_failed` is the compensating refund, and it is an EXCEPTION
 *
 * ADR 0004 D4 step 5: every procurement failure — rejection, stock-out,
 * timeout, an over-cap cost increase, a partial failure — resolves through the
 * EXISTING refund domain rather than a new primitive. This row is what carries
 * a #124 failure across the wall into that domain, and its handler creates the
 * compensating refund (full, or of the affected lines) exactly once.
 *
 * Its id carries the PURCHASE ORDER, not the failure delivery: a re-delivered
 * supplier rejection describes the same failed procurement, and a refund per
 * delivery would return the buyer's money twice.
 */
export type PaymentOutboxEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_succeeded_after_release'
  | 'payment_refunded'
  | 'payment_disputed'
  | 'transfer_changed'
  | 'transfer_withheld'
  | 'payout_changed'
  | 'provider_account_changed'
  | 'refund_failed'
  | 'reversal_failed'
  | 'refund_unmatched'
  | 'guest_portal_initialization'
  | 'procurement_requested'
  | 'retail_procurement_failed';

/** {@link PaymentOutboxEventType} as the tuple the column types and CHECKs read. */
export const PAYMENT_OUTBOX_EVENT_TYPES: readonly PaymentOutboxEventType[] = [
  'payment_succeeded',
  'payment_failed',
  // The two exceptions, not lifecycle steps — see the notes above.
  'payment_succeeded_after_release',
  'transfer_withheld',
  'payment_refunded',
  'payment_disputed',
  'transfer_changed',
  'payout_changed',
  'provider_account_changed',
  // #49's three, all exceptions — see the notes above.
  'refund_failed',
  'reversal_failed',
  'refund_unmatched',
  // #107's handoff to #108 — see the notes above.
  'guest_portal_initialization',
  // #123's two, ADR 0004 D4 steps 4–5 — see the notes above.
  'procurement_requested',
  'retail_procurement_failed',
];

/**
 * An outbox row's own state. The same four the moderation outbox uses, because
 * it is the same mechanism: the row IS the job, a claim is a lease with an owner
 * check, and `dead_letter` is where a job that cannot succeed stays VISIBLE
 * instead of accumulating attempts nobody reads.
 */
export type PaymentOutboxStatus = 'pending' | 'processing' | 'processed' | 'dead_letter';

/** {@link PaymentOutboxStatus} as the tuple the column types and CHECKs read. */
export const PAYMENT_OUTBOX_STATUSES: readonly PaymentOutboxStatus[] = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
];

/**
 * Which rail a checkout funds through, when the buyer gets a choice.
 *
 * `mock` is not a payment method a buyer ever picks — it is the dev seam, gated
 * by `config.orders.mockPayEnabled` and refused outright in production. It is in
 * this union rather than hidden behind an undocumented magic string because the
 * request schema has to accept exactly one of a closed set, and a set with an
 * invisible member is one nobody can review.
 *
 * The union is deliberately NOT `PaymentProviderId`: `external` and `manual_pos`
 * are payments Mercaria RECORDS, made somewhere else entirely, and a checkout
 * request able to name one would be a buyer asserting a payment that never
 * happened.
 */
export type CheckoutPaymentMethod = 'stripe' | 'mock';

/** {@link CheckoutPaymentMethod} as the tuple the request schema reads. */
export const CHECKOUT_PAYMENT_METHODS: readonly CheckoutPaymentMethod[] = ['stripe', 'mock'];

/**
 * Which payment SURFACES the server permits for one checkout — ADR 0006 G2/G3
 * and G14's payment-method row, #107's "method eligibility is server-
 * authoritative".
 *
 * A different question from {@link CheckoutPaymentMethod}, which names the RAIL
 * a checkout funds through. Every member below rides the one card rail: Apple
 * Pay and Google Pay are card-based wallets inside Stripe's `card` payment
 * method type (ADR 0001 D3), and Link surfaces as autofill over the card form
 * without being a method type of its own (G15). So this tuple decides what a
 * client may RENDER, never what money does — which is why widening it cannot
 * change a charge, a transfer, a fee or a ledger entry.
 *
 * The set the server names is an upper bound and the device narrows it: only
 * the browser knows whether an Apple Pay sheet exists on this machine, and only
 * Stripe knows whether a domain is registered. The two-sided narrowing is the
 * point — a client cannot ADD a surface the server withheld (which is what
 * "server-authoritative" buys), and the server cannot force one the device
 * cannot show.
 *
 * Asynchronous methods (SEPA, Klarna, PayPal, Amazon Pay, bank debits) are
 * deliberately absent and may not be added here: ADR 0001 D3 excludes them
 * because a method that fails days after `source_transaction` transfers were
 * requested has no automatic recovery under separate charges and transfers.
 * Adding one is an ADR, a transfer-timing decision and a migration — not a
 * member on this tuple.
 */
export const CHECKOUT_PAYMENT_SURFACE_METHODS = [
  'card',
  'apple_pay',
  'google_pay',
  'link',
] as const;

/** One of {@link CHECKOUT_PAYMENT_SURFACE_METHODS}. */
export type CheckoutPaymentSurfaceMethod = (typeof CHECKOUT_PAYMENT_SURFACE_METHODS)[number];

/**
 * Every key a Mercaria-created provider object's metadata may carry — ADR 0006
 * G7, as a value rather than a paragraph.
 *
 * The list is short because it is an ALLOW-list, and it is an allow-list for the
 * `redact.ts` reason one layer over: a deny-list of forbidden keys is correct
 * only until somebody adds a field, which is exactly when a sensitive one
 * appears. Metadata is composed in ONE function from typed server-issued ids,
 * and {@link FORBIDDEN_PAYMENT_METADATA_SUBSTRINGS} is the second, independent
 * gate over the same output.
 *
 *  - `paymentId` — the correlation the webhook resolver reads, and the only
 *    load-bearing key.
 *  - `checkoutGroupId` — the group, equal to the intent's `transfer_group`.
 *  - `guestCheckoutId` — the durable `guest_checkouts` row id (B2), on
 *    guest-origin payments only. Deterministic on replay, because the row is
 *    UNIQUE per checkout group, so a converging retry composes byte-identical
 *    metadata and the reused idempotency key stays valid.
 *  - `orderCount` — so a dropped `orderIds` list is distinguishable from N=1.
 *  - `orderIds` — reconciliation convenience for a person reading the rail's
 *    dashboard, included only when it fits the provider's value limit.
 *
 * What is NOT here is the security property: no guest session id, no token or
 * token hash of any kind, no email in any form (plaintext, HMAC or redacted),
 * and no Oxy user id.
 */
export const PAYMENT_METADATA_KEYS = [
  'paymentId',
  'checkoutGroupId',
  'guestCheckoutId',
  'orderCount',
  'orderIds',
] as const;

/** One of {@link PAYMENT_METADATA_KEYS}. */
export type PaymentMetadataKey = (typeof PAYMENT_METADATA_KEYS)[number];

/**
 * Substrings that may never appear in a metadata KEY — ADR 0006 B4, stated
 * positively so a test can run it against a real composed record.
 *
 * The allow-list above already excludes everything here; this exists because the
 * two gates fail differently. The allow-list catches a key nobody thought about;
 * this catches a key somebody deliberately added under a plausible name
 * (`buyerEmail`, `sessionToken`, `guestSessionId`) and would have to defeat
 * twice.
 */
export const FORBIDDEN_PAYMENT_METADATA_SUBSTRINGS = [
  'token',
  'secret',
  'email',
  'phone',
  'session',
  'hash',
  'oxyuser',
  'magic',
  'portal',
  'grant',
  'cart',
] as const;

/**
 * Everything the buyer's client is given to complete a payment, and NOTHING
 * else (issue #47, backend 7).
 *
 * There is exactly one secret here and it is the rail's own client material —
 * opaque to Mercaria, handed over in the response and never stored (see the
 * backend's `PaymentClientAction`). No connected-account id, no charge id, no
 * seller identity, no per-order breakdown: a buyer's payment client needs an
 * amount, a currency and a way to authorize, and every extra field is provider
 * surface that a client could come to depend on.
 *
 * `amount` is what the rail will actually charge — the checkout group's grand
 * total in the buyer's presentment currency — so a client renders the figure the
 * payment was created for rather than re-adding the orders itself and rounding
 * differently.
 */
export interface CheckoutPaymentHandoff {
  /** Mercaria's payment id. The handle for the status endpoint below. */
  paymentId: string;
  provider: PaymentProviderId;
  /** The rail's client secret (or equivalent), opaque and never persisted. */
  clientSecret: string;
  /**
   * The rail's publishable key, when the server is configured with one.
   *
   * Absent means "use the key the app was built with". It is returned at all
   * because the key and the account that created the payment MUST be the same
   * one, and two independently-configured values can silently disagree — a
   * client secret confirmed against another account's key fails with a
   * mismatched-intent error that reads as a client bug.
   */
  publishableKey?: string;
  amount: Money;
  /**
   * The payment surfaces this checkout may render — #107's server-authoritative
   * method eligibility.
   *
   * Always present and never empty on a handoff: a handoff with nothing to
   * render is a checkout that cannot be paid, and the server refuses it rather
   * than returning client material for an empty sheet. See
   * {@link CHECKOUT_PAYMENT_SURFACE_METHODS} for what the set does and does not
   * decide — in particular that the device narrows it further and can never
   * widen it.
   */
  methods: readonly CheckoutPaymentSurfaceMethod[];
  /**
   * Where a buyer sent away for authentication comes back to — ADR 0006 G10.
   *
   * Composed by the SERVER from a configured origin plus this group's id, so a
   * client cannot choose where a bank redirect lands. Absent when the
   * deployment has configured no return origin, in which case the web client
   * confirms with `redirect: 'if_required'` and an authentication that insists
   * on a full redirect fails visibly rather than landing somewhere unintended.
   *
   * It carries the checkout group id and NOTHING else. That id is an opaque
   * server-issued uuid and is not a credential: knowing it authorizes nothing,
   * because the status endpoint authenticates the caller separately. The return
   * itself proves nothing at all — the verified provider event is the authority
   * (G10), the same posture as onboarding's `return_url` (ADR 0001 D2).
   */
  returnUrl?: string;
}
