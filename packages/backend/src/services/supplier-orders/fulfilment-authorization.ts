/**
 * What authorizes a supplier to fulfil — the seam #122 opened and #124 closes.
 *
 * ## The function MOVED, and the move is the point
 *
 * `authorizeSupplierFulfilment` lived in
 * `services/supplier-preflight/checkout-contract.ts`, where it refused
 * unconditionally because `authorized: true` requires a purchase-order id and
 * `supplier-preflight-isolation.test.ts` forbids that domain from importing the
 * purchase-order repository. That wall is not a temporary inconvenience to be
 * relaxed now — it is #122's "a quote is not a PurchaseOrder and cannot
 * independently authorize supplier fulfilment", held structurally — so the
 * answer is not to import the repository there. The FUNCTION belongs where it
 * can read a purchase order, which is here.
 *
 * A clean cut: the old module no longer exports it, the request shape and the
 * `authorized` union are the ones #122 published, and the refusal vocabulary
 * lost the member that named an unbuilt orchestration and gained the members
 * that describe a real purchase order's state.
 *
 * ## Submission, not acceptance, is what authorizes
 *
 * A purchase order Mercaria has SUBMITTED authorizes the supplier to fulfil,
 * whether or not the supplier has answered yet: the order is placed, and a
 * supplier that ships against it is doing what it was asked. A `draft` does
 * not — nothing has been ordered — and neither does a `rejected`, `expired` or
 * `cancelled` one, where fulfilment would be goods nobody wants arriving at a
 * buyer who has already been refunded.
 *
 * ## A halting exception REVOKES it
 *
 * A duplicate supplier order, a detected substitution or a shipment after a
 * cancellation each mean fulfilment must stop while a person looks (#124
 * idempotency 7). The check is a live read rather than a flag copied onto the
 * purchase order, because the condition is opened and closed by a different
 * path than the one asking, and two representations of one fact can disagree.
 */

import type { PurchaseOrderStatus } from '@mercaria/shared-types';
import {
  findPurchaseOrdersByOrderId,
  type PurchaseOrderRecord,
} from '../../db/procurement/purchaseOrderRepository.js';
import { purchaseOrderHasHaltingException } from '../../db/supplierOrders/exceptionRepository.js';

/** Why a supplier may not fulfil. */
export type SupplierFulfilmentRefusal =
  | 'quote_is_not_a_purchase_order'
  | 'purchase_order_not_found'
  | 'purchase_order_not_submitted'
  | 'purchase_order_halted';

/** Authorized with the purchase order that authorizes it, or refused. */
export type SupplierFulfilmentAuthorization =
  | { authorized: true; purchaseOrderId: string }
  | { authorized: false; reason: SupplierFulfilmentRefusal };

/** What a caller must be holding to even ask — #122's shape, unchanged. */
export interface SupplierFulfilmentRequest {
  quoteId: string;
  orderId: string;
  supplierAccountId: string;
}

/**
 * The purchase-order statuses under which a supplier is authorized to fulfil.
 *
 * `cancel_requested` is in the set deliberately: Mercaria has ASKED for a
 * cancellation and the supplier has not answered, so the goods may legitimately
 * still be on their way and a supplier that ships is not acting without
 * authority. Removing it would make a late shipment look like an unauthorized
 * one, when what it actually is is #127's return-to-supplier path.
 */
const FULFILMENT_AUTHORIZING_STATUSES: readonly PurchaseOrderStatus[] = [
  'submitted',
  'accepted',
  'cancel_requested',
  'shipped',
  'delivered',
];

/**
 * Whether this supplier account may fulfil this customer order.
 *
 * Reads the purchase orders for the customer order and picks the one belonging
 * to the account being asked about — the account, not the supplier, because a
 * supplier with a test and a live account has two, and only one of them placed
 * this order.
 */
export async function authorizeSupplierFulfilment(
  request: SupplierFulfilmentRequest,
): Promise<SupplierFulfilmentAuthorization> {
  const purchaseOrders = await findPurchaseOrdersByOrderId(request.orderId);
  const match = purchaseOrders.find(
    (purchaseOrder: PurchaseOrderRecord) =>
      purchaseOrder.supplierAccountId === request.supplierAccountId,
  );
  if (!match) return { authorized: false, reason: 'purchase_order_not_found' };
  if (!FULFILMENT_AUTHORIZING_STATUSES.includes(match.status)) {
    return { authorized: false, reason: 'purchase_order_not_submitted' };
  }
  if (await purchaseOrderHasHaltingException(match.id)) {
    return { authorized: false, reason: 'purchase_order_halted' };
  }
  return { authorized: true, purchaseOrderId: match.id };
}
