/**
 * The ONE place the payment domain touches orders.
 *
 * Both domains are Postgres-native now, so this is no longer a bridge between
 * two stores — but it stays the single seam, because the payment domain should
 * read orders through a projection it owns rather than reaching into the order
 * repository from five places. `payment.service`, the outbox handlers and the
 * trace queries are written against these five functions.
 *
 * ## The transition is still NOT atomic with the payment, and that is stated, not hidden
 *
 * A payment reaching `succeeded` commits with its ledger postings and its outbox
 * row. The orders it funds move to `paid` afterwards, from the outbox handler —
 * a SEPARATE transaction, which is what the window is made of now that a second
 * store is no longer what makes it. So there is still an interval in which the
 * payment says succeeded and the order still says pending; #45 invariant 7
 * anticipates exactly this ("payment state and order state may temporarily
 * differ and have an explicit reconciliation path"), and the outbox IS that
 * path: the row is durable, the handler is idempotent, and a task dying
 * mid-window changes only how long it lasts.
 *
 * Collapsing the two into one transaction is not a rename of this file — the
 * same handler is run by `payment.service`'s inline drain AND by the poller, and
 * the poller has no payment transaction to join. Leaving the window explicit is
 * what keeps the reconciliation path real.
 */

import type { OrderSellerType, OrderStatus, PaymentProviderId } from '@mercaria/shared-types';
import {
  findOrderById,
  findOrdersInCheckoutGroup as selectOrdersInCheckoutGroup,
  linkPaymentToCheckoutGroup,
  linkPaymentToOrderId,
  type OrderRecord,
} from '../../db/orders/orderRepository.js';

/** The order facts the payment domain needs, with no order-table shape in the signature. */
export interface LinkedOrder {
  id: string;
  status: OrderStatus;
  sellerType: OrderSellerType;
  /** The store id or the P2P seller's Oxy user id — whichever this order has. */
  sellerOwnerId: string;
  buyerOxyUserId: string;
  /** The order's grand total on the SHOP side, in minor units. */
  shopTotalMinor: number;
  shopCurrency: string;
  /**
   * The order's grand total on the PRESENTMENT side — what the buyer was
   * charged for this seller's portion.
   *
   * Both sides are carried because the two answer different questions and the
   * payment domain asks both: the presentment side is what a charge is composed
   * of and what its ledger legs are denominated in today, while the shop side is
   * the merchant accounting basis a transfer and a payout will settle against
   * once a real rail lands (ADR 0001 D8).
   */
  presentmentTotalMinor: number;
  presentmentCurrency: string;
  /**
   * The payment funding this order, once one exists — the pointer `tracePayment`
   * follows when asked "which payment paid this order".
   */
  paymentId: string | null;
  /** The group this order was checked out in; the fallback handle for the trace. */
  checkoutGroupId: string | null;
}

/** Project one order record into the shape above. */
function toLinkedOrder(order: OrderRecord): LinkedOrder {
  return {
    id: order.id,
    status: order.status,
    sellerType: order.sellerType,
    sellerOwnerId: order.sellerType === 'store' ? (order.storeId ?? '') : (order.sellerOxyUserId ?? ''),
    buyerOxyUserId: order.buyerOxyUserId,
    shopTotalMinor: order.totalsGrandTotalShopAmount,
    shopCurrency: order.totalsGrandTotalShopCurrency,
    presentmentTotalMinor: order.totalsGrandTotalPresentmentAmount,
    presentmentCurrency: order.totalsGrandTotalPresentmentCurrency,
    paymentId: order.paymentId,
    checkoutGroupId: order.checkoutGroupId,
  };
}

/** Every order a checkout group split into, oldest first. */
export async function findOrdersInCheckoutGroup(checkoutGroupId: string): Promise<LinkedOrder[]> {
  const rows = await selectOrdersInCheckoutGroup(checkoutGroupId);
  return rows.map(toLinkedOrder);
}

/** One order, or `undefined`. */
export async function findLinkedOrder(orderId: string): Promise<LinkedOrder | undefined> {
  const row = await findOrderById(orderId);
  return row ? toLinkedOrder(row) : undefined;
}

/**
 * Stamp the payment pointer onto every order of a checkout group.
 *
 * Only the POINTER and the provider — never a status, never an amount. The
 * order's own payment status is moved by `order.service.transition`, which owns
 * the inventory effects that go with it; writing it here would produce an order
 * marked paid whose stock was never committed (#45 invariant 5).
 */
export async function linkPaymentToOrders(input: {
  checkoutGroupId: string;
  paymentId: string;
  provider: PaymentProviderId;
  reference?: string;
}): Promise<number> {
  return await linkPaymentToCheckoutGroup(input);
}

/**
 * Stamp the payment pointer onto ONE order.
 *
 * The `external` case: an imported payment stands for exactly one order, and its
 * checkout group is a synthetic `ext:<provider>:<externalId>` that two connected
 * shops can legitimately collide on. Linking by group there would point one
 * shop's order at another shop's payment.
 */
export async function linkPaymentToOrder(input: {
  orderId: string;
  paymentId: string;
  provider: PaymentProviderId;
}): Promise<boolean> {
  return await linkPaymentToOrderId(input);
}

/**
 * Load the order record `order.service.transition` needs, fresh.
 *
 * A re-read rather than reusing the projection above, and it is not redundant
 * with the CAS: `transition` compare-and-swaps on STATUS, but it reads
 * `moderationHold` off the record it is handed, outside that swap. A hold placed
 * between listing the group and transitioning it would be missed if a stale copy
 * were passed in — which is the one case this seam exists to get right, since a
 * frozen order being marked paid is exactly what the freeze is for.
 */
export async function loadOrderForTransition(orderId: string): Promise<OrderRecord | null> {
  return await findOrderById(orderId);
}
