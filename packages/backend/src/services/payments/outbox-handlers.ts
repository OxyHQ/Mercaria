/**
 * What each payment domain event actually does.
 *
 * Separate from `payment-outbox.service.ts` (which owns claiming, leasing and
 * backoff) and from `outbox-dispatcher.ts` (which owns the loop), so the
 * mechanism can be tested without the effects and the effects without the
 * mechanism — and so `payment.service`'s inline drain and the poller run the
 * SAME function rather than two that look alike.
 *
 * Every handler must be idempotent: the outbox is at-least-once, so a task dying
 * after doing the work and before completing the row means the next task does it
 * again.
 */

import type { PaymentOutboxRow } from '../../db/payments/paymentOutboxRepository.js';
import { transition } from '../order.service.js';
import { findOrdersInCheckoutGroup, loadOrderForTransition } from './order-linkage.js';
import { log } from '../../lib/logger.js';

/** The ids a payment event carries. Never a payload, never a contact value. */
interface PaymentEventPayload {
  paymentId?: string;
  checkoutGroupId?: string;
  errorCode?: string;
  /** Which provider delivery raised an exception, for the operator's trace. */
  providerEventId?: string;
  /** The status the payment was in when the late capture arrived. */
  releasedStatus?: string;
  /** `provider_account_changed`: which account, whose, and where it moved. */
  accountRowId?: string;
  ownerType?: string;
  ownerId?: string;
  previousState?: string;
  onboardingState?: string;
  reason?: string;
}

/** Read the payload without trusting jsonb to have the shape we wrote. */
function readPayload(event: PaymentOutboxRow): PaymentEventPayload {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null) return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.paymentId === 'string' ? { paymentId: record.paymentId } : {}),
    ...(typeof record.checkoutGroupId === 'string'
      ? { checkoutGroupId: record.checkoutGroupId }
      : {}),
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.providerEventId === 'string'
      ? { providerEventId: record.providerEventId }
      : {}),
    ...(typeof record.releasedStatus === 'string'
      ? { releasedStatus: record.releasedStatus }
      : {}),
    ...(typeof record.accountRowId === 'string' ? { accountRowId: record.accountRowId } : {}),
    ...(typeof record.ownerType === 'string' ? { ownerType: record.ownerType } : {}),
    ...(typeof record.ownerId === 'string' ? { ownerId: record.ownerId } : {}),
    ...(typeof record.previousState === 'string' ? { previousState: record.previousState } : {}),
    ...(typeof record.onboardingState === 'string'
      ? { onboardingState: record.onboardingState }
      : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

/**
 * A payment succeeded: every order it funds becomes `paid`.
 *
 * ADR 0001 D4 makes funding atomic at the GROUP level, so this transitions the
 * whole group — sibling orders of one multi-seller cart cannot have different
 * funding outcomes. Divergence between them begins only afterwards, with
 * per-order refunds, cancellations and disputes.
 *
 * ## Idempotent twice over
 *
 * Orders already past `pending_payment` are SKIPPED, and `order.service`'s own
 * compare-and-swap refuses a second transition even if two tasks read the same
 * status at the same moment. The skip is not redundant with the CAS: it is what
 * distinguishes "already done" (nothing to do) from "refused" (a real problem),
 * which the CAS reports identically as a CONFLICT.
 *
 * ## A refusal is left to RETRY, and that is deliberate
 *
 * The one thing that legitimately refuses a `pending_payment` order here is a
 * moderation freeze (`moderationHold`), which exists precisely to stop goods and
 * money moving forward while a case is open. Retrying with backoff is the right
 * answer: if the hold is lifted the order is paid, and if it is not, the row
 * dead-letters after several days as the operator exception it is. Swallowing
 * the refusal would mark the event processed while the buyer's paid order sat at
 * `pending_payment` with nothing anywhere reporting it.
 */
async function handlePaymentSucceeded(event: PaymentOutboxRow): Promise<void> {
  const { paymentId, checkoutGroupId } = readPayload(event);
  if (!checkoutGroupId) {
    throw new Error(`Payment outbox event ${event.id} carries no checkoutGroupId.`);
  }

  const orders = await findOrdersInCheckoutGroup(checkoutGroupId);
  for (const order of orders) {
    if (order.status !== 'pending_payment') continue;
    const doc = await loadOrderForTransition(order.id);
    if (!doc) {
      // The order vanished between the read and the load. Nothing to pay, and
      // nothing this handler can do about it — but it is worth saying loudly,
      // because a paid payment whose order is gone is an operator exception.
      log.general.error(
        { eventId: event.id, paymentId, orderId: order.id },
        '[Payments] order disappeared before its payment could mark it paid',
      );
      continue;
    }
    await transition(doc, 'paid', { note: 'payment succeeded' });
  }

  log.general.info(
    { eventId: event.id, paymentId, checkoutGroupId, orders: orders.length },
    '[Payments] payment succeeded applied to its orders',
  );
}

/**
 * A payment failed.
 *
 * It touches NOTHING (#45 acceptance 4). Specifically it does not release the
 * inventory reservation: the orders stay `pending_payment` and stay cancellable,
 * the buyer can retry, and the existing reservation-TTL sweep is what eventually
 * cancels them — releasing the stock through the ORDER transition that owns that
 * effect. Two things releasing one reservation is how stock goes negative, and a
 * payment failure is the more tempting of the two places to do it.
 *
 * The durable row is the point. Buyer-facing notification of a failed payment is
 * #108's, and it attaches to this event rather than to the provider webhook, so
 * a consumer never receives provider detail.
 */
async function handlePaymentFailed(event: PaymentOutboxRow): Promise<void> {
  const { paymentId, checkoutGroupId, errorCode } = readPayload(event);
  log.general.warn(
    { eventId: event.id, paymentId, checkoutGroupId, errorCode },
    '[Payments] payment failed; orders remain pending_payment and cancellable',
  );
  return await Promise.resolve();
}

/**
 * The rail captured money for a payment whose reservation had already been
 * released.
 *
 * ## It deliberately does nothing but say so, loudly
 *
 * The orders were cancelled and their stock went back before this capture
 * arrived. Re-committing that stock would oversell whatever has been bought
 * since; booking the charge would credit `commission_revenue` with the entire
 * gross, because there are no orders left to split it across; refunding is a
 * policy decision that needs a person. Every automatic answer is worse than the
 * exception, which is why the whole handler is one `error` line carrying the
 * correlation ids and nothing else.
 *
 * `error` and not `warn`: money is sitting on the platform balance against no
 * order, and that must not be discoverable only by someone who happened to be
 * reading the logs. #50 owns the operator surface that reads these rows.
 */
async function handlePaymentSucceededAfterRelease(event: PaymentOutboxRow): Promise<void> {
  const { paymentId, checkoutGroupId, providerEventId, releasedStatus } = readPayload(event);
  log.general.error(
    { eventId: event.id, paymentId, checkoutGroupId, providerEventId, releasedStatus },
    '[Payments] provider captured a payment Mercaria had already released; no inventory, ' +
      'order or ledger change was made — this needs an operator decision (refund or manual ' +
      'fulfilment)',
  );
  return await Promise.resolve();
}

/**
 * A seller's standing with a payment rail changed.
 *
 * The durable audit record issue #46 (backend 8) asks for: account creation,
 * every onboarding transition, and the revocation that ends one. It is an OUTBOX
 * row rather than a new table because the fact is a payment-domain consequence
 * with the same at-least-once delivery needs as every other, and a second audit
 * table would be a second retention policy, a second sweep and a second place to
 * look.
 *
 * The handler deliberately does nothing but record it, at the level the
 * transition deserves — losing readiness stops that seller selling, so it is not
 * an `info` line among thousands. #50 owns the operator surface that reads these
 * rows, and #108 the seller-facing notification; both attach HERE rather than to
 * the Stripe webhook, so neither ever receives provider detail.
 */
async function handleProviderAccountChanged(event: PaymentOutboxRow): Promise<void> {
  const { accountRowId, ownerType, ownerId, previousState, onboardingState, reason } =
    readPayload(event);
  const details = {
    eventId: event.id,
    accountRowId,
    ownerType,
    ownerId,
    from: previousState,
    to: onboardingState,
    reason,
  };

  if (onboardingState === 'ready') {
    log.general.info(details, '[Payments] seller is payment ready');
  } else if (previousState === 'ready') {
    log.general.warn(
      details,
      '[Payments] seller lost payment readiness; their checkout groups are now refused',
    );
  } else {
    log.general.info(details, '[Payments] seller payment onboarding advanced');
  }
  return await Promise.resolve();
}

/**
 * Run one claimed outbox row.
 *
 * An event type this version does not handle THROWS, so it is retried rather
 * than completed as if it had been dealt with — during a rolling deploy the task
 * running the newer code claims it on the next tick. `payment_refunded`,
 * `payment_disputed`, `transfer_changed` and `payout_changed` are in that
 * category today: nothing in this version emits them, and #49 lands their
 * producers and their handlers together.
 */
export async function runPaymentOutboxEvent(event: PaymentOutboxRow): Promise<void> {
  switch (event.eventType) {
    case 'payment_succeeded':
      return await handlePaymentSucceeded(event);
    case 'payment_failed':
      return await handlePaymentFailed(event);
    case 'payment_succeeded_after_release':
      return await handlePaymentSucceededAfterRelease(event);
    case 'provider_account_changed':
      return await handleProviderAccountChanged(event);
    default:
      throw new Error(
        `No handler for payment outbox event type '${String(event.eventType)}' in this version.`,
      );
  }
}
