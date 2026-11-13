/**
 * Turning a verified Peable event into a Mercaria payment status.
 *
 * Much shorter than `stripe/stripe-event-router.ts`, and the reason is the whole
 * point of ADR 0009: the gateway has already interpreted the acquirer. Stripe's
 * router re-reads the `PaymentIntent`, walks `latest_charge` to a balance
 * transaction, maps four object types and reconciles a status it did not expect.
 * Peable sends a decided event about one object, so this maps and applies.
 *
 * ## When it re-reads, and when it does not
 *
 * A `payment_intent.*` event is not re-read. Stripe's router re-reads because a
 * Stripe event is a snapshot that may be stale by the time a retry runs; here
 * the event type IS the assertion — `payment_intent.succeeded` does not become
 * untrue later — and `applyPaymentStatus`'s compare-and-swap already discards a
 * late duplicate.
 *
 * `charge.refunded` is the exception, because it asserts no status: refunds
 * are not intent statuses (ADR 0019), and whether the payment is now
 * `refunded` or `partially_refunded` is the intent's cumulative
 * `amount_refunded`. That is read from the gateway through the rail's own
 * `getStatus` — never from the stored payload, which is redacted — so the
 * inline path and a replay days later both answer from the gateway's current
 * books.
 *
 * ## The fee gap, stated rather than defaulted
 *
 * A Stripe success carries settlement detail: what the charge became on the
 * platform balance and what the acquirer kept (`settlement-read.ts`). Peable's
 * events carry neither. Its contract now has the figures —
 * `refunds.settlement(intent)`'s gross, fee and net in the SETTLEMENT currency
 * (`null` with a status, never `0`), and the balance transactions — but which
 * of them Mercaria books, and at what rate, is a ledger decision (ADR 0001 D5,
 * D7) this adapter has not been given.
 *
 * So a Peable `succeeded` books its charge with **no processor-fee expense**.
 * That is a real gap and it is recorded in the event's outcome note, not
 * swallowed: `applyPaymentStatus` defaults `feeMinor` to `0n`, which is a
 * silent understatement of a Mercaria EXPENSE (ADR 0001 D5) rather than a wrong
 * commission — the commission is `gross − Σnets` and does not involve the fee at
 * all, and the ledger still balances to zero per currency because the fee line
 * is simply absent rather than unbalanced. Until that decision is made, every
 * Peable success says so on its event row, where reconciliation can find them.
 */

import type { PaymentStatus } from '@mercaria/shared-types';
import { findPaymentByProviderObjectId } from '../../../db/payments/paymentRepository.js';
import { getDb } from '../../../db/postgres.js';
import { log } from '../../../lib/logger.js';
import { PaymentProviderError } from '../provider.js';
import { applyPaymentStatus, canTransitionPaymentStatus } from '../payment.service.js';
import { resolvePaymentProvider } from '../registry.js';
import { isPeablePaymentEvent, PAYMENT_STATUS_FOR_EVENT } from './verify.js';

/** What a handler is given, built from the stored row. */
export interface PeableEventContext {
  /** Mercaria's id for the stored envelope — for logs and correlation. */
  readonly storedEventId: string;
  /** The gateway's own event id. */
  readonly providerEventId: string;
  /** The gateway's event type verbatim, e.g. `payment_intent.succeeded`. */
  readonly type: string;
  /** The gateway ids this event names, stored verbatim and never redacted. */
  readonly objectIds: Readonly<Record<string, string>>;
}

/**
 * What a handler DID.
 *
 * The same three kinds `StripeEventOutcome` uses, and for the same reason: an
 * event the system understood but did not act on has to be distinguishable from
 * one it acted on and from one it will never act on, or the event table stops
 * being readable during an incident.
 */
export interface PeableEventOutcome {
  readonly kind: 'applied' | 'deferred' | 'ignored';
  readonly paymentId?: string;
  readonly note?: string;
}

/**
 * A correlation this task cannot make YET.
 *
 * Retryable on purpose, exactly as in the Stripe router: the gateway can deliver
 * `payment_intent.succeeded` before the transaction that wrote Mercaria's payment
 * row is visible to this task. Failing terminally there would discard a real
 * settlement over a race measured in milliseconds. Backoff plus eventual
 * dead-lettering is what stops it retrying forever.
 */
function unresolved(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage: 'verifyEvent',
    message,
    retryable: true,
  });
}

/**
 * Apply one payment-lifecycle event.
 *
 * The intent id is read from `objectIds`, which the ingress stores UNREDACTED in
 * its own column precisely so correlation never depends on the redacted payload
 * summary — that summary is an operator's view and would hand this function
 * `[redacted]` where the id used to be.
 */
async function applyIntentEvent(
  context: PeableEventContext,
  asserted: PaymentStatus | 'reread',
): Promise<PeableEventOutcome> {
  const intentId = context.objectIds.payment_intent;
  if (!intentId) {
    // Authentic and uncorrelatable. NOT retryable: an envelope with no intent id
    // will never grow one, so retrying is a row that fails eight times and then
    // dead-letters with a misleading history.
    return {
      kind: 'ignored',
      note: `'${context.type}' named no payment intent; nothing to correlate`,
    };
  }

  const payment = await findPaymentByProviderObjectId(getDb(), 'peable', intentId);
  if (!payment) {
    throw unresolved(`no Mercaria payment is linked to Peable intent ${intentId} yet`);
  }

  const next = asserted === 'reread' ? await readPaymentStatus(intentId) : asserted;

  if (payment.status === next) {
    // Already there. Reported as applied rather than ignored because the state
    // the event asserts IS the state of the payment — an operator reading this
    // row wants "yes, and it was already so", not "nothing happened".
    return {
      kind: 'applied',
      paymentId: payment.id,
      note: `payment is already '${next}'`,
    };
  }

  if (!canTransitionPaymentStatus(payment.status, next)) {
    // Deferred, not thrown. The gateway is describing a real transition Mercaria
    // cannot make from where it is — which is evidence of a divergence a person
    // has to look at, and retrying it would never resolve since neither side
    // moves on its own.
    log.general.error(
      {
        paymentId: payment.id,
        providerEventId: context.providerEventId,
        from: payment.status,
        to: next,
        type: context.type,
      },
      '[Peable] the gateway reports a status this payment cannot reach',
    );
    return {
      kind: 'deferred',
      paymentId: payment.id,
      note: `the gateway says '${next}' but the payment is '${payment.status}', which cannot reach it`,
    };
  }

  const result = await applyPaymentStatus({
    paymentId: payment.id,
    next,
    providerObjectId: intentId,
    providerEventId: context.providerEventId,
    // No `platform` and no `feeMinor` — see this file's docblock. Their absence
    // is the honest encoding of "the gateway did not tell us", and it is said
    // out loud in the note below rather than inferred from a zero.
  });

  const noted =
    next === 'succeeded'
      ? 'settled; the gateway supplies no processor-fee detail, so no fee expense was booked'
      : undefined;

  return {
    kind: 'applied',
    paymentId: payment.id,
    ...(result.changed
      ? noted
        ? { note: noted }
        : {}
      : {
          note: `a concurrent delivery reached '${next}' first; nothing was applied twice${
            noted ? ` (${noted})` : ''
          }`,
        }),
  };
}

/**
 * Where the gateway says the payment stands now, read through the rail.
 *
 * The rail being switched off between storing and processing is a transient
 * condition for the event: the row is retried, and dead-lettered if it lasts.
 */
async function readPaymentStatus(intentId: string): Promise<PaymentStatus> {
  const rail = resolvePaymentProvider('peable');
  if (!rail) throw unresolved('the Peable rail is not configured; the payment cannot be re-read');
  return (await rail.getStatus(intentId)).status;
}

/** One event type's behaviour. */
export type PeableEventHandler = (context: PeableEventContext) => Promise<PeableEventOutcome>;

/**
 * The handler for an event type, or `undefined` if this version has none.
 *
 * Derived from `PAYMENT_STATUS_FOR_EVENT` rather than restated, so the map the
 * VERIFIER uses to annotate an envelope and the map the ROUTER acts on cannot
 * disagree — the same class of drift that made the ledger audit stop covering
 * this rail. A type absent from that table has no handler here, and the drain
 * stores it as evidence.
 */
export function routePeableEvent(type: string): PeableEventHandler | undefined {
  if (!isPeablePaymentEvent(type)) return undefined;
  const asserted = PAYMENT_STATUS_FOR_EVENT[type];
  return async (context) => await applyIntentEvent(context, asserted);
}
