/**
 * The ONE place the procurement domain touches customer orders.
 *
 * The `services/payments/order-linkage.ts` shape, applied to the B2B side and
 * DELIBERATELY a separate seam: the two domains never import each other
 * (supplier acceptance is not payment truth and payment truth is not
 * procurement truth — ADR 0004 D1, #118 consistency rules 4–5), so each owns
 * its own projection of the order rather than sharing one that would couple
 * them.
 *
 * ## The projection IS the redaction
 *
 * ADR 0004 D2.7 / D10: a supplier receives fulfilment data ONLY — recipient
 * name, shipping address, phone where the carrier requires it, the lines and
 * the service. This projection is that allow-list. It deliberately has no
 * buyer identity, no email, no payment pointer and no order history: a
 * purchase-order creation path reading this type cannot leak what it cannot
 * see, and a spread of the order row is unrepresentable here.
 */

import type { OrderStatus } from '@mercaria/shared-types';
import { findOrderById } from '../../db/orders/orderRepository.js';
import type { PurchaseOrderDestination } from '../../db/procurement/purchaseOrderRepository.js';

/** The order facts procurement needs, and NOTHING else. */
export interface ProcurementLinkedOrder {
  id: string;
  status: OrderStatus;
  checkoutGroupId: string | null;
  /** The fulfilment-only destination snapshot — the D2.7 allow-list, verbatim. */
  destination: PurchaseOrderDestination;
}

/** One order, projected for procurement, or `undefined`. */
export async function findProcurementLinkedOrder(
  orderId: string,
): Promise<ProcurementLinkedOrder | undefined> {
  const order = await findOrderById(orderId);
  if (!order) return undefined;
  return {
    id: order.id,
    status: order.status,
    checkoutGroupId: order.checkoutGroupId,
    destination: {
      recipientName: order.shippingAddressRecipientName,
      line1: order.shippingAddressLine1,
      ...(order.shippingAddressLine2 ? { line2: order.shippingAddressLine2 } : {}),
      city: order.shippingAddressCity,
      ...(order.shippingAddressRegion ? { region: order.shippingAddressRegion } : {}),
      postalCode: order.shippingAddressPostalCode,
      country: order.shippingAddressCountry,
      ...(order.shippingAddressPhone ? { phone: order.shippingAddressPhone } : {}),
    },
  };
}
