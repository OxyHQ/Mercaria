/**
 * The payment state machine, the ledger postings it causes, and the trace that
 * explains both.
 *
 * This is the only module that talks to a `PaymentProvider`, and the only one
 * that moves a payment between statuses. "What happens when a payment succeeds"
 * is therefore written once and cannot drift between rails.
 *
 * ## The one shape everything else is built on
 *
 * Every status change goes through `applyPaymentStatus`, which in ONE Postgres
 * transaction:
 *
 *   1. compare-and-swaps the payment's status from an allowed source status;
 *   2. books the ledger postings that status change causes, if any;
 *   3. writes the outbox row for the domain event it produces.
 *
 * If the CAS matches nothing — a duplicate `succeeded`, an out-of-order
 * `processing` arriving after it — steps 2 and 3 never run. That single fact is
 * what makes duplicate and out-of-order provider events converge on one state
 * (#45 acceptance 3): the idempotency is one guarded UPDATE, not a chain of
 * individually-idempotent steps that has to be got right at every future call
 * site.
 *
 * ## What is deliberately NOT here
 *
 * - Inventory. A payment failing must not release a reservation (#45
 *   acceptance 4): the reservation-TTL sweep cancels the order and the ORDER
 *   transition releases the stock, so the failure path touches nothing. Two
 *   things releasing the same reservation is how stock goes negative.
 * - HTTP. The buyer-facing surface is the order's own `payment` projection; the
 *   operator surface that exposes `tracePayment` is #50's. This file is
 *   service-level on purpose.
 * - Provider signature verification, which belongs to the adapter, and the
 *   webhook ingress that calls it, which is #48's.
 */

import type {
  CurrencyCode,
  LedgerOwnerType,
  Money,
  PaymentProviderId,
  PaymentStatus,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import {
  createOrGetPayment,
  findNativePaymentByCheckoutGroupId,
  findPaymentById,
  findPaymentByProviderObjectId,
  listPaymentAttempts,
  listProviderEventsForPayment,
  listTransfersForPayment,
  markProviderEvent,
  recordPaymentAttempt,
  recordProviderEvent,
  toMoney,
  transitionPaymentStatus,
  type PaymentAttemptRow,
  type PaymentProviderEventRow,
  type PaymentRow,
  type PayoutRow,
  type TransferRow,
} from '../../db/payments/paymentRepository.js';
import {
  insertLedgerTransaction,
  type LedgerEntryInput,
} from '../../db/payments/ledgerRepository.js';
import { ledgerEntries, ledgerTransactions } from '../../db/schema/ledger.js';
import { chargeSucceeded, type SellerShare } from './ledger-postings.js';
import {
  drainPaymentOutbox,
  enqueuePaymentEvent,
  paymentFailedEventId,
  paymentSucceededEventId,
} from './payment-outbox.service.js';
import { findOrdersInCheckoutGroup, linkPaymentToOrders } from './order-linkage.js';
import { redactProviderMessage, redactProviderPayload } from './redact.js';
import type { ProviderEventEnvelope } from './provider.js';
import { log } from '../../lib/logger.js';
import { eq, inArray } from 'drizzle-orm';

/**
 * The allowed status transitions, and the ONLY place they are written down.
 *
 * A status not listed under the current one is refused by the compare-and-swap
 * rather than by an `if`, so the refusal is atomic against a concurrent event
 * instead of being a check something could race.
 *
 * `failed` is not terminal: a declined card is retried, and the next attempt
 * legitimately moves the same payment forward. `canceled`, `refunded` and the
 * path out of `partially_refunded` are the terminal ones — money that has come
 * back does not go out again under the same payment.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['requires_action', 'processing', 'succeeded', 'failed', 'canceled'],
  requires_action: ['processing', 'succeeded', 'failed', 'canceled'],
  processing: ['succeeded', 'failed', 'canceled'],
  succeeded: ['partially_refunded', 'refunded'],
  failed: ['requires_action', 'processing', 'succeeded', 'canceled'],
  canceled: [],
  refunded: [],
  partially_refunded: ['refunded'],
};

/** Which statuses may legally precede `next`. The CAS's `allowedFrom`. */
function sourcesFor(next: PaymentStatus): PaymentStatus[] {
  return (Object.keys(TRANSITIONS) as PaymentStatus[]).filter((from) =>
    TRANSITIONS[from].includes(next),
  );
}

/**
 * Whether a provider's payments move Mercaria's money.
 *
 * An explicit table rather than a `provider === 'external'` test, because the
 * question is not "is it external" but "did Mercaria receive and owe this
 * money", and those come apart the moment a third non-booking rail appears.
 * Both `false` entries are #45 acceptance 5 and ADR 0001 D12: the payment is
 * VISIBLE and creates no false Mercaria cash.
 */
const PROVIDER_BOOKS_LEDGER: Record<PaymentProviderId, boolean> = {
  // Captured on Shopify/WooCommerce. Mercaria never held these funds.
  external: false,
  // Cash or a card terminal at a register. The money is in the merchant's
  // drawer and never passes through Mercaria. A store-side cash view is a
  // product decision nobody has taken; inventing ledger entries for it would
  // put money in Mercaria's accounts that Mercaria does not have.
  manual_pos: false,
  // The dev seam. It books, because the ledger is what it exists to exercise —
  // and it is hard-gated off in production by `config.orders.mockPayEnabled`.
  mock: true,
};

/** Opening (or finding) the payment for a checkout group. */
export interface EnsurePaymentInput {
  provider: PaymentProviderId;
  checkoutGroupId: string;
  presentment: Money;
  buyerOxyUserId?: string;
  /** `external` payments only — the ONE order they stand for. */
  orderId?: string;
  status?: PaymentStatus;
  providerObjectId?: string;
  /** Stamp `payment.paymentId`/`provider` onto the group's orders. Default true. */
  linkOrders?: boolean;
}

/**
 * Open the payment for a checkout group, idempotently, and point its orders at
 * it.
 *
 * Convergence is the unique INDEX's job, not a read-then-write (ADR 0001 D11) —
 * so a double-tapped checkout, a retried connector import and a replayed POS
 * completion all end up on one payment rather than racing to create two.
 */
export async function ensurePayment(input: EnsurePaymentInput): Promise<PaymentRow> {
  const db = getDb();
  const payment = await createOrGetPayment(db, {
    provider: input.provider,
    checkoutGroupId: input.checkoutGroupId,
    presentment: input.presentment,
    ...(input.buyerOxyUserId ? { buyerOxyUserId: input.buyerOxyUserId } : {}),
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
  });

  if (input.linkOrders !== false) {
    await linkPaymentToOrders({
      checkoutGroupId: payment.checkoutGroupId,
      paymentId: payment.id,
      provider: payment.provider,
      ...(payment.providerObjectId ? { reference: payment.providerObjectId } : {}),
    });
  }
  return payment;
}

/** What a status change may carry with it. */
export interface ApplyPaymentStatusInput {
  paymentId: string;
  next: PaymentStatus;
  providerObjectId?: string;
  /** The presentment→platform conversion, once the rail has done it. */
  platform?: { amount: Money; rate: import('@mercaria/shared-types').FxRateSnapshot };
  /** The provider's processing fee on a success, borne by Mercaria (ADR D5). */
  feeMinor?: bigint;
  /** Distinguishes repeated failures in the outbox id. */
  providerEventId?: string;
  /** Recorded on the attempt row for a failure. */
  errorCode?: string;
  errorMessage?: string;
}

/** What actually happened. `changed: false` means a duplicate or out-of-order event. */
export interface ApplyPaymentStatusResult {
  changed: boolean;
  payment: PaymentRow;
  ledgerTransactionId?: string;
  outboxEventId?: string;
}

/**
 * Apply a status change, its accounting and its domain event — atomically.
 *
 * The heart of the domain. See this file's docblock for the three steps and why
 * they are one transaction.
 *
 * @throws When the payment does not exist. A status for an unknown payment is a
 *   correlation bug, and swallowing it would leave a provider believing Mercaria
 *   accepted something it never recorded.
 */
export async function applyPaymentStatus(
  input: ApplyPaymentStatusInput,
): Promise<ApplyPaymentStatusResult> {
  const db = getDb();
  const before = await findPaymentById(db, input.paymentId);
  if (!before) {
    throw new Error(`Payment ${input.paymentId} does not exist.`);
  }

  const outcome = await db.transaction(async (tx) => {
    const payment = await transitionPaymentStatus(
      tx,
      input.paymentId,
      sourcesFor(input.next),
      input.next,
      {
        ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
      },
    );
    // The CAS matched nothing: this payment is already at (or past) `next`.
    // Everything below is skipped, which is exactly what makes a redelivered
    // event a no-op rather than a second charge in the accounts.
    if (!payment) {
      return { changed: false as const, payment: before };
    }

    await recordPaymentAttempt(tx, {
      paymentId: payment.id,
      provider: payment.provider,
      status: attemptStatusFor(input.next),
      ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: redactProviderMessage(input.errorMessage) } : {}),
    });

    let ledgerTransactionId: string | undefined;
    if (input.next === 'succeeded' && PROVIDER_BOOKS_LEDGER[payment.provider]) {
      ledgerTransactionId = await bookChargeSucceeded(tx, payment, input.feeMinor ?? 0n);
    }

    const outboxEventId = await enqueueForStatus(tx, payment, input);
    return { changed: true as const, payment, ledgerTransactionId, outboxEventId };
  });

  if (!outcome.changed) {
    log.general.debug(
      { paymentId: input.paymentId, requested: input.next, current: before.status },
      '[Payments] status change skipped — already applied',
    );
    return { changed: false, payment: outcome.payment };
  }

  // Run the row we just committed, now, instead of waiting for the poller. It
  // claims the SAME lease the dispatcher would, so the two can never both run
  // the handler; if this process dies first, the poller picks it up.
  if (outcome.outboxEventId) {
    await drainOutboxEvent(outcome.outboxEventId);
  }

  return {
    changed: true,
    payment: outcome.payment,
    ...(outcome.ledgerTransactionId ? { ledgerTransactionId: outcome.ledgerTransactionId } : {}),
    ...(outcome.outboxEventId ? { outboxEventId: outcome.outboxEventId } : {}),
  };
}

/**
 * Apply a VERIFIED provider event.
 *
 * Two steps that are deliberately separable: the event is stored first and
 * interpreted second (#45 API and events 3 — the ingress is #48's). A
 * redelivery is caught by the event store's unique index and returns without
 * touching the payment at all, which is the cheapest possible answer to the
 * commonest duplicate.
 *
 * @param envelope Already verified by the adapter. Nothing here re-checks a
 *   signature, and nothing may call this with an unverified body.
 */
export async function applyProviderEvent(envelope: ProviderEventEnvelope): Promise<{
  duplicate: boolean;
  applied: boolean;
  paymentId?: string;
}> {
  const db = getDb();
  const stored = await recordProviderEvent(db, {
    provider: envelope.provider,
    providerEventId: envelope.providerEventId,
    type: envelope.type,
    livemode: envelope.livemode,
    objectIds: { ...envelope.objectIds },
    // NEVER the wholesale payload — #45 invariant 9.
    payloadSummary: redactProviderPayload(envelope.payload),
    expiresAt: new Date(Date.now() + RETENTION_SECONDS.paymentProviderEvent * 1_000),
    ...(envelope.providerAccountId ? { providerAccountId: envelope.providerAccountId } : {}),
    ...(envelope.apiVersion ? { apiVersion: envelope.apiVersion } : {}),
  });
  if (stored.duplicate) {
    return { duplicate: true, applied: false, ...(stored.row.paymentId ? { paymentId: stored.row.paymentId } : {}) };
  }

  const providerObjectId = envelope.objectIds.payment;
  if (!providerObjectId || !envelope.paymentStatus) {
    // An event about something this version does not act on — a payout, a
    // transfer, a rail's own housekeeping. It is STORED, because evidence of
    // something Mercaria could not interpret is worth more than a dropped
    // request, and marked processed so it is not retried forever.
    await markProviderEvent(db, stored.row.id, { status: 'processed' });
    return { duplicate: false, applied: false };
  }

  const payment = await findPaymentByProviderObjectId(db, envelope.provider, providerObjectId);
  if (!payment) {
    await markProviderEvent(db, stored.row.id, {
      status: 'failed',
      lastError: `No payment matches ${envelope.provider} object ${providerObjectId}`,
    });
    return { duplicate: false, applied: false };
  }

  try {
    const result = await applyPaymentStatus({
      paymentId: payment.id,
      next: envelope.paymentStatus,
      providerObjectId,
      providerEventId: envelope.providerEventId,
    });
    await markProviderEvent(db, stored.row.id, { status: 'processed', paymentId: payment.id });
    return { duplicate: false, applied: result.changed, paymentId: payment.id };
  } catch (error: unknown) {
    await markProviderEvent(db, stored.row.id, {
      status: 'failed',
      paymentId: payment.id,
      lastError: redactProviderMessage(error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

/** The attempt row a status change produces. */
function attemptStatusFor(next: PaymentStatus): 'pending' | 'succeeded' | 'failed' {
  if (next === 'succeeded' || next === 'refunded' || next === 'partially_refunded') {
    return 'succeeded';
  }
  if (next === 'failed') return 'failed';
  return 'pending';
}

/**
 * Book the charge, splitting it across the seller orders it funds.
 *
 * ## Everything is booked in the PRESENTMENT currency, for now
 *
 * The charge is created in the buyer's presentment currency and, for every rail
 * that exists today, settles in it too — so the gross and each seller's net are
 * the same currency and the transaction balances exactly. ADR 0001 D8 says that
 * changes when a real rail lands: the platform settles in EUR, a seller order
 * whose shop currency differs is converted ONCE at charge-success time with a
 * captured rate, and both legs are booked in their own currencies. The ledger
 * already balances PER currency precisely so that day needs no new mechanism —
 * only `payment.platform_*` (already stored) in place of the presentment side
 * below.
 *
 * A currency mismatch between an order and its payment is refused rather than
 * converted here. Converting would mean choosing a rate, and a rate chosen at
 * posting time is exactly the unreproducible number `FxRateSnapshot` exists to
 * prevent.
 *
 * ## The per-order NET is the order's whole total, because the commission is zero
 *
 * That is the number #88's fee schedule changes: the share becomes
 * `total − commission(total)`, and the residual `chargeSucceeded` already
 * computes stops being zero and starts crediting `commission_revenue`. Nothing
 * else moves — the fee schedule has exactly one place to plug in.
 */
async function bookChargeSucceeded(
  tx: DatabaseOrTransaction,
  payment: PaymentRow,
  feeMinor: bigint,
): Promise<string | undefined> {
  const orders = await findOrdersInCheckoutGroup(payment.checkoutGroupId);
  if (orders.length === 0) {
    // A payment with no orders is a correlation failure, not an accounting
    // event. Booking a charge against nobody would credit `commission_revenue`
    // with the entire gross.
    log.general.error(
      { paymentId: payment.id, checkoutGroupId: payment.checkoutGroupId },
      '[Payments] charge succeeded but no orders were found for its checkout group',
    );
    return undefined;
  }

  const currency = payment.presentmentCurrency as CurrencyCode;
  const mismatched = orders.filter((order) => order.presentmentCurrency !== currency);
  if (mismatched.length > 0) {
    throw new Error(
      `Payment ${payment.id} is denominated in ${currency} but ` +
        `${String(mismatched.length)} of its orders are not. A charge cannot be split across ` +
        'currencies without a captured rate (ADR 0001 D8).',
    );
  }

  const shares: SellerShare[] = orders.map((order) => ({
    orderId: order.id,
    ownerType: (order.sellerType === 'store' ? 'store' : 'user') as LedgerOwnerType,
    ownerId: order.sellerOwnerId,
    netMinor: BigInt(order.presentmentTotalMinor),
  }));

  const posting = chargeSucceeded({
    paymentId: payment.id,
    currency,
    grossMinor: BigInt(payment.presentmentAmount),
    feeMinor,
    shares,
  });
  const inserted = await insertLedgerTransaction(tx, posting.transaction, posting.entries);
  return inserted.id;
}

/** The outbox row a status change produces, if it produces one. */
async function enqueueForStatus(
  tx: DatabaseOrTransaction,
  payment: PaymentRow,
  input: ApplyPaymentStatusInput,
): Promise<string | undefined> {
  if (input.next === 'succeeded') {
    const id = paymentSucceededEventId(payment.id);
    await enqueuePaymentEvent(tx, {
      id,
      eventType: 'payment_succeeded',
      payload: { paymentId: payment.id, checkoutGroupId: payment.checkoutGroupId },
    });
    return id;
  }
  if (input.next === 'failed') {
    // A payment can fail more than once, so the id carries the provider event
    // that reported THIS failure. Without it the second decline is swallowed.
    const id = paymentFailedEventId(payment.id, input.providerEventId ?? String(Date.now()));
    await enqueuePaymentEvent(tx, {
      id,
      eventType: 'payment_failed',
      payload: {
        paymentId: payment.id,
        checkoutGroupId: payment.checkoutGroupId,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    });
    return id;
  }
  // `processing`, `requires_action` and `canceled` produce no domain event:
  // nothing outside the payment domain acts on them, and an event nobody
  // consumes is a row to sweep and a lease to renew for no reason.
  return undefined;
}

/**
 * Drain one just-committed outbox row, without letting its failure fail the
 * payment.
 *
 * The status change and its accounting are already committed and correct. If the
 * handler throws, the row is released with backoff and the poller retries it —
 * so re-throwing here would turn "the order will be marked paid a few seconds
 * later" into a 500 for a payment that genuinely succeeded.
 */
async function drainOutboxEvent(eventId: string): Promise<void> {
  const { runPaymentOutboxEvent } = await import('./outbox-handlers.js');
  try {
    await drainPaymentOutbox({ handler: runPaymentOutboxEvent, eventId });
  } catch (error: unknown) {
    log.general.warn(
      { err: error, eventId },
      '[Payments] inline outbox drain failed; the dispatcher will retry',
    );
  }
}

/** Everything known about one payment. The operator answer, assembled once. */
export interface PaymentTrace {
  payment: PaymentRow;
  attempts: PaymentAttemptRow[];
  events: PaymentProviderEventRow[];
  transfers: TransferRow[];
  payouts: PayoutRow[];
  ledger: {
    transaction: typeof ledgerTransactions.$inferSelect;
    entries: (typeof ledgerEntries.$inferSelect)[];
  }[];
  /** The orders this payment funds, from the order store. */
  orderIds: string[];
}

/** How to find the payment a trace is about. Exactly one must be given. */
export type PaymentTraceQuery =
  | { byPaymentId: string }
  | { byCheckoutGroupId: string }
  | { byOrderId: string }
  | { byProviderObjectId: { provider: PaymentProviderId; providerObjectId: string } };

/**
 * Trace a payment through every record that mentions it.
 *
 * The answer to "what happened to this money", and #45 API and events 4 — from
 * an order, a checkout group, a payment id or a PROVIDER's own object id, never
 * from an email, a raw token or a provider's guest grouping (#45 acceptance 10).
 * That is a property of this signature: there is no way to ask by any of them.
 *
 * This is the SERVICE. The operator HTTP surface that exposes it, with its own
 * authorization, is #50's — and it will need one, because everything returned
 * here is merchant and operator financial detail.
 */
export async function tracePayment(query: PaymentTraceQuery): Promise<PaymentTrace | undefined> {
  const db = getDb();
  const payment = await resolveTracedPayment(query);
  if (!payment) return undefined;

  const [attempts, events, transferRows, ledgerTransactionRows] = await Promise.all([
    listPaymentAttempts(db, payment.id),
    listProviderEventsForPayment(db, payment.id),
    listTransfersForPayment(db, payment.id),
    db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.paymentId, payment.id))
      .orderBy(ledgerTransactions.createdAt),
  ]);

  const transactionIds = ledgerTransactionRows.map((row) => row.id);
  const entries =
    transactionIds.length > 0
      ? await db
          .select()
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.transactionId, transactionIds))
          .orderBy(ledgerEntries.createdAt)
      : [];

  // Payouts are per PROVIDER ACCOUNT, not per payment: a payout batches many
  // transfers. They are reachable from a trace only through the accounts this
  // payment's transfers paid, and #46 is what will map a transfer to its
  // account — until then a trace shows no payouts rather than guessing.
  const payoutRows: PayoutRow[] = [];

  const orders = await findOrdersInCheckoutGroup(payment.checkoutGroupId);

  return {
    payment,
    attempts,
    events,
    transfers: transferRows,
    payouts: payoutRows,
    ledger: ledgerTransactionRows.map((transaction) => ({
      transaction,
      entries: entries.filter((entry) => entry.transactionId === transaction.id),
    })),
    orderIds: orders.map((order) => order.id),
  };
}

/** Resolve whichever handle the caller had into the payment itself. */
async function resolveTracedPayment(query: PaymentTraceQuery): Promise<PaymentRow | undefined> {
  const db = getDb();
  if ('byPaymentId' in query) {
    return await findPaymentById(db, query.byPaymentId);
  }
  if ('byCheckoutGroupId' in query) {
    return await findNativePaymentByCheckoutGroupId(db, query.byCheckoutGroupId);
  }
  if ('byProviderObjectId' in query) {
    return await findPaymentByProviderObjectId(
      db,
      query.byProviderObjectId.provider,
      query.byProviderObjectId.providerObjectId,
    );
  }
  // From an order: the order carries the pointer, so this needs no join through
  // the checkout group and works for an `external` payment too.
  const { findLinkedOrder } = await import('./order-linkage.js');
  const order = await findLinkedOrder(query.byOrderId);
  if (!order) return undefined;
  const { Order } = await import('../../models/order.js');
  const doc = await Order.findById(query.byOrderId).select('payment checkoutGroupId').lean<{
    payment?: { paymentId?: string };
    checkoutGroupId?: string;
  } | null>();
  if (doc?.payment?.paymentId) {
    return await findPaymentById(db, doc.payment.paymentId);
  }
  return doc?.checkoutGroupId
    ? await findNativePaymentByCheckoutGroupId(db, doc.checkoutGroupId)
    : undefined;
}

/** Re-exported so callers building a `Money` from stored columns share one helper. */
export { toMoney };

/** Only the entry types callers need; the ledger rows themselves stay internal. */
export type { LedgerEntryInput };
