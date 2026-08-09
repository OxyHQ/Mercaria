/**
 * What each procurement outbox event type DOES.
 *
 * One exhaustive `switch` over the closed set, so a new event type fails `tsc`
 * here rather than being silently dropped by a `default` branch — the
 * arrangement `services/payments/outbox-handlers.ts` uses, and for the same
 * reason: an outbox whose handler map has a hole delivers work to nowhere and
 * reports success.
 *
 * The two ANNOUNCEMENT types (`purchase_order_accepted`,
 * `purchase_order_rejected`) are deliberately terminal here and carry no
 * behaviour of their own. They are the seam #126 (customer communication), #127
 * (cancellations and returns) and #128 (the procurement ledger) consume: each
 * of those owns a decision this domain must not make — whether to tell a buyer,
 * whether to refund, whether to book a draw against a prefunded balance — and a
 * handler here that guessed at any of them would be the wrong domain deciding.
 * They are marked with a note rather than being left unrouted, so an operator
 * trace shows a seam rather than an unhandled type.
 */

import type { ProcurementOutboxEventType } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import type { ProcurementOutboxRow } from '../../db/supplierOrders/outboxRepository.js';
import { findPurchaseOrderById } from '../../db/procurement/purchaseOrderRepository.js';
import { announceProcurementOutcome } from './procurement-outcome.port.js';
import { sendPurchaseOrderCancellation } from './cancellation.service.js';
import { pollPurchaseOrderStatus } from './polling.service.js';
import { submitPurchaseOrderToSupplier } from './submission.service.js';

/** The id every payload in this domain carries. */
function purchaseOrderIdOf(event: ProcurementOutboxRow): string {
  const value = event.payload['purchaseOrderId'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`procurement outbox row ${event.id} carries no purchaseOrderId`);
  }
  return value;
}

/** Run one claimed row. */
export async function runProcurementOutboxEvent(event: ProcurementOutboxRow): Promise<void> {
  const eventType: ProcurementOutboxEventType = event.eventType;
  switch (eventType) {
    case 'purchase_order_submission': {
      const outcome = await submitPurchaseOrderToSupplier(purchaseOrderIdOf(event));
      log.general.info({ eventId: event.id, ...outcome }, '[Procurement] submission handled');
      return;
    }
    case 'purchase_order_convergence': {
      // Convergence is reached through the submission path, which asks the
      // provider by client reference before it would ever resubmit. There is
      // deliberately no second entry point: two ways into the one decision that
      // prevents a duplicate supplier order is one more than is safe.
      const outcome = await submitPurchaseOrderToSupplier(purchaseOrderIdOf(event));
      log.general.info({ eventId: event.id, ...outcome }, '[Procurement] convergence handled');
      return;
    }
    case 'purchase_order_cancellation': {
      const outcome = await sendPurchaseOrderCancellation(purchaseOrderIdOf(event));
      log.general.info({ eventId: event.id, ...outcome }, '[Procurement] cancellation handled');
      return;
    }
    case 'purchase_order_status_poll': {
      // Throws `ProcurementReschedule` on the ordinary path; the drain reads it
      // as "not done, not failing" and puts the row back.
      await pollPurchaseOrderStatus(purchaseOrderIdOf(event));
      return;
    }
    case 'purchase_order_accepted':
    case 'purchase_order_rejected': {
      // Still announcements, and still terminal HERE. What changed with #123 is
      // that the announcement now reaches a registered CONSUMER rather than
      // only a log line — the compensating refund (D4 step 5) and the cost
      // variance #128 books are decisions this domain must not make, so it
      // hands the fact across a port instead of importing the domain that
      // makes them. #126 and #127 join the same port when they land.
      await notifyProcurementOutcome(eventType, purchaseOrderIdOf(event));
      return;
    }
    case 'purchase_order_exception': {
      // NOT announced. An exception is a condition an OPERATOR resolves, and
      // several of the halting kinds are ambiguous about whether a supplier
      // holds an order — announcing one as a definitive failure would refund a
      // buyer for goods that may already be shipping. #123's compensating
      // refund is driven from the two terminal outcomes above and from an
      // operator's explicit cancellation, never from an open case.
      log.general.debug(
        { eventId: event.id, eventType, purchaseOrderId: event.payload['purchaseOrderId'] },
        '[Procurement] exception recorded; an operator resolves it (#127/#128)',
      );
      return;
    }
  }
}

/**
 * Turn one terminal purchase-order state into the notice its consumer reads.
 *
 * The purchase order is RE-READ rather than taken from the payload, for the
 * reason every `account.*` handler re-reads a Stripe account: an announcement
 * can be delivered late, and the amount a compensating refund is sized from
 * must be the one the row holds now.
 *
 * `rejected`, `expired` and `cancelled` all map to a DEFINITIVE failure and are
 * kept apart, because an operator's next action differs: a rejection is the
 * supplier's answer, an expiry is silence, and a cancellation is Mercaria's own
 * decision. A purchase order in any other state produces no notice at all — a
 * `submitted` or `accepted` order has not failed, and announcing one as a
 * failure would refund a buyer mid-fulfilment.
 */
async function notifyProcurementOutcome(
  eventType: 'purchase_order_accepted' | 'purchase_order_rejected',
  purchaseOrderId: string,
): Promise<void> {
  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) {
    throw new Error(`Purchase order ${purchaseOrderId} does not exist; its outcome is unreadable`);
  }

  if (eventType === 'purchase_order_accepted') {
    if (purchaseOrder.status !== 'accepted') return;
    await announceProcurementOutcome({
      kind: 'accepted',
      purchaseOrderId,
      orderId: purchaseOrder.orderId,
      acceptedCostMinor: purchaseOrder.totalAmount,
    });
    return;
  }

  const failure =
    purchaseOrder.status === 'rejected'
      ? 'supplier_rejected'
      : purchaseOrder.status === 'expired'
        ? 'acceptance_expired'
        : purchaseOrder.status === 'cancelled'
          ? 'operator_cancelled'
          : undefined;
  if (failure === undefined) return;

  await announceProcurementOutcome({
    kind: 'failed',
    purchaseOrderId,
    orderId: purchaseOrder.orderId,
    failure,
    detail: `purchase order ${purchaseOrder.status}`,
  });
}
