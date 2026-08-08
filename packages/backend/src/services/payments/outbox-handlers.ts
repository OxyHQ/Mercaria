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
import { settlePaymentTransfers } from './settlement.service.js';
import { log } from '../../lib/logger.js';

/** The ids a payment event carries. Never a payload, never a contact value. */
interface PaymentEventPayload {
  paymentId?: string;
  checkoutGroupId?: string;
  errorCode?: string;
  /** Which provider delivery raised an exception, for the operator's trace. */
  providerEventId?: string;
  /** `transfer_withheld`: which seller order is stuck, and whose. */
  orderId?: string;
  sellerKey?: string;
  /** The status the payment was in when the late capture arrived. */
  releasedStatus?: string;
  /** `provider_account_changed`: which account, whose, and where it moved. */
  accountRowId?: string;
  ownerType?: string;
  ownerId?: string;
  previousState?: string;
  onboardingState?: string;
  reason?: string;
  /** #49's refund, dispute, transfer and payout events. */
  refundId?: string;
  disputeId?: string;
  transferId?: string;
  payoutId?: string;
  status?: string;
  amountMinor?: number;
  currency?: string;
  failureCode?: string;
  subjectKind?: string;
  providerRefundId?: string;
  evidenceDueBy?: string;
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
    ...(typeof record.orderId === 'string' ? { orderId: record.orderId } : {}),
    ...(typeof record.sellerKey === 'string' ? { sellerKey: record.sellerKey } : {}),
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
    ...(typeof record.refundId === 'string' ? { refundId: record.refundId } : {}),
    ...(typeof record.disputeId === 'string' ? { disputeId: record.disputeId } : {}),
    ...(typeof record.transferId === 'string' ? { transferId: record.transferId } : {}),
    ...(typeof record.payoutId === 'string' ? { payoutId: record.payoutId } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.amountMinor === 'number' ? { amountMinor: record.amountMinor } : {}),
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
    ...(typeof record.failureCode === 'string' ? { failureCode: record.failureCode } : {}),
    ...(typeof record.subjectKind === 'string' ? { subjectKind: record.subjectKind } : {}),
    ...(typeof record.providerRefundId === 'string'
      ? { providerRefundId: record.providerRefundId }
      : {}),
    ...(typeof record.evidenceDueBy === 'string' ? { evidenceDueBy: record.evidenceDueBy } : {}),
  };
}

/**
 * A payment succeeded: every order it funds becomes `paid`, and every seller is
 * transferred their share.
 *
 * ADR 0001 D4 makes funding atomic at the GROUP level, so this transitions the
 * whole group — sibling orders of one multi-seller cart cannot have different
 * funding outcomes. Divergence between them begins only afterwards, with
 * per-order refunds, cancellations and disputes.
 *
 * ## Settlement runs AFTER the orders are paid, in this same handler
 *
 * The order is what the buyer is owed and the transfer is what the seller is
 * owed, and doing them in that order means a rail being unreachable cannot delay
 * a purchase the buyer has already completed. The settlement's own failures are
 * per seller and are described in `settlement.service.ts`; a retryable one
 * propagates out of here so the outbox retries the row, which re-runs the paid
 * transitions harmlessly (they are skipped) and resumes settling where it
 * stopped.
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

  if (paymentId) {
    await settlePaymentTransfers(paymentId);
  }
}

/**
 * One seller's share could not leave — ADR 0001 D4's controlled skipped
 * transfer.
 *
 * Like `payment_succeeded_after_release`, this handler deliberately changes
 * nothing. The buyer is paid up and their order is theirs; what is stuck is
 * money Mercaria owes a seller, and the two resolutions — transfer it once the
 * account recovers, or refund the order — are both decisions a person takes.
 * Picking one automatically would either pay an account Stripe has restricted or
 * refund a buyer whose goods are on their way.
 *
 * `error` and not `warn`, for the same reason: an unpaid seller is not something
 * to discover from a log sample. #50 owns the operator surface that reads these
 * rows; #108 the seller-facing notification.
 */
async function handleTransferWithheld(event: PaymentOutboxRow): Promise<void> {
  const { paymentId, checkoutGroupId, orderId, sellerKey, reason } = readPayload(event);
  log.general.error(
    { eventId: event.id, paymentId, checkoutGroupId, orderId, sellerKey, reason },
    '[Payments] a seller transfer was withheld; the order stays paid and its siblings settled ' +
      'normally — this needs an operator decision (transfer once recovered, or refund)',
  );
  return await Promise.resolve();
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
 * A refund's money movement — the ONE handler here that does work rather than
 * announcing it.
 *
 * `refund.service` has already committed the commerce decision and restocked;
 * this is what returns the buyer's money and recovers the seller's share (ADR
 * 0001 D7). It lives behind the outbox because a provider call inside the
 * request that created the refund evaporates on a restart, and what would be
 * left is an order claiming money went back to a buyer who never received it.
 *
 * Failures are the executor's to classify. A retryable one propagates and the
 * row retries with backoff; a permanent one is recorded as an operator exception
 * INSIDE the executor and this handler completes, because the row's job — "make
 * the money move, or make the failure visible" — is then genuinely done and
 * retrying a declined refund twenty-five times only delays the person who has to
 * look at it.
 */
async function handlePaymentRefunded(event: PaymentOutboxRow): Promise<void> {
  const { refundId, paymentId, orderId } = readPayload(event);
  if (!refundId) {
    throw new Error(`Payment outbox event ${event.id} carries no refundId.`);
  }

  const { executeRefundAtProvider } = await import('./refund-execution.service.js');
  const outcome = await executeRefundAtProvider(refundId);
  log.general.info(
    { eventId: event.id, refundId, paymentId, orderId, ...outcome },
    '[Payments] refund executed at its rail',
  );
}

/**
 * A dispute reached a new state.
 *
 * Records and nothing else: `dispute.service` has already booked whatever the
 * state change moved and run the seller-side recovery on a loss, inside the
 * webhook that observed it, so by the time this arrives the money is settled.
 * What this exists for is the CONSUMERS — the operator surface (#50) and the
 * seller notification (#108) — which attach here rather than to the rail's
 * webhook so neither ever receives provider detail.
 *
 * An open dispute is logged at `warn` and a lost one at `error`: one is a
 * deadline somebody has to meet, the other is money already gone.
 */
async function handlePaymentDisputed(event: PaymentOutboxRow): Promise<void> {
  const { disputeId, paymentId, orderId, status, amountMinor, currency, reason, evidenceDueBy } =
    readPayload(event);
  const details = {
    eventId: event.id,
    disputeId,
    paymentId,
    orderId,
    status,
    amountMinor,
    currency,
    reason,
    evidenceDueBy,
  };

  if (status === 'lost') {
    log.general.error(details, '[Payments] a dispute was lost; the seller bears the principal');
  } else if (status === 'won') {
    log.general.info(details, '[Payments] a dispute was won; the held amount was released');
  } else if (status === 'warning') {
    log.general.warn(
      details,
      '[Payments] an inquiry was raised against a charge; no money has moved, and evidence is ' +
        'still due',
    );
  } else {
    log.general.warn(
      details,
      '[Payments] a dispute is open against a charge; the platform balance is already debited ' +
        'and evidence is due (#50)',
    );
  }
  return await Promise.resolve();
}

/**
 * A transfer moved — created, updated or reversed at the rail.
 *
 * The seller-facing half of settlement health. It changes nothing: the transfer
 * row was already refreshed by the handler that observed the event, because that
 * is a compare-and-swap on an observation rather than work, and doing it here
 * instead would put a provider read behind a retry queue for no gain.
 */
async function handleTransferChanged(event: PaymentOutboxRow): Promise<void> {
  const { transferId, paymentId, orderId, status, amountMinor, currency } = readPayload(event);
  log.general.info(
    { eventId: event.id, transferId, paymentId, orderId, status, amountMinor, currency },
    '[Payments] a seller transfer changed state',
  );
  return await Promise.resolve();
}

/**
 * A payout moved — the rail paying a seller's own balance out to their bank.
 *
 * Mercaria is not a party to it (ADR 0001 D6), so this books nothing and
 * reopens nothing. A FAILED payout is logged at `error` because it is what a
 * seller support request will be about, and the answer has to already be here
 * rather than being reconstructed from the rail's dashboard.
 */
async function handlePayoutChanged(event: PaymentOutboxRow): Promise<void> {
  const { payoutId, sellerKey, status, amountMinor, currency, failureCode } = readPayload(event);
  const details = { eventId: event.id, payoutId, sellerKey, status, amountMinor, currency, failureCode };
  if (status === 'failed') {
    log.general.error(
      details,
      '[Payments] a seller payout failed; their receivable is NOT reopened (it was settled at ' +
        'transfer time) and this is a seller-and-rail matter an operator may need to explain',
    );
  } else {
    log.general.info(details, '[Payments] a seller payout changed state');
  }
  return await Promise.resolve();
}

/**
 * The rail refused or failed a refund Mercaria had already recorded.
 *
 * The commerce record says money went back and the stock is already on the
 * shelf; the rail says it did not. Nothing here reconciles that automatically,
 * and every automatic answer is worse than the exception: re-attempting a
 * declined refund loops, and un-doing the commerce record would un-restock units
 * that may have been sold since. So it is one `error` line with the correlation
 * ids, and #50's operator surface is where a person picks it up.
 */
async function handleRefundFailed(event: PaymentOutboxRow): Promise<void> {
  const { refundId, paymentId, orderId, amountMinor, currency, reason, failureCode } =
    readPayload(event);
  log.general.error(
    { eventId: event.id, refundId, paymentId, orderId, amountMinor, currency, reason, failureCode },
    '[Payments] a refund failed at its rail after Mercaria had recorded it; the order and its ' +
      'stock were already moved, so the commerce record and the money now disagree — this needs ' +
      'an operator decision (re-attempt, or reverse the record)',
  );
  return await Promise.resolve();
}

/**
 * The seller-side recovery could not be made.
 *
 * ADR 0001 D7's explicit outcome: the buyer has their money, and Mercaria could
 * not take the seller's share back off their balance. Nothing is retried, and
 * that is the decision — no number of attempts creates funds on a seller's
 * account. The gap is already booked honestly (the order's `merchant_payable`
 * sits in debit by exactly what the seller owes), and recovery is a choice
 * between waiting for their next transfer, a negative-balance debit, and a write
 * off. All three are decisions the payment domain does not get to take.
 *
 * Shared by the refund path and the lost-dispute path, because the condition and
 * the resolution are identical — `subjectKind` says which produced it.
 */
async function handleReversalFailed(event: PaymentOutboxRow): Promise<void> {
  const { subjectKind, refundId, disputeId, paymentId, orderId, amountMinor, currency, reason } =
    readPayload(event);
  log.general.error(
    {
      eventId: event.id,
      subjectKind,
      refundId,
      disputeId,
      paymentId,
      orderId,
      amountMinor,
      currency,
      reason,
    },
    '[Payments] a seller-side recovery failed; the buyer keeps their refund (ADR 0001 D7) and ' +
      "the seller's payable stays open in Mercaria's favour — this needs an operator decision",
  );
  return await Promise.resolve();
}

/**
 * The rail reported a refund Mercaria never made.
 *
 * A refund created in the rail's own dashboard, or one an issuer forced. It was
 * deliberately NOT turned into a local refund — that would restock goods nobody
 * returned and decrement a customer's lifetime spend for a decision Mercaria did
 * not take — so the order, the inventory and the ledger are all untouched and
 * disagree with the rail until a person reconciles them.
 */
async function handleRefundUnmatched(event: PaymentOutboxRow): Promise<void> {
  const { providerRefundId, amountMinor, currency, status } = readPayload(event);
  log.general.error(
    { eventId: event.id, providerRefundId, amountMinor, currency, status },
    '[Payments] the rail reported a refund Mercaria has no record of; no local refund was ' +
      'created and no stock was restocked, so the ledger and the rail now disagree by this ' +
      'amount — this needs an operator decision (#50)',
  );
  return await Promise.resolve();
}

/**
 * Run one claimed outbox row.
 *
 * An event type this version does not handle THROWS, so it is retried rather
 * than completed as if it had been dealt with — during a rolling deploy the task
 * running the newer code claims it on the next tick. As of #49 every declared
 * type has a handler, so that branch is now reachable only by a row a NEWER
 * image wrote, which is exactly the case it exists for.
 */
export async function runPaymentOutboxEvent(event: PaymentOutboxRow): Promise<void> {
  switch (event.eventType) {
    case 'payment_succeeded':
      return await handlePaymentSucceeded(event);
    case 'payment_failed':
      return await handlePaymentFailed(event);
    case 'payment_succeeded_after_release':
      return await handlePaymentSucceededAfterRelease(event);
    case 'transfer_withheld':
      return await handleTransferWithheld(event);
    case 'provider_account_changed':
      return await handleProviderAccountChanged(event);
    case 'payment_refunded':
      return await handlePaymentRefunded(event);
    case 'payment_disputed':
      return await handlePaymentDisputed(event);
    case 'transfer_changed':
      return await handleTransferChanged(event);
    case 'payout_changed':
      return await handlePayoutChanged(event);
    case 'refund_failed':
      return await handleRefundFailed(event);
    case 'reversal_failed':
      return await handleReversalFailed(event);
    case 'refund_unmatched':
      return await handleRefundUnmatched(event);
    default:
      throw new Error(
        `No handler for payment outbox event type '${String(event.eventType)}' in this version.`,
      );
  }
}
