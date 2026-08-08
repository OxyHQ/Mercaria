/**
 * The payment state machine, the ledger postings it causes, and the trace that
 * explains both.
 *
 * The only module that moves a payment between statuses, so "what happens when a
 * payment succeeds" is written once and cannot drift between rails. It is one of
 * three that talk to a `PaymentProvider` — `checkout-payment.service` opens a
 * checkout's payment and `settlement.service` makes the transfers — and the ONLY
 * one that changes a status as a result.
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
import { chargeSucceeded } from './ledger-postings.js';
import { allocateSellerShares } from './settlement-shares.js';
import {
  drainPaymentOutbox,
  enqueuePaymentEvent,
  paymentFailedEventId,
  paymentSucceededAfterReleaseEventId,
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
  // The card rail. Mercaria is merchant of record (ADR 0001 D1): the money
  // arrives on the platform balance, Mercaria owes each seller their share, and
  // the difference is its commission — which exists nowhere but this ledger.
  stripe: true,
};

/**
 * Whether `next` is a legal successor of `from`.
 *
 * The read-only view of the same `TRANSITIONS` table the compare-and-swap is
 * built from, exported because #48's Stripe event router needs to ask the
 * question BEFORE acting: an event whose status is not reachable from where the
 * payment already is cannot be applied from its payload alone, and the correct
 * response is to re-read the provider's current state rather than to submit a
 * transition the CAS will silently discard (issue #48, ordering and
 * convergence 2).
 *
 * It reads the table rather than restating it, which is the point — a caller
 * with its own copy of the transition rules is a second state machine that
 * drifts from this one at the first change.
 *
 * Note this is a QUESTION, never a permission: the CAS is still what refuses an
 * illegal transition, atomically against a concurrent event. Nothing may use
 * this to skip it.
 */
export function canTransitionPaymentStatus(from: PaymentStatus, next: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(next);
}

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

/**
 * Record that the provider captured money for a payment Mercaria had released.
 *
 * The reservation timed out, the sweep cancelled the orders and the stock went
 * back — and then the rail reported a success. Money has arrived for goods
 * nobody is holding.
 *
 * ## Why this does nothing else
 *
 * Every automatic answer is worse than raising the condition. Re-committing the
 * inventory would oversell whatever has been bought in the meantime. Booking the
 * charge would credit `commission_revenue` with the whole gross, because
 * `bookChargeSucceeded` splits across orders that no longer exist. Refunding
 * without a person is a policy decision the payment domain does not get to take.
 * So this writes ONE durable, deterministic row and stops, and #50's operator
 * surface is where a human picks it up.
 *
 * The payment's own status is left alone too: it is `canceled`, and that is
 * true. Inventing a status for this would put a state every report, filter and
 * dashboard has to learn into the vocabulary for an event that should be rare.
 * The exception lives in the outbox, where it is queryable and where it cannot
 * be mistaken for a lifecycle a consumer should act on.
 *
 * @returns The outbox event id, or `undefined` when one was already recorded —
 *   a redelivered success must not raise the same exception twice.
 */
export async function flagSucceededAfterRelease(input: {
  paymentId: string;
  providerEventId: string;
}): Promise<string | undefined> {
  const db = getDb();
  const payment = await findPaymentById(db, input.paymentId);
  if (!payment) {
    throw new Error(`Payment ${input.paymentId} does not exist.`);
  }

  // Keyed on the PAYMENT alone, not on the provider event: several redeliveries
  // of one capture are one exception, and an operator opening the same case
  // three times is noise that hides the next real one.
  const id = paymentSucceededAfterReleaseEventId(payment.id);
  const created = await db.transaction(
    async (tx) =>
      await enqueuePaymentEvent(tx, {
        id,
        eventType: 'payment_succeeded_after_release',
        payload: {
          paymentId: payment.id,
          checkoutGroupId: payment.checkoutGroupId,
          providerEventId: input.providerEventId,
          releasedStatus: payment.status,
        },
      }),
  );

  if (!created) return undefined;
  await drainOutboxEvent(id);
  return id;
}

/**
 * Give up on the payment for a checkout group whose reservation expired.
 *
 * The reservation-TTL sweep has cancelled the orders and put the stock back, so
 * the rail must stop being able to take the buyer's money for them.
 *
 * ## The order of the two steps is the whole design
 *
 * The rail is told FIRST, because that is the only step that can actually
 * prevent a capture; Mercaria's own status is then set to `canceled`
 * REGARDLESS of what the rail said, because it is true either way — Mercaria has
 * released these goods.
 *
 * That second part is what arms the exception path rather than defeating it. If
 * the rail refuses to cancel because it has already captured, the payment sits
 * at `canceled` and the succeeded event that follows finds a status it cannot
 * legally reach — which is exactly the condition `flagSucceededAfterRelease`
 * exists to raise, and money arriving for released goods is raised for an
 * operator instead of quietly booking a charge against cancelled orders.
 *
 * Nothing here touches inventory. The ORDER transition already released it, and
 * two things releasing one reservation is how stock goes negative (#45
 * acceptance 4).
 *
 * @returns Whether Mercaria's payment moved to `canceled` in this call.
 */
export async function cancelPaymentForCheckoutGroup(checkoutGroupId: string): Promise<boolean> {
  const db = getDb();
  const payment = await findNativePaymentByCheckoutGroupId(db, checkoutGroupId);
  // No payment was ever opened — a checkout on a deployment with no rail, or one
  // abandoned before the rail was engaged. There is nothing to cancel.
  if (!payment) return false;
  if (!canTransitionPaymentStatus(payment.status, 'canceled')) return false;

  if (payment.providerObjectId) {
    const { resolvePaymentProvider } = await import('./registry.js');
    const provider = resolvePaymentProvider(payment.provider);
    if (provider) {
      try {
        await provider.cancel({
          paymentId: payment.id,
          providerObjectId: payment.providerObjectId,
          // Derived from the payment, like every other key (ADR 0001 D11): a
          // sweep that runs twice must not be able to cancel twice.
          idempotencyKey: `cancel:${payment.id}`,
        });
      } catch (error: unknown) {
        // Best effort, and a failure here is INFORMATION: the commonest cause is
        // a capture that beat the sweep, which the local `canceled` below turns
        // into a visible exception when the success event lands.
        log.general.warn(
          { err: error, paymentId: payment.id, checkoutGroupId },
          '[Payments] could not cancel the payment at its rail; cancelling locally anyway',
        );
      }
    }
  }

  const result = await applyPaymentStatus({ paymentId: payment.id, next: 'canceled' });
  return result.changed;
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
 * ## It books in the currency the money actually LANDED in
 *
 * When the rail has reported a conversion — `payment.platform_*`, captured with
 * its rate at the moment the charge succeeded (ADR 0001 D8) — the gross, each
 * seller's payable, the fee and the commission are all booked in the PLATFORM's
 * settlement currency. That is where the money is: a USD charge on a EUR
 * platform arrives as euros, and a `provider_clearing` leg in dollars would
 * describe a balance Stripe does not hold.
 *
 * Without a conversion the charge settled in the currency it was made in, and
 * the presentment side is both what the buyer paid and what the platform
 * received. That is every same-currency card charge and every synthetic one.
 *
 * The consequence that makes this load-bearing rather than cosmetic: the
 * transfers that settle these payables are denominated in the platform currency
 * too, so booking the payable in any other one leaves `merchant_payable` holding
 * two currencies for a single order — a debt that says it was both owed and paid
 * and never nets to zero.
 *
 * ## Orders must share ONE presentment currency
 *
 * They always do (a checkout group is priced once, in the buyer's currency), and
 * the guard stays because the split below uses each order's total as a WEIGHT.
 * Weights in mixed currencies would be added together as if they were
 * commensurable, which silently mis-splits the charge instead of failing.
 *
 * ## The per-order NET, and where #88 plugs in
 *
 * `allocateSellerShares` is the single definition of what each seller is owed,
 * shared with the settlement step so the payable and the transfer cannot
 * disagree. The commission is not deducted there and is not passed here: it is
 * the RESIDUAL `chargeSucceeded` computes, zero while the rate is zero, and #88
 * makes it non-zero by shrinking those shares — nothing else moves.
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

  const presentmentCurrency = payment.presentmentCurrency as CurrencyCode;
  const mismatched = orders.filter((order) => order.presentmentCurrency !== presentmentCurrency);
  if (mismatched.length > 0) {
    throw new Error(
      `Payment ${payment.id} is denominated in ${presentmentCurrency} but ` +
        `${String(mismatched.length)} of its orders are not. A charge cannot be split across ` +
        'currencies without a captured rate (ADR 0001 D8).',
    );
  }

  const settled = settlementBasis(payment);
  const allocation = allocateSellerShares({
    grossMinor: settled.grossMinor,
    currency: settled.currency,
    orders: orders.map((order) => ({
      orderId: order.id,
      ownerType: (order.sellerType === 'store' ? 'store' : 'user') as LedgerOwnerType,
      ownerId: order.sellerOwnerId,
      weightMinor: order.presentmentTotalMinor,
    })),
  });

  const posting = chargeSucceeded({
    paymentId: payment.id,
    currency: settled.currency,
    grossMinor: settled.grossMinor,
    feeMinor,
    shares: allocation.shares,
  });
  const inserted = await insertLedgerTransaction(tx, posting.transaction, posting.entries);
  return inserted.id;
}

/**
 * The currency and gross a payment's money movements are booked and settled in.
 *
 * The platform side when the rail converted, the presentment side when it did
 * not — see `bookChargeSucceeded`. Exported because the settlement step needs
 * the SAME answer to size its transfers, and two readers of the same rule is
 * exactly how the two figures stay equal.
 */
export function settlementBasis(payment: PaymentRow): {
  currency: CurrencyCode;
  grossMinor: bigint;
} {
  if (payment.platformAmount !== null && payment.platformCurrency !== null) {
    return {
      currency: payment.platformCurrency as CurrencyCode,
      grossMinor: BigInt(payment.platformAmount),
    };
  }
  return {
    currency: payment.presentmentCurrency as CurrencyCode,
    grossMinor: BigInt(payment.presentmentAmount),
  };
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
  if (order.paymentId) {
    return await findPaymentById(db, order.paymentId);
  }
  return order.checkoutGroupId
    ? await findNativePaymentByCheckoutGroupId(db, order.checkoutGroupId)
    : undefined;
}

/** Re-exported so callers building a `Money` from stored columns share one helper. */
export { toMoney };

/** Only the entry types callers need; the ledger rows themselves stay internal. */
export type { LedgerEntryInput };
