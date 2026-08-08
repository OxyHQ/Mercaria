/**
 * The ONE place the payment domain touches orders.
 *
 * The payment domain is Postgres-native; orders are still MongoDB. That is not a
 * design, it is a migration window — and the point of this file is that the
 * window has exactly one seam. When orders become a Postgres write path, this
 * module is what changes, and everything above it (`payment.service`, the outbox
 * handlers, the trace queries) is written against these four functions rather
 * than against Mongoose.
 *
 * ## Two stores means the transition is NOT atomic, and that is stated, not hidden
 *
 * A payment reaching `succeeded` commits in Postgres with its ledger postings
 * and its outbox row. The orders it funds move to `paid` afterwards, from the
 * outbox handler. So there is a window in which the payment says succeeded and
 * the order still says pending — #45 invariant 7 anticipates exactly this
 * ("payment state and order state may temporarily differ and have an explicit
 * reconciliation path"), and the outbox IS that path: the row is durable, the
 * handler is idempotent, and a task dying mid-window changes only how long it
 * lasts.
 *
 * Crossing the two stores in one transaction is not available at any price, and
 * pretending otherwise — a Mongo write inside the Postgres transaction callback
 * — would produce the one outcome worse than the window: a committed order
 * transition whose payment rolled back.
 */

import type { HydratedDocument } from 'mongoose';
import type { PaymentProviderId } from '@mercaria/shared-types';
import { Order, type IOrder } from '../../models/order.js';

/** The order facts the payment domain needs, with no Mongoose in the signature. */
export interface LinkedOrder {
  id: string;
  status: IOrder['status'];
  sellerType: IOrder['sellerType'];
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
}

/** Project one Mongoose order into the shape above. */
function toLinkedOrder(order: IOrder & { _id: unknown }): LinkedOrder {
  return {
    id: String(order._id),
    status: order.status,
    sellerType: order.sellerType,
    sellerOwnerId:
      order.sellerType === 'store' ? String(order.storeId ?? '') : String(order.sellerOxyUserId ?? ''),
    buyerOxyUserId: order.buyerOxyUserId,
    shopTotalMinor: order.totals.grandTotal.shop.amount,
    shopCurrency: order.totals.grandTotal.shop.currency,
    presentmentTotalMinor: order.totals.grandTotal.presentment.amount,
    presentmentCurrency: order.totals.grandTotal.presentment.currency,
  };
}

/** Every order a checkout group split into, oldest first. */
export async function findOrdersInCheckoutGroup(checkoutGroupId: string): Promise<LinkedOrder[]> {
  const docs = await Order.find({ checkoutGroupId })
    .sort({ createdAt: 1 })
    .lean<(IOrder & { _id: unknown })[]>();
  return docs.map(toLinkedOrder);
}

/** One order, or `undefined`. */
export async function findLinkedOrder(orderId: string): Promise<LinkedOrder | undefined> {
  const doc = await Order.findById(orderId).lean<(IOrder & { _id: unknown }) | null>();
  return doc ? toLinkedOrder(doc) : undefined;
}

/**
 * Stamp the payment pointer onto every order of a checkout group.
 *
 * Only the POINTER and the provider — never a status, never an amount. The
 * order's own `payment.status` is moved by `order.service.transition`, which
 * owns the inventory effects that go with it; writing it here would produce an
 * order marked paid whose stock was never committed (#45 invariant 5).
 */
export async function linkPaymentToOrders(input: {
  checkoutGroupId: string;
  paymentId: string;
  provider: PaymentProviderId;
  reference?: string;
}): Promise<number> {
  const result = await Order.updateMany(
    { checkoutGroupId: input.checkoutGroupId },
    {
      $set: {
        'payment.paymentId': input.paymentId,
        'payment.provider': input.provider,
        ...(input.reference ? { 'payment.reference': input.reference } : {}),
      },
    },
  );
  return result.modifiedCount;
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
  const result = await Order.updateOne(
    { _id: input.orderId },
    { $set: { 'payment.paymentId': input.paymentId, 'payment.provider': input.provider } },
  );
  return result.modifiedCount === 1;
}

/**
 * Load the mutable Mongoose document `order.service.transition` needs.
 *
 * The one place a Mongoose type escapes this module, and it does so on purpose:
 * `transition` takes a hydrated document, and re-implementing its
 * compare-and-swap, its inventory effects and its moderation-hold check against
 * a projection would be a second order state machine. When orders move to
 * Postgres this returns whatever that service takes instead.
 */
export async function loadOrderForTransition(
  orderId: string,
): Promise<HydratedDocument<IOrder> | null> {
  return await Order.findById(orderId);
}
