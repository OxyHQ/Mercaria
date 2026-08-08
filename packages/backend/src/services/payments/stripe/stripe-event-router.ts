/**
 * What each Stripe event type DOES — one table, one handler per type.
 *
 * Split from the ingress (which owns verification, storage and dedupe) and from
 * the processor (which owns claiming, backoff and dead-lettering), so what an
 * event MEANS can be read and tested without any of that machinery, and the
 * machinery without knowing a single Stripe noun.
 *
 * ## Three outcomes, and the middle one is the point
 *
 * A handler returns `applied`, `deferred` or `ignored`, and the processor writes
 * that distinction into the event row's `processing_note`. Types ADR 0001
 * subscribes to arrive here from the moment the endpoint is registered, because
 * an endpoint has to carry its full event list before any of its consumers ship
 * or everything that happens in between is simply lost — so `deferred` exists to
 * say "understood, and the code that acts on it has not landed" without letting
 * that be mistaken for real handling in the operator trace.
 *
 * **As of #49 nothing here is deferred.** The `account.*` types stopped being so
 * at #46 and the refund, dispute, charge-fee and payout types at #49; the
 * `deferred` outcome is kept because the next subscribed type will need it, and
 * because a trace that could not express the distinction would make the next
 * seam invisible.
 *
 * ## A handler NEVER trusts a payload it was not handed
 *
 * `StripeEventContext.delivered` is present only on the inline path immediately
 * after receipt. On a retry, and on an operator replay hours later, it is
 * absent — because the only copy Mercaria keeps is `payload_summary`, which is
 * REDACTED by design and is an operator's view rather than a replayable event.
 *
 * That is not a limitation to work around; it is the correct behaviour anyway. A
 * snapshot from the moment an event was generated is history by the time a
 * dead letter is replayed, so a handler that needs more than an id re-reads the
 * object from Stripe. What survives verbatim is `objectIds` — stored unredacted
 * in its own column precisely so correlation never depends on the payload.
 */

import type Stripe from 'stripe';
import { and, eq, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  LedgerAccount,
  Money,
  PaymentStatus,
  PayoutStatus,
  TransferStatus,
} from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import {
  findPaymentById,
  findPaymentByProviderObjectId,
  findTransferByProviderObjectId,
  updateTransferFromProvider,
  type PaymentRow,
} from '../../../db/payments/paymentRepository.js';
import {
  applyRefundProviderState,
  findRefundById,
  findRefundByProviderRefundId,
} from '../../../db/orders/refundRepository.js';
import { insertLedgerTransaction } from '../../../db/payments/ledgerRepository.js';
import { ledgerEntries, ledgerTransactions } from '../../../db/schema/ledger.js';
import {
  applyPaymentStatus,
  canTransitionPaymentStatus,
  flagSucceededAfterRelease,
} from '../payment.service.js';
import { adjustment } from '../ledger-postings.js';
import { recordDispute } from '../dispute.service.js';
import { recordPayout } from '../payout.service.js';
import {
  enqueuePaymentEvent,
  refundFailedEventId,
  refundUnmatchedEventId,
  transferChangedEventId,
} from '../payment-outbox.service.js';
import { PaymentProviderError } from '../provider.js';
import { log } from '../../../lib/logger.js';
import { redactAccountId, revokeAccount, syncAccountState } from './account.service.js';
import {
  retrieveStripeChargeWithBalance,
  retrieveStripeChargeWithRefunds,
  retrieveStripeDispute,
  retrieveStripePaymentIntent,
  retrieveStripePayout,
  retrieveStripeRefund,
  retrieveStripeTransfer,
} from './client.js';
import { readStripeSettlement } from './settlement-read.js';
import { mapDisputeStatus, mapPaymentIntentStatus, mapRefundStatus } from './verify.js';

/** What a handler is given. Everything else it needs, it reads from Stripe. */
export interface StripeEventContext {
  /** Mercaria's id for the stored envelope — for logs and correlation. */
  readonly storedEventId: string;
  /** Stripe's own event id. */
  readonly providerEventId: string;
  /** Stripe's event type verbatim, e.g. `payment_intent.succeeded`. */
  readonly type: string;
  /** The connected account, on a connect-scope delivery. */
  readonly account?: string;
  /** The Stripe ids this event names, stored verbatim and never redacted. */
  readonly objectIds: Readonly<Record<string, string>>;
  /**
   * The event as Stripe sent it — ONLY on the inline path after receipt.
   *
   * Absent on every retry and replay. See this file's docblock: a handler
   * without it re-reads from Stripe, which is also the more correct answer.
   */
  readonly delivered?: Stripe.Event;
}

/**
 * What a handler DID.
 *
 * `applied` — Mercaria state changed, or would have if an earlier delivery had
 * not already satisfied the compare-and-swap. `deferred` — the event is
 * understood and belongs to an issue that has not shipped; the note names it.
 * `ignored` — nothing in this system will ever act on it.
 */
export interface StripeEventOutcome {
  readonly kind: 'applied' | 'deferred' | 'ignored';
  /** The payment it correlated to, when it correlated to one. */
  readonly paymentId?: string;
  /** Required for anything but a plain `applied`: what happened, and why. */
  readonly note?: string;
}

/** One event type's behaviour. */
export type StripeEventHandler = (context: StripeEventContext) => Promise<StripeEventOutcome>;

/**
 * A correlation this version cannot make YET.
 *
 * Retryable on purpose (issue #48, ordering and convergence 9): Stripe can
 * deliver `payment_intent.succeeded` before the transaction that created the
 * Mercaria payment is visible to this task, and discarding the event then would
 * throw away the relationship rather than wait a second for it. Backoff and
 * eventual dead-lettering are what stop it retrying forever.
 */
function unresolved(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message,
    retryable: true,
  });
}

/** An event that named no id this handler can work from — never retryable. */
function malformed(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message,
    retryable: false,
  });
}

/**
 * Find the Mercaria payment a Stripe PaymentIntent belongs to.
 *
 * `metadata.paymentId` first — ADR 0001 D11 puts it there when the intent is
 * created, precisely so the correlation is a server-issued, stable Mercaria id
 * rather than anything a buyer, a card or a Stripe Customer could influence
 * (issue #48, identity boundaries 3). The provider-object lookup is the fallback
 * for an intent created before that convention, or one whose metadata a later
 * API version dropped.
 *
 * Nothing else is ever consulted. Not the Stripe Customer, not the email, not
 * the card fingerprint, not a Link identity: none of them can authenticate a
 * Mercaria buyer or claim a Mercaria order (issue #48, identity boundaries 1
 * and 2), and a resolver able to reach them is the surface where they would
 * eventually be used.
 */
async function resolvePayment(input: {
  metadata?: Stripe.Metadata | null;
  providerObjectId: string;
}): Promise<PaymentRow | undefined> {
  const db = getDb();
  const declared = input.metadata?.paymentId;
  if (typeof declared === 'string' && declared !== '') {
    const byId = await findPaymentById(db, declared);
    if (byId) return byId;
    // Metadata naming a payment that does not exist is not a reason to fall
    // through quietly — it is either an object from another environment or a
    // deployment whose database was rebuilt, and both need saying.
    log.general.warn(
      { paymentId: declared, providerObjectId: input.providerObjectId },
      '[Stripe] event metadata names a payment that does not exist; falling back to the ' +
        'provider object id',
    );
  }
  return await findPaymentByProviderObjectId(db, 'stripe', input.providerObjectId);
}

/**
 * A PaymentIntent event: the only handler that moves a payment's status.
 *
 * ## The stale-delivery rule, which is the whole of "ordering and convergence"
 *
 * Stripe guarantees nothing about delivery order. An event carrying `processing`
 * can arrive after the payment has already succeeded, and its payload is a true
 * snapshot of a moment that has passed — not evidence that anything went
 * backwards.
 *
 * So before applying anything, this asks whether the mapped status is a legal
 * successor of where the payment already is. If it is not, the payload alone
 * cannot be applied safely and the answer is to READ Stripe's current state and
 * apply THAT (issue #48, ordering 2). Which is why the test is
 * `canTransitionPaymentStatus` rather than a comparison of timestamps: "is this
 * stale" and "can this be applied" turn out to be the same question, and only
 * the second has an answer that does not require knowing which other events
 * exist.
 *
 * Duplicates need no special case at all. Two deliveries of one success both map
 * to `succeeded`, the first moves the payment and the second finds the CAS
 * unsatisfiable — so one ledger transaction, one outbox event and one inventory
 * commit, without this file tracking anything (#45's design, and the reason this
 * handler holds no state of its own).
 */
async function handlePaymentIntent(context: StripeEventContext): Promise<StripeEventOutcome> {
  const intentId = context.objectIds.paymentIntent;
  if (intentId === undefined) {
    throw malformed(`Stripe event ${context.providerEventId} names no PaymentIntent.`);
  }

  // Absent `delivered`, there is no payload to reason about and the live object
  // is the only truth available — so a retry starts from Stripe rather than from
  // a redacted snapshot. See this file's docblock.
  let intent = context.delivered?.data.object as Stripe.PaymentIntent | undefined;
  let refetched = false;
  if (!intent) {
    intent = await retrieveStripePaymentIntent(intentId, context.account);
    refetched = true;
  }

  const payment = await resolvePayment({ metadata: intent.metadata, providerObjectId: intentId });
  if (!payment) {
    throw unresolved(
      `No Mercaria payment matches Stripe PaymentIntent ${intentId}; it may not be visible yet.`,
    );
  }

  let next = mapPaymentIntentStatus(intent.status);

  // The payload's status is either one this version does not interpret, or one
  // the payment cannot legally reach from where it is. Both mean the same thing:
  // decide from Stripe's current state, not from this snapshot.
  if (
    !refetched &&
    (next === undefined || (next !== payment.status && !canTransitionPaymentStatus(payment.status, next)))
  ) {
    intent = await retrieveStripePaymentIntent(intentId, context.account);
    next = mapPaymentIntentStatus(intent.status);
    refetched = true;
  }

  if (next === undefined) {
    return {
      kind: 'ignored',
      paymentId: payment.id,
      note: `Stripe PaymentIntent ${intentId} is '${intent.status}', which this version does not map to a payment status.`,
    };
  }

  if (next === payment.status) {
    return {
      kind: 'applied',
      paymentId: payment.id,
      note: `payment is already '${next}'${refetched ? ' (confirmed by re-reading Stripe)' : ''}`,
    };
  }

  if (!canTransitionPaymentStatus(payment.status, next)) {
    return await handleUnreachableStatus({ context, payment, next, intentId });
  }

  const failure = intent.last_payment_error;
  // A success is the ONE transition that has to carry money detail with it: what
  // the charge became on the platform balance, and what Stripe kept. Shared with
  // #50's reconciliation sweep, which has to book the identical figures when it
  // converges a payment nobody was told about — see `settlement-read.ts`.
  const settlement = next === 'succeeded' ? await readStripeSettlement(intent) : undefined;
  const result = await applyPaymentStatus({
    paymentId: payment.id,
    next,
    providerObjectId: intentId,
    providerEventId: context.providerEventId,
    ...(settlement ? { platform: settlement.platform, feeMinor: settlement.feeMinor } : {}),
    ...(failure?.code ? { errorCode: failure.code } : {}),
    ...(failure?.message ? { errorMessage: failure.message } : {}),
  });

  return {
    kind: 'applied',
    paymentId: payment.id,
    ...(result.changed
      ? {}
      : { note: `a concurrent delivery reached '${next}' first; nothing was applied twice` }),
  };
}

/**
 * Stripe's current state is one the payment cannot reach — decide honestly.
 *
 * After the re-read above there is exactly one case that matters: Stripe says
 * `succeeded` and Mercaria says `canceled`. That is a capture for a payment
 * whose reservation timed out and whose orders were released, and it is the
 * exception #48 must route rather than swallow (ordering 6). Everything else
 * landing here — a `succeeded` payment being told about a cancelled intent, a
 * refunded payment being told about a success — is a delivery describing a past
 * Mercaria has already moved beyond, and recording that is the whole of the
 * correct response.
 */
async function handleUnreachableStatus(input: {
  context: StripeEventContext;
  payment: PaymentRow;
  next: PaymentStatus;
  intentId: string;
}): Promise<StripeEventOutcome> {
  const { context, payment, next, intentId } = input;

  if (next === 'succeeded' && payment.status === 'canceled') {
    const outboxEventId = await flagSucceededAfterRelease({
      paymentId: payment.id,
      providerEventId: context.providerEventId,
    });
    return {
      kind: 'applied',
      paymentId: payment.id,
      note:
        `EXCEPTION: Stripe captured ${intentId} after Mercaria released the payment. No ` +
        'inventory, order or ledger change was made; raised for an operator decision (#50)' +
        `${outboxEventId === undefined ? ' — already raised by an earlier delivery' : ` as ${outboxEventId}`}.`,
    };
  }

  return {
    kind: 'ignored',
    paymentId: payment.id,
    note: `Stripe reports '${next}' for ${intentId} but the payment is '${payment.status}', which cannot reach it; this delivery describes a state Mercaria has moved past.`,
  };
}

/**
 * A charge event: reconcile Stripe's FEE against what the ledger booked.
 *
 * `charge.succeeded` reports the same money movement as
 * `payment_intent.succeeded`, so applying status from BOTH would be two paths to
 * one fact — and the PaymentIntent is the one ADR 0001 D3/D4 makes authoritative
 * (one intent per checkout group, and it is what carries the metadata). What the
 * charge adds is the `balance_transaction`, and therefore Stripe's processing
 * FEE, which the ledger's `processor_expense` leg needs (ADR D5).
 *
 * #47 already captured that fee inside the compare-and-swap that booked the
 * charge. What this handler exists for is the case where it CHANGES afterwards —
 * Stripe restates a fee occasionally, and `charge.updated` is how it says so.
 *
 * ## A correction, never a reopened transaction
 *
 * #45 has exactly one mechanism for a mistake in the book: a NEW balanced
 * transaction whose entries offset the wrong ones (`adjustment`). The
 * `charge_succeeded` transaction is never touched — a `BEFORE UPDATE` trigger
 * would refuse it anyway, and that trigger exists because a ledger somebody can
 * edit is a ledger nobody can rely on.
 *
 * The correction is computed as a DIFFERENCE against everything already booked
 * for this payment, not against the last correction, which is what makes it
 * converge: once the sum of `processor_expense` equals the fee Stripe reports, a
 * redelivery computes a delta of zero and writes nothing. That property comes
 * out of the arithmetic rather than out of a claim on a row, which is why this
 * handler needs no compare-and-swap of its own.
 *
 * ## The transfer_data anomaly
 *
 * ADR 0001 D3 chooses separate charges and transfers EXCLUSIVELY, so a charge
 * Mercaria created carries no `transfer_data` and no `transfer`. One that does
 * is a destination charge, which means funds went straight to a connected
 * account and the whole per-order settlement model has been bypassed for it.
 * That cannot be repaired here and it must not be silent, so it is logged at
 * `error` and written into the trace.
 */
async function handleCharge(context: StripeEventContext): Promise<StripeEventOutcome> {
  const chargeId = context.objectIds.charge;
  if (chargeId === undefined) {
    throw malformed(`Stripe event ${context.providerEventId} names no charge.`);
  }
  const intentId = context.objectIds.paymentIntent;
  const payment = intentId ? await resolvePayment({ providerObjectId: intentId }) : undefined;
  if (!payment) {
    return {
      kind: 'ignored',
      note: `Stripe charge ${chargeId} matches no Mercaria payment; recorded as evidence.`,
    };
  }

  // The stored payload is redacted and a delivered one is a snapshot, so the fee
  // is re-read from Stripe with its balance transaction expanded — the same read
  // `readSettlement` performs, and the only place the current figure exists.
  const charge = await retrieveStripeChargeWithBalance(chargeId);
  const notes: string[] = [];

  const anomaly = destinationChargeAnomaly(charge);
  if (anomaly) {
    log.general.error(
      { paymentId: payment.id, chargeId, anomaly },
      '[Stripe] a charge funding a Mercaria payment carries destination-charge fields; ADR 0001 ' +
        'D3 uses separate charges and transfers exclusively, so this charge bypassed the ' +
        'per-order settlement model and needs an operator (#50)',
    );
    notes.push(`ANOMALY: ${anomaly}`);
  }

  const correction = await correctProcessorFee({ payment, charge });
  notes.push(correction);

  return { kind: 'applied', paymentId: payment.id, note: notes.join('; ') };
}

/**
 * Book the difference between the fee Stripe now reports and the fee booked.
 *
 * Returns a note either way, because "the fee is unchanged" is the answer this
 * handler gives almost every time and a trace that said nothing would leave a
 * reader unable to tell it from a handler that did not run.
 */
async function correctProcessorFee(input: {
  payment: PaymentRow;
  charge: Stripe.Charge;
}): Promise<string> {
  const balance: unknown = input.charge.balance_transaction;
  if (typeof balance !== 'object' || balance === null) {
    // For a card charge Stripe creates the balance transaction with the charge,
    // so this is the asynchronous-method case ADR 0001 D3 excludes from the
    // launch. Nothing to compare against, and inventing a zero would book a
    // correction that removes a fee Mercaria really paid.
    return 'no balance transaction on the charge yet; no fee correction possible';
  }
  const transaction = balance as Stripe.BalanceTransaction;
  const reported = BigInt(transaction.fee);
  const currency = transaction.currency.toUpperCase() as CurrencyCode;

  const booked = await sumLedgerAccountForPayment(input.payment.id, 'processor_expense', currency);
  const delta = reported - booked;
  if (delta === 0n) {
    return `Stripe's fee (${String(reported)} ${currency}) matches what was booked`;
  }

  // Debit the expense by the difference and take the same amount out of (or back
  // into) the platform clearing balance, which is where a restated fee actually
  // moves. Both legs in the platform currency, so the transaction balances per
  // currency exactly as every other posting does.
  const posting = adjustment({
    description:
      `Stripe restated the processing fee on charge ${input.charge.id} for payment ` +
      `${input.payment.id}: booked ${String(booked)}, now ${String(reported)} ${currency}`,
    paymentId: input.payment.id,
    entries: [
      { account: 'processor_expense', currency, amountMinor: delta },
      { account: 'provider_clearing', currency, amountMinor: -delta },
    ],
  });
  const db = getDb();
  const inserted = await db.transaction(
    async (tx) => await insertLedgerTransaction(tx, posting.transaction, posting.entries),
  );

  log.general.warn(
    {
      paymentId: input.payment.id,
      chargeId: input.charge.id,
      bookedMinor: String(booked),
      reportedMinor: String(reported),
      ledgerTransactionId: inserted.id,
    },
    '[Stripe] processing fee restated; booked a correcting ledger transaction',
  );
  return `fee correction ${String(delta)} ${currency} booked as ${inserted.id}`;
}

/**
 * What has already been booked to one account for one payment, in one currency.
 *
 * Summed across EVERY transaction naming the payment, not just the original
 * charge, which is what makes a second correction a no-op: the previous one is
 * part of the total the next delta is measured against.
 */
async function sumLedgerAccountForPayment(
  paymentId: string,
  account: LedgerAccount,
  currency: CurrencyCode,
): Promise<bigint> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}), 0)::text` })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerTransactions.paymentId, paymentId),
        eq(ledgerEntries.account, account),
        eq(ledgerEntries.currency, currency),
      ),
    );
  return BigInt(row?.total ?? '0');
}

/** The destination-charge fields ADR 0001 D3 says a Mercaria charge never has. */
function destinationChargeAnomaly(charge: Stripe.Charge): string | undefined {
  const parts: string[] = [];
  if (charge.transfer_data) parts.push('transfer_data');
  if (charge.transfer) parts.push('transfer');
  if (charge.on_behalf_of) parts.push('on_behalf_of');
  if (parts.length === 0) return undefined;
  return `charge ${charge.id} carries ${parts.join(', ')}, which separate charges and transfers never sets`;
}

/**
 * A refund event: converge Mercaria's refund record on what the rail now says.
 *
 * ## It never creates a refund, and that is the whole of the safety here
 *
 * A Stripe refund with no Mercaria record behind it is a refund somebody made in
 * the Stripe dashboard, or one an issuer forced. Turning it into a local refund
 * would restock goods nobody returned, decrement a customer's lifetime spend and
 * move an order's status — all for a decision Mercaria did not take and cannot
 * see the reasoning for. So it becomes an operator exception
 * (`refund_unmatched`) and changes nothing (#49, scope 10).
 *
 * ## Correlation is by Mercaria's own id first
 *
 * The refund's `metadata.refundId` is written when Mercaria creates it, exactly
 * as a PaymentIntent's `metadata.paymentId` is — so a delivery arriving in the
 * window before the local row has recorded the provider id still resolves. The
 * provider-id lookup is the fallback. Nothing else is ever consulted: not the
 * charge, not the customer, not the amount, because a refund matched by amount
 * is a refund matched to the wrong one of two identical partial refunds.
 *
 * ## No inventory, ever
 *
 * Issue #49 invariant 2, and it is worth stating in the handler rather than only
 * in a test: restock happened once, in `refund.service`, from the lines a
 * merchant approved. A provider outcome arriving days later moves money and
 * nothing else.
 */
async function handleRefund(context: StripeEventContext): Promise<StripeEventOutcome> {
  const refunds = await refundsNamedBy(context);
  if (refunds.length === 0) {
    return {
      kind: 'ignored',
      note: `Stripe ${context.type} named no refund this version can read.`,
    };
  }

  const notes: string[] = [];
  let paymentId: string | undefined;
  for (const refund of refunds) {
    const outcome = await convergeRefund(refund);
    if (outcome.paymentId) paymentId = outcome.paymentId;
    notes.push(outcome.note);
  }

  return {
    kind: 'applied',
    ...(paymentId ? { paymentId } : {}),
    note: notes.join('; '),
  };
}

/**
 * Every Stripe refund one delivery is about.
 *
 * Two event shapes, one list: `charge.refund.updated` carries a REFUND, while
 * `charge.refunded` carries the CHARGE and the refunds are inside it. Reading
 * both here rather than in two handlers keeps the convergence below written
 * once — the two events say the same kind of thing and differ only in packaging.
 *
 * Everything is re-read from Stripe rather than taken from `delivered`, for the
 * usual reason and one sharper one: a refund genuinely MOVES after its event
 * (`pending` to `succeeded`, or to `failed` when an issuer bounces it days
 * later), so a snapshot is the state that was, and applying it would be how a
 * failed refund gets recorded as complete.
 */
async function refundsNamedBy(context: StripeEventContext): Promise<Stripe.Refund[]> {
  const refundId = context.objectIds.refund;
  if (refundId !== undefined) {
    return [await retrieveStripeRefund(refundId)];
  }

  const chargeId = context.objectIds.charge;
  if (chargeId === undefined) return [];
  const charge = await retrieveStripeChargeWithRefunds(chargeId);
  const listed = charge.refunds?.data ?? [];
  // Each is re-read individually, because the refunds expanded on a charge do
  // NOT carry their own balance transaction — which is the figure the ledger
  // needs and the one thing that cannot be guessed.
  return await Promise.all(listed.map(async (entry) => await retrieveStripeRefund(entry.id)));
}

/** Converge ONE Stripe refund onto Mercaria's record of it, or raise it. */
async function convergeRefund(
  refund: Stripe.Refund,
): Promise<{ paymentId?: string; note: string }> {
  const db = getDb();
  const declared = refund.metadata?.refundId;
  const local =
    (typeof declared === 'string' && declared !== ''
      ? await findRefundById(declared)
      : null) ?? (await findRefundByProviderRefundId('stripe', refund.id));

  if (!local) {
    const raised = await recordUnmatchedRefund(refund);
    return {
      note:
        `EXCEPTION: Stripe refund ${refund.id} matches no Mercaria refund; NO local refund was ` +
        `created and NO stock was restocked${raised ? ` — raised as ${raised}` : ' — already raised'}`,
    };
  }

  const state = mapRefundStatus(refund.status);
  const failureCode = refund.failure_reason ?? undefined;
  const changed = await applyRefundProviderState(db, {
    refundId: local.id,
    providerState: state,
    ...(failureCode ? { failureCode } : {}),
  });

  // A refund that FAILS after Mercaria booked it is money that came back to the
  // platform balance for a refund the commerce record says happened. Both halves
  // need a person: the ledger correction and the decision about the order.
  if (changed && (state === 'failed' || state === 'canceled')) {
    await recordRefundOutcomeException(local, state, failureCode);
  }

  return {
    ...(local.paymentId ? { paymentId: local.paymentId } : {}),
    note: changed
      ? `refund ${local.id} is now '${state}' at the rail`
      : `refund ${local.id} was already '${state}'; nothing applied twice`,
  };
}

/**
 * A dispute event: record it, book what it moved, and recover on a loss.
 *
 * All three `charge.dispute.*` types land here because they are three
 * observations of ONE object and Stripe orders none of them — a `closed` can
 * arrive before a `created` Mercaria never received. `dispute.service` upserts
 * the row and gates each ledger transition on a compare-and-swap, so any arrival
 * order converges on the same books.
 *
 * The dispute is re-read from Stripe rather than applied from the payload, and
 * here that matters more than usual: the amount and the FEE come from the
 * dispute's own balance movements, which an inquiry does not have at all, and
 * applying a stale snapshot could book a debit for a dispute that is still only
 * a warning.
 */
async function handleDispute(context: StripeEventContext): Promise<StripeEventOutcome> {
  const disputeId = context.objectIds.dispute;
  if (disputeId === undefined) {
    throw malformed(`Stripe event ${context.providerEventId} names no dispute.`);
  }

  const dispute = await retrieveStripeDispute(disputeId);
  const intentId =
    context.objectIds.paymentIntent ??
    (typeof dispute.payment_intent === 'string' ? dispute.payment_intent : undefined);
  const payment = intentId ? await resolvePayment({ providerObjectId: intentId }) : undefined;
  if (!payment) {
    throw unresolved(
      `No Mercaria payment matches the charge Stripe dispute ${disputeId} was raised against; ` +
        'it may not be visible yet.',
    );
  }

  const movement = disputeBalanceMovement(dispute);
  const status = mapDisputeStatus(dispute.status);
  const summary = await recordDispute(
    {
      provider: 'stripe',
      providerDisputeId: dispute.id,
      amount: movement.amount,
      feeMinor: movement.feeMinor,
      status,
      ...(dispute.reason ? { reason: dispute.reason } : {}),
      ...(disputeEvidenceDueBy(dispute) ? { evidenceDueBy: disputeEvidenceDueBy(dispute) } : {}),
      ...(status === 'won' || status === 'lost' ? { outcome: status } : {}),
    },
    payment.id,
  );

  const parts = [`dispute ${summary.disputeId} is '${status}'`];
  if (summary.booked) parts.push('opening debit booked');
  if (summary.closed) parts.push('closed');
  if (summary.recovery) parts.push(`seller recovery: ${summary.recovery}`);
  if (movement.amount.amount === 0) {
    parts.push('no balance movement — an inquiry, so nothing was booked');
  }

  return { kind: 'applied', paymentId: payment.id, note: parts.join('; ') };
}

/**
 * What a dispute actually took off the platform balance, and the fee with it.
 *
 * Read from `balance_transactions`, and an EMPTY list is the honest zero: an
 * inquiry carries a deadline and moves no money. Falling back to
 * `dispute.amount` would look more informative and would be wrong in the one
 * case that matters — it is populated for an inquiry too, so a fallback would
 * debit the ledger for a chargeback that has not happened.
 *
 * The list can hold more than one entry (a dispute that was won and re-opened),
 * so both figures are summed rather than read off the first.
 */
function disputeBalanceMovement(dispute: Stripe.Dispute): { amount: Money; feeMinor: number } {
  const transactions = dispute.balance_transactions;
  let net = 0;
  let fee = 0;
  let currency = dispute.currency;
  for (const transaction of transactions) {
    net += transaction.amount;
    fee += transaction.fee;
    currency = transaction.currency;
  }
  return {
    // A withdrawal is reported negative and the magnitude is what the accounts
    // hold; the ledger's sign convention belongs to the posting builders.
    amount: {
      amount: Math.abs(net) - Math.abs(fee) >= 0 ? Math.abs(net) - Math.abs(fee) : Math.abs(net),
      currency: currency.toUpperCase() as CurrencyCode,
    },
    feeMinor: Math.abs(fee),
  };
}

/** When evidence is due, when Stripe says. */
function disputeEvidenceDueBy(dispute: Stripe.Dispute): Date | undefined {
  const due = dispute.evidence_details?.due_by;
  return typeof due === 'number' ? new Date(due * 1_000) : undefined;
}

/**
 * A Stripe refund Mercaria did not make.
 *
 * Recorded as an exception and NOT as a refund — see `handleRefund`. Keyed on
 * the rail's own refund id because that is the only durable id this condition
 * has, so every redelivery converges on one operator case.
 */
async function recordUnmatchedRefund(refund: Stripe.Refund): Promise<string | undefined> {
  const db = getDb();
  const id = refundUnmatchedEventId('stripe', refund.id);
  const created = await db.transaction(
    async (tx) =>
      await enqueuePaymentEvent(tx, {
        id,
        eventType: 'refund_unmatched',
        payload: {
          provider: 'stripe',
          providerRefundId: refund.id,
          amountMinor: refund.amount,
          currency: refund.currency.toUpperCase(),
          status: refund.status ?? 'unknown',
          ...(typeof refund.charge === 'string' ? { providerChargeId: refund.charge } : {}),
        },
      }),
  );
  return created ? id : undefined;
}

/** A refund Mercaria booked that the rail has since failed or cancelled. */
async function recordRefundOutcomeException(
  local: { id: string; orderId: string; paymentId: string | null },
  state: string,
  failureCode: string | undefined,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id: refundFailedEventId(local.id),
      eventType: 'refund_failed',
      payload: {
        refundId: local.id,
        orderId: local.orderId,
        ...(local.paymentId ? { paymentId: local.paymentId } : {}),
        reason: `the rail reported the refund '${state}' after Mercaria had recorded it`,
        ...(failureCode ? { failureCode } : {}),
      },
    });
  });
}

/** Stripe's transfer object, mapped onto Mercaria's transfer lifecycle. */
function transferStatusFrom(transfer: Stripe.Transfer): TransferStatus {
  // Stripe's `reversed` is true only on a FULL reversal. A partial one leaves
  // the transfer live with a non-zero `amount_reversed`, which is exactly why
  // Mercaria stores an amount beside the status rather than a boolean.
  if (transfer.reversed) return 'reversed';
  // A Stripe transfer carries no status of its own: it either exists, in which
  // case the funds reached the connected account's balance, or the create call
  // failed and no object was made. So an existing, unreversed transfer is paid.
  return 'paid';
}

/**
 * A transfer event: refresh the row if Mercaria made one, defer otherwise.
 *
 * Mercaria creates one transfer per seller order once a charge succeeds (#47),
 * so a delivery normally finds its row and refreshes it. A transfer with NO row
 * is still an ordinary case rather than an error: an operator's manual transfer
 * in the Stripe dashboard, or an object from another environment, and recording
 * that is more useful than failing.
 *
 * The `transfer_changed` domain event is emitted now that #49 has landed its
 * handler. Its id carries the STATUS, so each state a transfer reaches is
 * announced once and every redelivery of that state is a genuine no-op — keying
 * on the transfer alone would announce it once and never again.
 */
async function handleTransfer(context: StripeEventContext): Promise<StripeEventOutcome> {
  const transferId = context.objectIds.transfer;
  if (transferId === undefined) {
    throw malformed(`Stripe event ${context.providerEventId} names no transfer.`);
  }

  const db = getDb();
  const row = await findTransferByProviderObjectId(db, 'stripe', transferId);
  if (!row) {
    return {
      kind: 'ignored',
      note: `Stripe transfer ${transferId} matches no Mercaria transfer row; it was not made by this system.`,
    };
  }

  // Same rule as the PaymentIntent handler, and it bites harder here: a reversal
  // total is CUMULATIVE, so a delivery replayed hours later carries a figure
  // that has since moved.
  const transfer =
    (context.delivered?.data.object as Stripe.Transfer | undefined) ??
    (await retrieveStripeTransfer(transferId));

  const status = transferStatusFrom(transfer);
  await updateTransferFromProvider(db, {
    transferId: row.id,
    status,
    reversedAmount: transfer.amount_reversed,
  });

  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id: transferChangedEventId(row.id, status),
      eventType: 'transfer_changed',
      payload: {
        transferId: row.id,
        paymentId: row.paymentId,
        orderId: row.orderId,
        status,
        amountMinor: row.amountAmount,
        currency: row.amountCurrency,
        reversedMinor: transfer.amount_reversed,
      },
    });
  });

  return {
    kind: 'applied',
    paymentId: row.paymentId,
    note: `transfer ${row.id} is '${status}' with ${String(transfer.amount_reversed)} reversed`,
  };
}

/**
 * Connected-account readiness.
 *
 * ## The payload is never applied, only the account id is used
 *
 * `account.updated` carries the whole account, and this handler throws it away
 * and re-reads from Stripe. That is the file's stale-delivery rule at its
 * sharpest: an account's requirements are the most volatile thing Stripe
 * reports, deliveries are unordered, and a retry hours later would otherwise
 * restore requirements the seller has already satisfied — turning a ready seller
 * unready with no way to notice. So this reads `event.account` and nothing else.
 *
 * `account.external_account.updated` (a bank account or debit card changed)
 * takes the same path: the payload describes the external account, but what
 * Mercaria needs to know is whether `payouts_enabled` moved as a result, which
 * is a property of the ACCOUNT.
 *
 * ## Deauthorization is the one that must not re-read
 *
 * `account.application.deauthorized` means the platform's access is gone, so the
 * retrieve every other branch performs would fail — and a failure on that path
 * is retryable, so the account would be retried until it dead-lettered instead of
 * being marked revoked. It is applied directly.
 *
 * An account id nothing here knows is `ignored`, not an error: it is an account
 * from another environment or one whose row a rebuilt database lost, and there
 * is no work a retry could complete.
 */
async function handleAccount(context: StripeEventContext): Promise<StripeEventOutcome> {
  // `event.account` on a connect-scope delivery; `objectIds.account` is the same
  // id read off the object, and is what a platform-scope replay of an `account`
  // object would carry. Neither is client-supplied — both come off the verified
  // event (issue #48, identity boundaries 3).
  const accountId = context.account ?? context.objectIds.account;
  if (accountId === undefined) {
    throw malformed(`Stripe event ${context.providerEventId} names no connected account.`);
  }

  if (context.type === 'account.application.deauthorized') {
    const revoked = await revokeAccount(accountId);
    return revoked
      ? {
          kind: 'applied',
          note: `connected account ${redactAccountId(accountId)} is revoked; the seller can no longer be paid and their checkout groups are refused`,
        }
      : {
          kind: 'ignored',
          note: `Stripe deauthorized ${redactAccountId(accountId)}, which Mercaria has no provider-account row for.`,
        };
  }

  const row = await syncAccountState(accountId);
  if (!row) {
    return {
      kind: 'ignored',
      note: `Stripe reported ${context.type} for ${redactAccountId(accountId)}, which Mercaria has no provider-account row for.`,
    };
  }

  return {
    kind: 'applied',
    note: `connected account ${redactAccountId(accountId)} re-read from Stripe; it is '${row.onboardingState}'`,
  };
}

/**
 * Payout health — the rail moving a SELLER's balance to their bank.
 *
 * Connect scope, so `context.account` is the connected account the payout is
 * FROM, and it is what `provider_accounts` resolves to a store or an Oxy user.
 * That mapping is the whole reason this can be recorded at all: an unattributable
 * payout is a row nothing could ever surface.
 *
 * ## It books nothing, and that absence is the point
 *
 * ADR 0001 D6 settles the merchant receivable when the TRANSFER is created; from
 * there the money is on the seller's own balance. A failed payout must NOT
 * reopen that receivable, or Mercaria would owe a seller twice for one order.
 * What it produces instead is a record and a domain event, which is exactly what
 * "payout health" means.
 *
 * The payout is re-read from the connected account rather than applied from the
 * payload — the usual rule, and it needs the `Stripe-Account` header where a
 * transfer does not, because a payout belongs to the seller's account and a
 * platform-scoped read of one answers `resource_missing`.
 */
async function handlePayout(context: StripeEventContext): Promise<StripeEventOutcome> {
  const payoutId = context.objectIds.payout;
  if (payoutId === undefined) {
    throw malformed(`Stripe event ${context.providerEventId} names no payout.`);
  }
  const accountId = context.account ?? context.objectIds.account;
  if (accountId === undefined) {
    throw malformed(
      `Stripe payout ${payoutId} names no connected account; it cannot be attributed to a seller.`,
    );
  }

  const payout = await retrieveStripePayout(payoutId, accountId);
  const recorded = await recordPayout({
    providerAccountId: accountId,
    providerObjectId: payout.id,
    amount: {
      amount: payout.amount,
      // NOT narrowed to `ALL_CURRENCY_CODES`, deliberately: a seller settles in
      // their account's own currency, which may be one Mercaria never prices in.
      // `payouts.amount_currency` carries no CHECK for exactly this reason.
      currency: payout.currency.toUpperCase() as CurrencyCode,
    },
    status: mapPayoutStatus(payout.status),
    ...(typeof payout.arrival_date === 'number'
      ? { arrivalAt: new Date(payout.arrival_date * 1_000) }
      : {}),
    ...(payout.failure_code ? { failureCode: payout.failure_code } : {}),
  });

  if (payout.status === 'failed') {
    // A seller expecting money that did not arrive will contact support, and the
    // answer has to already be here. `error` and not `warn` for the same reason
    // a withheld transfer is: it is not something to discover from a log sample.
    log.general.error(
      {
        payoutId: recorded.row.id,
        sellerKey: recorded.sellerKey,
        failureCode: payout.failure_code,
        amount: payout.amount,
        currency: payout.currency,
      },
      '[Payments] a seller payout failed at the rail; their balance is unchanged and the rail ' +
        'will usually retry, but this is what a support request will be about (#50)',
    );
  }

  return {
    kind: 'applied',
    note:
      `payout ${recorded.row.id} is '${recorded.row.status}' for ` +
      `${recorded.sellerKey ?? 'an account Mercaria has no row for'}`,
  };
}

/**
 * Stripe's payout status, mapped onto Mercaria's.
 *
 * `in_transit` is kept distinct from `pending` because a seller reading their
 * dashboard cares: one means the rail has not started, the other that the money
 * is on its way to their bank and the arrival date means something.
 *
 * An unrecognised status maps to `pending`, the fail-safe direction — a payout
 * reported as not yet arrived is re-read and converges, while defaulting to
 * `paid` would tell a seller money had landed on the strength of a word this
 * code does not know.
 */
function mapPayoutStatus(status: string): PayoutStatus {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'in_transit':
      return 'in_transit';
    default:
      return 'pending';
  }
}

/**
 * Every event type this version routes.
 *
 * The ADR's two subscription lists, plus `payment_intent.requires_action`: it is
 * in neither list because Mercaria does not subscribe to it (the buyer's own
 * client already knows an SCA challenge is pending — that is what a client
 * secret is for), but it maps through the same PaymentIntent handler and costs
 * nothing, so an operator who adds it to an endpoint gets correct behaviour
 * rather than an unhandled type.
 */
const HANDLERS: Readonly<Record<string, StripeEventHandler>> = {
  'payment_intent.succeeded': handlePaymentIntent,
  'payment_intent.payment_failed': handlePaymentIntent,
  'payment_intent.processing': handlePaymentIntent,
  'payment_intent.canceled': handlePaymentIntent,
  'payment_intent.requires_action': handlePaymentIntent,
  'charge.succeeded': handleCharge,
  'charge.updated': handleCharge,
  'charge.refunded': handleRefund,
  'charge.refund.updated': handleRefund,
  'charge.dispute.created': handleDispute,
  'charge.dispute.updated': handleDispute,
  'charge.dispute.closed': handleDispute,
  'transfer.created': handleTransfer,
  'transfer.updated': handleTransfer,
  'transfer.reversed': handleTransfer,
  'account.updated': handleAccount,
  'account.application.deauthorized': handleAccount,
  'account.external_account.updated': handleAccount,
  'payout.paid': handlePayout,
  'payout.failed': handlePayout,
};

/** The handler for an event type, or `undefined` when there is none. */
export function routeStripeEvent(eventType: string): StripeEventHandler | undefined {
  return HANDLERS[eventType];
}

/** Every type this version routes. Test support and the ADR-list assertion. */
export function routedStripeEventTypes(): readonly string[] {
  return Object.keys(HANDLERS);
}
