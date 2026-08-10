/**
 * Cancellation orchestration (#127 §"Cancellation orchestration", ADR 0004
 * diagram 8).
 *
 * ## Three states of one cancellation and none substitutes for another
 *
 * Rule 3 asks that the REQUEST, the SUPPLIER's acceptance and the PROVIDER's
 * refund stay distinct, and they are three different rows in three domains:
 * `retail_service_requests.state` is what Mercaria told the buyer,
 * `purchase_orders.status` is what the supplier agreed to (#124), and
 * `refunds.provider_state` is where the money is (#49). This module reads the
 * second and writes neither.
 *
 * ## The supplier cancellation is REQUESTED and never assumed
 *
 * #124 owns the idempotent cancel and keeps four answers apart — requested,
 * accepted, rejected, ambiguous — and states outright that *nothing there
 * refunds, restocks or deletes*. A supplier's refusal returns the purchase order
 * to `accepted` and the recovery is a RETURN, which is why rule 8 says *"move to
 * a return path when cancellation is no longer possible"* and why this module
 * refuses rather than inventing one: opening a return on goods a buyer has not
 * received yet would ask them to post back a parcel that is still in the air.
 *
 * ## Mercaria's refund does not wait for the supplier's answer
 *
 * ADR 0004 D8.5 and #127 responsibility rule 4. A pre-acceptance cancellation
 * refunds on Mercaria's timeline; if the supplier then says "too late", the
 * buyer keeps their money and Mercaria's recourse is a
 * `cancelled_order_refund` recovery against the purchase order. That is the
 * failure matrix's "late acceptance after cancel/refund" row, and the customer
 * outcome column reads *unchanged*.
 */

import { listRetailProcurementIntents } from '../../db/retailCheckout/retailCheckoutRepository.js';
import {
  findPurchaseOrderById,
} from '../../db/procurement/purchaseOrderRepository.js';
import {
  appendRetailServiceEvent,
  findRetailServiceRequest,
} from '../../db/retailServiceRequests/requestRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { requestSupplierCancellation } from '../supplier-orders/cancellation.service.js';
import { retailDeciderAudit, type RetailServiceDecider } from './authorization.js';
import { loadRetailServiceOrder } from './order-facts.js';
import { notifyRetailCancellationUpdated } from './notifications.js';
import { openRetailSupplierRecovery } from './return-case.service.js';

/**
 * What the supplier side of a cancellation looks like right now.
 *
 * A projection over #124's purchase-order state, and a projection is all it is:
 * this domain never writes one. `unknown` covers both "no purchase order was
 * ever placed" and "one exists and has not answered", which are different facts
 * with the same customer consequence — Mercaria decides regardless.
 */
export type RetailSupplierCancellationState =
  | { readonly state: 'not_procured' }
  | { readonly state: 'requested'; readonly purchaseOrderId: string }
  | { readonly state: 'accepted'; readonly purchaseOrderId: string }
  | { readonly state: 'too_late'; readonly purchaseOrderId: string };

/**
 * Ask the supplier to cancel, and record what happened.
 *
 * Called AFTER the customer decision is recorded and the refund is committed —
 * see the module docblock. Best-effort by construction: every branch leaves the
 * customer's remedy where it was.
 */
export async function requestRetailSupplierCancellation(
  decider: RetailServiceDecider,
  requestId: string,
  now: Date,
): Promise<RetailSupplierCancellationState> {
  const request = await findRetailServiceRequest(requestId);
  if (!request) throw notFound('Request not found');

  const intents = await listRetailProcurementIntents(request.orderId);
  const purchaseOrderId = intents.find((intent) => intent.purchaseOrderId !== null)
    ?.purchaseOrderId;
  if (purchaseOrderId === undefined || purchaseOrderId === null) {
    // Nothing was procured, so there is nothing to cancel and nothing to
    // recover. The buyer's cancellation stands entirely on Mercaria's side.
    return { state: 'not_procured' };
  }

  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) return { state: 'not_procured' };

  if (purchaseOrder.status === 'shipped' || purchaseOrder.status === 'delivered') {
    // Rule 7. The goods are with a carrier or a buyer, so a cancellation is no
    // longer the operation — the recovery is a RETURN, which is a decision a
    // person makes on a request the buyer files once they have the parcel.
    // Opening one here would ask a buyer to post back something still in the
    // air.
    await appendRetailServiceEvent({
      requestId,
      kind: 'supplier_cancellation_too_late',
      ...retailDeciderAudit(decider),
      detail: purchaseOrder.status,
    });
    const context = await loadRetailServiceOrder(request.orderId);
    if (context !== null) notifyRetailCancellationUpdated(context.order, requestId, 'too_late');
    await openRetailSupplierRecovery(
      decider,
      { requestId, kind: 'cancelled_order_refund', purchaseOrderId },
      now,
    );
    return { state: 'too_late', purchaseOrderId };
  }

  // #124's idempotent cancel. It writes the purchase order's own state and an
  // outbox row; it refunds nothing and restocks nothing, which is why calling it
  // after the buyer has already been refunded is safe.
  const outcome = await requestSupplierCancellation({
    purchaseOrderId,
    initiator: 'customer',
  });
  await appendRetailServiceEvent({
    requestId,
    kind: 'supplier_cancellation_requested',
    ...retailDeciderAudit(decider),
    detail: outcome.outcome,
  });
  await openRetailSupplierRecovery(
    decider,
    { requestId, kind: 'cancelled_order_refund', purchaseOrderId },
    now,
  );
  log.general.info(
    { requestId, purchaseOrderId },
    '[RetailService] supplier cancellation requested; the buyer’s refund is already decided',
  );
  return { state: 'requested', purchaseOrderId };
}
