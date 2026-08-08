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
 * interface in the backend; a Faircoin rail (#51) plugs into the same seams
 * without either provider leaking into the domain.
 *
 * ## What this file is NOT
 *
 * It is not the buyer-facing payment surface. What a buyer may see about a
 * payment is `PaymentInfo` on the order (`./order`) — status, provider, an
 * optional reference and the payment's id. Amounts, ledger entries, provider
 * events, transfers and payouts are operator and merchant financial detail and
 * are never projected onto an order DTO.
 */

/**
 * The payment rails Mercaria can record a payment against.
 *
 * A closed set, and deliberately a SHORT one: a provider is added here together
 * with the code that can produce a row for it and its migration widening the
 * CHECK, never in advance. Faircoin (#51) is not listed because nothing can
 * write one yet, and a value the database accepts but no code can produce is an
 * invitation to write a row nothing can ever reconcile.
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
 * Mercaria's chart of accounts. Seven accounts, and no more without a decision.
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
 *
 * `merchant_payable` is the only account carried PER OWNER: its rows name the
 * seller (`ownerType` + `ownerId`) and usually the order, because "what do we
 * owe this seller for this order" is the question the account exists to answer.
 * The others are platform-wide and leave both owner columns NULL.
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
  | 'reserves';

/** {@link LedgerAccount} as the tuple the column types and CHECKs read. */
export const LEDGER_ACCOUNTS: readonly LedgerAccount[] = [
  'provider_clearing',
  'merchant_payable',
  'commission_revenue',
  'processor_expense',
  'refunds',
  'disputes',
  'reserves',
];

/**
 * Who a `merchant_payable` entry is owed to — a business store or a P2P seller.
 *
 * The same two kinds `Order.sellerType` distinguishes, named the same way, so a
 * payable row and the order it came from can be joined without a translation
 * table.
 */
export type LedgerOwnerType = 'store' | 'user';

/** {@link LedgerOwnerType} as the tuple the column types and CHECKs read. */
export const LEDGER_OWNER_TYPES: readonly LedgerOwnerType[] = ['store', 'user'];

/**
 * What a ledger transaction records. One kind per row in ADR 0001's
 * "Ledger representability" table, and nothing that is not in it.
 *
 * `adjustment` is the operator escape hatch, and it is NOT a licence to edit
 * history: entries are append-only, so a correction is a new transaction whose
 * entries reverse the ones that were wrong (#45 invariant 2).
 */
export type LedgerTransactionKind =
  | 'charge_succeeded'
  | 'transfer_created'
  | 'refund'
  | 'transfer_reversal'
  | 'dispute_created'
  | 'dispute_won'
  | 'dispute_lost'
  | 'adjustment';

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
 */
export type PaymentOutboxEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_succeeded_after_release'
  | 'payment_refunded'
  | 'payment_disputed'
  | 'transfer_changed'
  | 'payout_changed';

/** {@link PaymentOutboxEventType} as the tuple the column types and CHECKs read. */
export const PAYMENT_OUTBOX_EVENT_TYPES: readonly PaymentOutboxEventType[] = [
  'payment_succeeded',
  'payment_failed',
  // The exception, not a lifecycle step — see the note below.
  'payment_succeeded_after_release',
  'payment_refunded',
  'payment_disputed',
  'transfer_changed',
  'payout_changed',
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
