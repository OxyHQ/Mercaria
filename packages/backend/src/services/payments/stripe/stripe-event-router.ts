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
 * that distinction into the event row's `processing_note`. Several of the types
 * ADR 0001 subscribes to still belong to later issues — refunds, disputes and
 * payouts to #49 — and they arrive here TODAY, because an endpoint has to be
 * registered with its full event list before any of them ships or everything
 * that happens in between is simply lost. The three `account.*` types were in
 * that category until #46 and are now applied.
 *
 * Marking those `processed` and saying nothing else would make a deferral
 * indistinguishable from real handling in the operator trace: the row would
 * claim the event had been dealt with, and the first person to notice otherwise
 * would be a seller asking why their account never went live. So a deferred
 * handler names the issue that will consume it, in the row, out loud.
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
import type {
  CurrencyCode,
  FxRateSnapshot,
  Money,
  PaymentStatus,
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
  applyPaymentStatus,
  canTransitionPaymentStatus,
  flagSucceededAfterRelease,
} from '../payment.service.js';
import { PaymentProviderError } from '../provider.js';
import { log } from '../../../lib/logger.js';
import { redactAccountId, revokeAccount, syncAccountState } from './account.service.js';
import {
  retrieveStripeChargeWithBalance,
  retrieveStripePaymentIntent,
  retrieveStripeTransfer,
} from './client.js';
import { mapPaymentIntentStatus } from './verify.js';

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
  // the charge became on the platform balance, and what Stripe kept. See
  // `readSettlement`.
  const settlement = next === 'succeeded' ? await readSettlement(intent) : undefined;
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
 * What the charge became on the PLATFORM balance, and what Stripe kept.
 *
 * ## Why this is read at the moment of success, and not later
 *
 * Both figures come from the charge's BALANCE TRANSACTION, which is the only
 * place Stripe states a charge in the platform's own settlement currency (ADR
 * 0001 D8, fact 5) and the fee it deducted (D5). Every consequence of a success
 * needs them: the ledger books the charge in the currency the money landed in,
 * and the seller transfers are sized from that same figure and must be
 * denominated in that same currency.
 *
 * Reading them here means they are captured INSIDE the compare-and-swap that
 * moves the payment to `succeeded`, so the rate that produced the platform
 * amount is stored with it and the two can never come from different moments.
 * The alternative — booking in presentment now and converting at settlement —
 * would leave `merchant_payable` holding a debt in one currency that was paid in
 * another, which no report could ever net to zero.
 *
 * ## An unavailable balance transaction is RETRYABLE, never assumed
 *
 * For a card charge Stripe creates it with the charge, so this is available
 * essentially always; asynchronous methods are what leave it pending, and ADR
 * 0001 D3 excludes those from the launch precisely because their money moves
 * later than their events. Retrying is the only honest answer when it is
 * missing: guessing a 1:1 conversion would book a USD figure as euros, and
 * defaulting the fee to zero would understate `processor_expense` permanently —
 * a wrong number in the accounts is worse than a late one.
 */
async function readSettlement(intent: Stripe.PaymentIntent): Promise<{
  platform: { amount: Money; rate: FxRateSnapshot };
  feeMinor: bigint;
}> {
  const latest: unknown = intent.latest_charge;
  const chargeId =
    typeof latest === 'string'
      ? latest
      : typeof latest === 'object' && latest !== null && 'id' in latest
        ? String((latest as { id: unknown }).id)
        : undefined;
  if (chargeId === undefined || chargeId === '') {
    throw unresolved(
      `Stripe PaymentIntent ${intent.id} reports 'succeeded' but names no charge; the balance ` +
        'transaction it settles through is not readable yet.',
    );
  }

  const charge = await retrieveStripeChargeWithBalance(chargeId);
  const balance: unknown = charge.balance_transaction;
  if (typeof balance !== 'object' || balance === null) {
    throw unresolved(
      `Stripe charge ${chargeId} has no balance transaction yet; the platform amount and fee ` +
        'cannot be captured, and a success must not be booked without them.',
    );
  }

  const transaction = balance as Stripe.BalanceTransaction;
  return {
    platform: {
      amount: {
        amount: transaction.amount,
        currency: transaction.currency.toUpperCase() as CurrencyCode,
      },
      rate: {
        from: intent.currency.toUpperCase() as CurrencyCode,
        to: transaction.currency.toUpperCase() as CurrencyCode,
        // `null` when no conversion happened, which is the same-currency case
        // and is exactly a rate of one. Stated rather than left absent because
        // the snapshot's whole purpose is to be reproducible, and "there was no
        // rate" and "the rate is unknown" must not look alike.
        rate: transaction.exchange_rate ?? 1,
        provider: 'stripe',
        asOf: new Date(transaction.created * 1_000).toISOString(),
      },
    },
    feeMinor: BigInt(transaction.fee),
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
 * A charge event: correlate it to its payment, and defer the money detail.
 *
 * `charge.succeeded` reports the same money movement as
 * `payment_intent.succeeded`, so applying status from BOTH would be two paths to
 * one fact — and the PaymentIntent is the one ADR 0001 D3/D4 makes authoritative
 * (one intent per checkout group, and it is what carries the metadata). What the
 * charge adds is the `balance_transaction`, and therefore Stripe's processing
 * FEE, which the ledger's `processor_expense` leg needs (ADR D5).
 *
 * That fee is already booked by the time this arrives. #47 reads the balance
 * transaction during the `payment_intent.succeeded` transition, so the fee and
 * the platform-currency amount are captured inside the same compare-and-swap
 * that books the charge — see `readSettlement`.
 *
 * Which leaves this handler with nothing to post and one thing to do: correlate.
 * A fee that CHANGES afterwards (Stripe restates one occasionally) would be a
 * ledger CORRECTION, and #45 has exactly one mechanism for that — a new balanced
 * transaction reversing what was wrong — which is #49's, with the refund and
 * dispute postings that share the shape.
 */
async function handleCharge(context: StripeEventContext): Promise<StripeEventOutcome> {
  const chargeId = context.objectIds.charge ?? 'unknown';
  const intentId = context.objectIds.paymentIntent;
  const payment = intentId ? await resolvePayment({ providerObjectId: intentId }) : undefined;

  return {
    kind: 'deferred',
    ...(payment ? { paymentId: payment.id } : {}),
    note:
      `deferred: #49 — charge ${chargeId} correlated` +
      `${payment ? '' : ' to no Mercaria payment'}; its fee was already booked when the payment ` +
      'succeeded, and restating one is a ledger correction #49 lands.',
  };
}

/**
 * A refund or dispute event: correlate, and defer the money movement.
 *
 * Mercaria's refund domain already owns WHAT is refundable — per-line
 * quantities, no double restock — and ADR 0001 D7 makes Stripe the record of the
 * money rather than the decision. Wiring the two together means a Stripe refund
 * event finding Mercaria's `Refund` record, reversing the seller's proportional
 * share of that order's transfer, and booking both legs. Each of those is #49's,
 * and none is safe to do half of: restocking without the reversal pays a seller
 * for goods that came back.
 *
 * Disputes are the same shape with a harsher failure mode — the platform balance
 * is already debited by the time the event arrives — so recording the
 * correlation now and moving the money in one deliberate change is the only
 * order that leaves no window where the books disagree with Stripe.
 */
async function handleRefundOrDispute(context: StripeEventContext): Promise<StripeEventOutcome> {
  const intentId = context.objectIds.paymentIntent;
  const subject = context.objectIds.refund ?? context.objectIds.dispute ?? context.objectIds.charge;
  const payment = intentId ? await resolvePayment({ providerObjectId: intentId }) : undefined;

  return {
    kind: 'deferred',
    ...(payment ? { paymentId: payment.id } : {}),
    note: `deferred: #49 — ${context.type} (${subject ?? 'no id'}) correlated; the refund and dispute ledger postings and the transfer reversals land there.`,
  };
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
 * No `transfer_changed` domain event is emitted. That outbox type has no handler
 * in this version and throws by design, so emitting it would dead-letter every
 * transfer event; docs/payments.md is explicit that #49 lands its producer and
 * its consumer together.
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
      kind: 'deferred',
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

  return {
    kind: 'applied',
    paymentId: row.paymentId,
    note: `transfer ${row.id} is '${status}' with ${String(transfer.amount_reversed)} reversed; the transfer_changed domain event lands with its handler in #49.`,
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
 * Payout health — #49 owns the records.
 *
 * The reason this stayed deferred is GONE: `provider_accounts` now maps a
 * connected account to a store or an Oxy user, so a `payouts` row written today
 * would be attributable. What is still missing is the rest of #49 — the payout
 * lifecycle, the `payout_changed` domain event and its handler, and the
 * dashboard surface that reads them — and emitting rows without the event that
 * announces them would land half of a feature whose other half nothing calls.
 */
async function handlePayout(context: StripeEventContext): Promise<StripeEventOutcome> {
  return await Promise.resolve({
    kind: 'deferred',
    note: `deferred: #49 — ${context.type} (${context.objectIds.payout ?? 'no id'}); the provider-account mapping now exists, so the payout records and their domain event land together there.`,
  });
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
  'charge.refunded': handleRefundOrDispute,
  'charge.refund.updated': handleRefundOrDispute,
  'charge.dispute.created': handleRefundOrDispute,
  'charge.dispute.updated': handleRefundOrDispute,
  'charge.dispute.closed': handleRefundOrDispute,
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
