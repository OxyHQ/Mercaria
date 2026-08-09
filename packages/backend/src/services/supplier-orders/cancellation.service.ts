/**
 * Asking a supplier to cancel, and keeping the four answers apart (#124
 * cancellation).
 *
 * ## Requested, accepted, rejected and ambiguous are four different things
 *
 * They route in genuinely different directions, which is why collapsing any two
 * of them would be a bug rather than a simplification:
 *
 *  - **Requested** — `purchase_orders.status = 'cancel_requested'` (#118). The
 *    ask is durable before the provider is called, so a crash mid-call leaves
 *    an order that visibly owes an answer.
 *  - **Accepted** — the supplier confirmed; the order is `cancelled`.
 *  - **Rejected** — too late, the goods are coming. The order returns to
 *    `accepted` and the recovery is #127's return-to-supplier RMA. Calling that
 *    a cancellation would tell a customer their money is coming back while a
 *    parcel is on its way to them.
 *  - **Ambiguous** — nobody knows. The order STAYS `cancel_requested`, which is
 *    exactly what that state means, and an exception routes it to a person.
 *
 * ## Cancelling does not refund, and does not delete
 *
 * Nothing in this module touches an order's money (#124 cancellation 4 and 7).
 * The customer's refund is the commerce decision #127 and the existing refund
 * domain own, on Mercaria's own timeline and policy; a cancellation REQUEST is
 * not evidence that a refund is due, and a supplier's acceptance is not
 * permission to issue one. The purchase order, its lines, its attempts and its
 * documents all survive a cancellation untouched.
 *
 * ## A late shipment after a cancellation request is an EXCEPTION
 *
 * Not a state this module writes — it arrives through the observation path,
 * where an illegal edge from `cancelled` to `shipped` raises
 * `shipment_after_cancellation`, a halting condition (#124 cancellation 5).
 */

import type { SupplierCancellation } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { findPurchaseOrderById } from '../../db/procurement/purchaseOrderRepository.js';
import { recordPurchaseOrderLineOutcome } from '../../db/supplierOrders/evidenceRepository.js';
import { findPurchaseOrderLines } from '../../db/procurement/purchaseOrderRepository.js';
import {
  applySupplierCancellationConfirmed,
  applySupplierCancellationDeclined,
  requestPurchaseOrderCancellation,
} from '../procurement/purchase-order.service.js';
import { applyDeclaredCancellationCapabilities } from './adapter.js';
import {
  deriveCancellationIdempotencyKey,
  deriveSupplierClientReference,
} from './client-reference.js';
import { digestSupplierValue } from './redact.js';
import { raiseProcurementExceptionFor } from './exception.service.js';
import { callSupplierProvider } from './provider-call.js';

/** What one cancellation attempt concluded. */
export type CancellationOutcome =
  | { outcome: 'accepted'; purchaseOrderId: string }
  | { outcome: 'rejected'; purchaseOrderId: string; reason: string }
  | { outcome: 'ambiguous'; purchaseOrderId: string }
  | { outcome: 'refused'; purchaseOrderId: string; reason: string }
  | { outcome: 'not_cancellable'; purchaseOrderId: string; status: string };

/**
 * Open a cancellation request — the durable half, which commits before any
 * provider is called.
 *
 * Separate from {@link sendPurchaseOrderCancellation} deliberately: a customer
 * or an operator asking to cancel must be recorded whatever the provider is
 * doing, and the outbox is what carries the ask to the supplier afterwards. A
 * single function that did both would lose the ask if the provider call failed
 * in the request.
 */
export async function requestSupplierCancellation(input: {
  purchaseOrderId: string;
  initiator: 'customer' | 'operator';
  byOxyUserId?: string;
}): Promise<CancellationOutcome> {
  const purchaseOrder = await findPurchaseOrderById(input.purchaseOrderId);
  if (!purchaseOrder) {
    throw new Error(`requestSupplierCancellation: purchase order ${input.purchaseOrderId} not found`);
  }
  const moved = await requestPurchaseOrderCancellation({
    purchaseOrderId: input.purchaseOrderId,
    initiator: input.initiator,
    ...(input.byOxyUserId ? { byOxyUserId: input.byOxyUserId } : {}),
  });
  if (!moved) {
    return {
      outcome: 'not_cancellable',
      purchaseOrderId: input.purchaseOrderId,
      status: purchaseOrder.status,
    };
  }
  return { outcome: 'ambiguous', purchaseOrderId: input.purchaseOrderId };
}

/**
 * Send the cancellation to the supplier and apply what it says.
 *
 * Idempotent on the provider's side through a derived key
 * (`cancel:<purchaseOrderId>`), and idempotent on Mercaria's through the CAS in
 * `applySupplierCancellationConfirmed` — a second delivery of one acceptance
 * finds the order already `cancelled` and changes nothing.
 */
export async function sendPurchaseOrderCancellation(
  purchaseOrderId: string,
): Promise<CancellationOutcome> {
  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) {
    throw new Error(`sendPurchaseOrderCancellation: purchase order ${purchaseOrderId} not found`);
  }
  if (purchaseOrder.status !== 'cancel_requested') {
    return { outcome: 'not_cancellable', purchaseOrderId, status: purchaseOrder.status };
  }
  if (!purchaseOrder.supplierExternalOrderId) {
    // Nothing was ever placed under a provider id. That is not a cancellation
    // to send — it is an ambiguous submission, and cancelling an order the
    // provider may or may not have would be a request about nothing.
    await raiseProcurementExceptionFor({
      kind: 'ambiguous_submission',
      purchaseOrder,
      detail:
        'a cancellation was requested for a purchase order with no supplier order id; the ' +
        'submission outcome must be converged before it can be cancelled',
      flagOperator: true,
    });
    return { outcome: 'ambiguous', purchaseOrderId };
  }

  const externalOrderId = purchaseOrder.supplierExternalOrderId;
  const call = await callSupplierProvider<SupplierCancellation>({
    purchaseOrderId,
    supplierAccountId: purchaseOrder.supplierAccountId,
    supplierId: purchaseOrder.supplierId,
    operation: 'cancel',
    requestHash: digestSupplierValue(`cancel:${purchaseOrderId}:${externalOrderId}`),
    invoke: async ({ adapter, providerAccountId, environment, credential, timeoutMs }) => {
      if (!adapter.cancelOrder) {
        throw new Error(`adapter ${adapter.provider} declares order_cancellation with no method`);
      }
      return await adapter.cancelOrder({
        providerAccountId,
        environment,
        credential,
        timeoutMs,
        externalOrderId,
        clientReference: deriveSupplierClientReference(purchaseOrderId),
        idempotencyKey: deriveCancellationIdempotencyKey(purchaseOrderId),
      });
    },
  });

  if (call.outcome === 'refused') {
    return { outcome: 'refused', purchaseOrderId, reason: call.reason };
  }
  if (call.outcome === 'ambiguous' || call.outcome === 'failed') {
    // The order stays `cancel_requested`, which is precisely "we asked and do
    // not know". A retry is safe because the provider key is derived.
    if (call.outcome === 'ambiguous') {
      await raiseProcurementExceptionFor({
        kind: 'ambiguous_submission',
        purchaseOrder,
        detail: `a cancellation request's outcome is unknown: ${call.message}`,
      });
      return { outcome: 'ambiguous', purchaseOrderId };
    }
    throw new Error(`supplier cancellation failed: ${call.message}`);
  }

  const bounded = applyDeclaredCancellationCapabilities(call.answer, call.adapter.capabilities);
  const answer = bounded.answer;
  const observedAt = new Date(answer.observedAt);

  if (answer.lineOutcomes.length > 0) {
    const lines = await findPurchaseOrderLines(purchaseOrderId);
    const byId = new Map(lines.map((line) => [line.id, line]));
    for (const outcome of answer.lineOutcomes) {
      const line = byId.get(outcome.clientLineReference);
      if (!line) continue;
      await recordPurchaseOrderLineOutcome({
        purchaseOrderId,
        purchaseOrderLineId: line.id,
        kind: outcome.kind,
        quantity: outcome.quantity,
        ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
        observedAt,
      });
    }
  }

  if (answer.state === 'accepted') {
    await applySupplierCancellationConfirmed({
      purchaseOrderId,
      ...(answer.reasonCode ? { reasonCode: answer.reasonCode } : {}),
      ...(answer.providerMessage ? { supplierNote: answer.providerMessage } : {}),
      at: observedAt,
    });
    return { outcome: 'accepted', purchaseOrderId };
  }
  if (answer.state === 'rejected') {
    await applySupplierCancellationDeclined({
      purchaseOrderId,
      ...(answer.providerMessage ? { supplierNote: answer.providerMessage } : {}),
      at: observedAt,
    });
    log.general.info(
      { purchaseOrderId },
      '[Procurement] supplier refused the cancellation; the order returns to `accepted` and ' +
        'recovery is the return-to-supplier path (#127)',
    );
    return { outcome: 'rejected', purchaseOrderId, reason: answer.reasonCode ?? 'too_late' };
  }

  // `requested` or `ambiguous` from the provider itself: it has the ask and has
  // not decided. The order stays where it is and the outbox asks again.
  return { outcome: 'ambiguous', purchaseOrderId };
}
