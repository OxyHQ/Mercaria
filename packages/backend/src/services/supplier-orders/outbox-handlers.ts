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
    case 'purchase_order_rejected':
    case 'purchase_order_exception': {
      // Seams. See the module docblock: the consumers are #126, #127 and #128,
      // and each owns a decision this domain must not make.
      log.general.debug(
        { eventId: event.id, eventType, purchaseOrderId: event.payload['purchaseOrderId'] },
        '[Procurement] announcement recorded; consumers are #126/#127/#128',
      );
      return;
    }
  }
}
