/**
 * Order service — order lifecycle transitions, queries, and store stats.
 *
 * `transition` is the single gate for moving an order between statuses: it
 * enforces the allowed-transition graph and runs the matching inventory effect
 * via `inventory.service` (commit on pay; restock vs release on cancel/refund
 * depending on whether stock was already committed). It NEVER copies aggregate
 * counts — seller `salesCount` moves ±1 in lockstep with real paid orders.
 *
 * Order DTOs are built ONLY through `order-hydration.service`; this service
 * loads the right docs (lean for reads, hydrated mongoose doc for mutation) and
 * delegates serialization.
 */

import type { HydratedDocument } from 'mongoose';
import type {
  Money,
  Order as OrderDTO,
  OrderStatus,
  OrderSummary,
} from '@mercaria/shared-types';
import { Order, type IOrder, type IOrderStatusEvent } from '../models/order.js';
import { Refund, type IRefund } from '../models/refund.js';
import { SellerProfile } from '../models/seller-profile.js';
import { Store, type IStore } from '../models/store.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant } from '../models/product-variant.js';
import { commit, release, restock } from './inventory.service.js';
import { upsertOnPaid as upsertCustomerOnPaid } from './customer.service.js';
import { hydrateOrders, summarizeOrders } from './order-hydration.service.js';
import { enqueueOrderEvent } from '../queue/producers.js';
import type { OrderEvent } from '../queue/types.js';
import { zeroMoney, sumMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * The allowed status transitions. A transition NOT listed under the current
 * status is a CONFLICT. `cancelled`/`refunded` are terminal.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled', 'refunded', 'partially_refunded'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded'],
};

/**
 * Map a transitioned-to status to the buyer/seller notification event, or
 * `undefined` when the status has no notification (e.g. `processing`,
 * `refunded`). Drives the best-effort order-event enqueue at the end of
 * `transition`.
 */
const STATUS_TO_EVENT: Partial<Record<OrderStatus, OrderEvent>> = {
  paid: 'paid',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/** Options for a `transition` call. */
interface TransitionOptions {
  /** Oxy user id of the actor driving the transition (recorded in history). */
  actorOxyUserId?: string;
  /** Optional free-text note recorded on the status event. */
  note?: string;
  /** Tracking number to attach (e.g. when moving to `shipped`). */
  trackingNumber?: string;
}

/** Map a persisted `{ amount, currency }` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/**
 * Transition an order to `next`, enforcing the allowed-transition graph and
 * running the matching inventory effect:
 *   - `paid`: commit every line (sale finalized) + bump the seller's salesCount.
 *   - `cancelled`/`refunded`: per line, RESTOCK if already paid (stock was
 *     committed) else RELEASE the reservation; `refunded` also marks payment
 *     refunded.
 *
 * The status flip is an atomic compare-and-swap (`findOneAndUpdate` guarded on
 * the CURRENT status), executed BEFORE any inventory/salesCount side-effects.
 * Only the winning caller (whose CAS matched the pre-transition status) runs the
 * side-effects, so a buyer `cancel` racing the expire-reservations sweep — or
 * any multi-process double-invoke — runs them AT MOST ONCE: the loser's CAS
 * matches nothing and throws CONFLICT before touching inventory. The passed-in
 * mongoose doc is then mutated in memory to mirror the persisted state (callers
 * re-hydrate via `order.toObject()`); `.save()` is NOT called — the CAS already
 * persisted the change.
 */
export async function transition(
  order: HydratedDocument<IOrder>,
  next: OrderStatus,
  opts: TransitionOptions,
): Promise<IOrder> {
  const current = order.status;
  if (!TRANSITIONS[current].includes(next)) {
    throw conflict(`Cannot transition order from ${current} to ${next}`);
  }

  // The pre-transition payment state drives restock-vs-release on cancel/refund.
  const wasPaid = order.payment.status === 'paid';

  // Build the status event + any payment/shipping `$set` fields BEFORE the CAS.
  const event: IOrderStatusEvent = { status: next, at: new Date() };
  if (opts.actorOxyUserId) {
    event.byOxyUserId = opts.actorOxyUserId;
  }
  if (opts.note) {
    event.note = opts.note;
  }

  const setFields: Record<string, unknown> = { status: next };
  const paidAt = new Date();
  if (next === 'paid') {
    setFields['payment.status'] = 'paid';
    setFields['payment.paidAt'] = paidAt;
  } else if (next === 'refunded') {
    setFields['payment.status'] = 'refunded';
  }
  if (opts.trackingNumber) {
    setFields['shipping.trackingNumber'] = opts.trackingNumber;
  }

  // Atomic CAS gate: only succeeds if the order is still at `current`.
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: current },
    { $set: setFields, $push: { statusHistory: event } },
    { new: true },
  );
  if (!updated) {
    throw conflict(`Order ${String(order._id)} was concurrently transitioned`);
  }

  // CAS won — run the inventory side-effects + salesCount bump exactly once.
  // Each line commits/releases/restocks at its own `locationId` when set (POS
  // sales reserve at the register location); storefront items carry none and
  // resolve the store's default location, unchanged.
  if (next === 'paid') {
    for (const item of order.items) {
      await commit(item.variantId, item.quantity, item.locationId);
    }
    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      await SellerProfile.updateOne(
        { oxyUserId: order.sellerOxyUserId },
        { $inc: { salesCount: 1 } },
        { upsert: true },
      );
    } else if (order.sellerType === 'store' && order.storeId) {
      await Store.updateOne({ _id: order.storeId }, { $inc: { salesCount: 1 } });
      // Relate the store buyer + bump their lifetime aggregates (exactly once).
      if (order.buyerOxyUserId) {
        await upsertCustomerOnPaid(
          order.storeId,
          order.buyerOxyUserId,
          toMoney(order.totals.grandTotal),
        );
      }
    }
  } else if (next === 'cancelled' || next === 'refunded') {
    if (wasPaid) {
      // A `refund.service` refund may have ALREADY restocked some units per-line.
      // Subtract those so a later full cancel/refund restocks only the remainder
      // — never the units a refund already returned (no double-restock).
      const refunds = await Refund.find({ orderId: String(order._id) }).lean<IRefund[]>();
      const restockedQtyByVariant = new Map<string, number>();
      for (const refund of refunds) {
        for (const line of refund.lineItems) {
          if (line.restock) {
            restockedQtyByVariant.set(
              line.variantId,
              (restockedQtyByVariant.get(line.variantId) ?? 0) + line.quantity,
            );
          }
        }
      }
      for (const item of order.items) {
        const alreadyRestocked = restockedQtyByVariant.get(item.variantId) ?? 0;
        const remainingQty = Math.max(0, item.quantity - alreadyRestocked);
        if (remainingQty > 0) {
          await restock(item.variantId, remainingQty, item.locationId);
        }
      }
    } else {
      for (const item of order.items) {
        await release(item.variantId, item.quantity, item.locationId);
      }
    }
  }

  // Mirror the persisted state onto the in-memory doc so callers that
  // re-hydrate via `order.toObject()` see the new values.
  order.status = next;
  order.statusHistory.push(event);
  if (next === 'paid') {
    order.payment.status = 'paid';
    order.payment.paidAt = paidAt;
  } else if (next === 'refunded') {
    order.payment.status = 'refunded';
  }
  if (opts.trackingNumber) {
    order.shipping.trackingNumber = opts.trackingNumber;
  }

  log.general.info(
    { orderId: String(order._id), status: next, actor: opts.actorOxyUserId },
    'Order transitioned',
  );

  // Best-effort: notify buyer + seller of the lifecycle change. `processing`
  // has no buyer-facing event, so it is skipped. A notification failure must
  // never fail the transition.
  const orderEvent = STATUS_TO_EVENT[next];
  if (orderEvent) {
    try {
      await enqueueOrderEvent({ orderId: String(order._id), event: orderEvent });
    } catch (err) {
      log.general.warn(
        { err, orderId: String(order._id), status: next },
        'Failed to enqueue order-event notification',
      );
    }
  }

  return order;
}

/** A Mongo filter document (Mongoose 9 dropped the `FilterQuery` export). */
type OrderFilter = Record<string, unknown>;

/** Load a NON-lean order doc by filter (for mutation), or throw NOT_FOUND. */
async function loadOrderDoc(filter: OrderFilter): Promise<HydratedDocument<IOrder>> {
  const doc = await Order.findOne(filter);
  if (!doc) {
    throw notFound('Order not found');
  }
  return doc;
}

/** A page of order summaries plus the total matching count (controller paginates). */
interface OrderPage {
  data: OrderSummary[];
  total: number;
}

/** Offset-paginated list parameters. */
interface ListParams {
  page: number;
  limit: number;
  status?: OrderStatus;
}

/** List the buyer's own orders (newest first), summarized + total count. */
export async function getBuyerOrders(
  oxyUserId: string,
  { page, limit }: ListParams,
): Promise<OrderPage> {
  const filter = { buyerOxyUserId: oxyUserId };
  const [docs, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IOrder[]>(),
    Order.countDocuments(filter),
  ]);
  return { data: await summarizeOrders(docs), total };
}

/** Get a single order owned by the buyer (hydrated), or throw NOT_FOUND. */
export async function getOrderForBuyer(oxyUserId: string, id: string): Promise<OrderDTO> {
  const doc = await Order.findOne({ _id: id, buyerOxyUserId: oxyUserId }).lean<IOrder | null>();
  if (!doc) {
    throw notFound('Order not found');
  }
  const [dto] = await hydrateOrders([doc]);
  if (!dto) {
    throw notFound('Order not found');
  }
  return dto;
}

/** List a P2P seller's orders (optionally filtered by status), summarized. */
export async function getSellerOrders(
  oxyUserId: string,
  { status, page, limit }: ListParams,
): Promise<OrderPage> {
  const filter = {
    sellerType: 'user' as const,
    sellerOxyUserId: oxyUserId,
    ...(status ? { status } : {}),
  };
  const [docs, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IOrder[]>(),
    Order.countDocuments(filter),
  ]);
  return { data: await summarizeOrders(docs), total };
}

/** List a store's orders (optionally filtered by status), summarized. */
export async function getStoreOrders(
  storeId: string,
  { status, page, limit }: ListParams,
): Promise<OrderPage> {
  const filter = { storeId, ...(status ? { status } : {}) };
  const [docs, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IOrder[]>(),
    Order.countDocuments(filter),
  ]);
  return { data: await summarizeOrders(docs), total };
}

/** Get a single order owned by the store (hydrated), or throw NOT_FOUND. */
export async function getOrderForStore(storeId: string, id: string): Promise<OrderDTO> {
  const doc = await Order.findOne({ _id: id, storeId }).lean<IOrder | null>();
  if (!doc) {
    throw notFound('Order not found');
  }
  const [dto] = await hydrateOrders([doc]);
  if (!dto) {
    throw notFound('Order not found');
  }
  return dto;
}

/** Hydrate a freshly-mutated mongoose order doc into its DTO, or throw NOT_FOUND. */
async function hydrateDoc(doc: HydratedDocument<IOrder>): Promise<OrderDTO> {
  const [dto] = await hydrateOrders([doc.toObject<IOrder>()]);
  if (!dto) {
    throw notFound('Order not found');
  }
  return dto;
}

/**
 * Test-only mock pay: move the buyer's order to `paid`. 404s (hidden) when the
 * mock-pay endpoint is disabled (production).
 */
export async function mockPay(oxyUserId: string, orderId: string): Promise<OrderDTO> {
  if (!config.orders.mockPayEnabled) {
    throw notFound('Not found');
  }
  const doc = await loadOrderDoc({ _id: orderId, buyerOxyUserId: oxyUserId });
  await transition(doc, 'paid', { actorOxyUserId: oxyUserId, note: 'mock-pay' });
  return hydrateDoc(doc);
}

/** Cancel the buyer's own order (releases the reservation if still unpaid). */
export async function cancelByBuyer(oxyUserId: string, orderId: string): Promise<OrderDTO> {
  const doc = await loadOrderDoc({ _id: orderId, buyerOxyUserId: oxyUserId });
  await transition(doc, 'cancelled', { actorOxyUserId: oxyUserId, note: 'cancelled by buyer' });
  return hydrateDoc(doc);
}

/** Fulfilment update params for a P2P seller. */
interface SellerFulfilInput {
  status: 'processing' | 'shipped' | 'delivered';
  trackingNumber?: string;
}

/** Advance a P2P seller's order along the fulfilment path (processing/shipped/delivered). */
export async function fulfillSellerOrder(
  oxyUserId: string,
  orderId: string,
  { status, trackingNumber }: SellerFulfilInput,
): Promise<OrderDTO> {
  const doc = await loadOrderDoc({
    _id: orderId,
    sellerType: 'user',
    sellerOxyUserId: oxyUserId,
  });
  await transition(doc, status, {
    actorOxyUserId: oxyUserId,
    ...(trackingNumber ? { trackingNumber } : {}),
  });
  return hydrateDoc(doc);
}

/** Status-patch params for a store order. */
interface StoreStatusInput {
  status: OrderStatus;
  trackingNumber?: string;
  note?: string;
}

/** Patch a store order's status (any allowed transition; records the actor). */
export async function patchStoreOrderStatus(
  storeId: string,
  orderId: string,
  { status, trackingNumber, note }: StoreStatusInput,
  actorOxyUserId: string,
): Promise<OrderDTO> {
  const doc = await loadOrderDoc({ _id: orderId, storeId });
  await transition(doc, status, {
    actorOxyUserId,
    ...(trackingNumber ? { trackingNumber } : {}),
    ...(note ? { note } : {}),
  });
  return hydrateDoc(doc);
}

/** A store's order dashboard stats. */
interface StoreStats {
  counts: Record<OrderStatus, number>;
  revenue: Money;
  lowStockVariantCount: number;
}

/** Every order status initialized to a zero count. */
function zeroCounts(): Record<OrderStatus, number> {
  return {
    pending_payment: 0,
    paid: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
    refunded: 0,
    partially_refunded: 0,
  };
}

/**
 * Compute a store's order dashboard stats: per-status order counts, paid-order
 * revenue (in the store's default currency), and the number of tracked variants
 * at or below the low-stock threshold.
 */
export async function storeStats(storeId: string): Promise<StoreStats> {
  const counts = zeroCounts();

  const [statusGroups, store, paidOrders] = await Promise.all([
    Order.aggregate<{ _id: OrderStatus; n: number }>([
      { $match: { storeId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Store.findById(storeId).lean<IStore | null>(),
    Order.find({ storeId, 'payment.status': 'paid' }).lean<IOrder[]>(),
  ]);

  for (const group of statusGroups) {
    if (group._id in counts) {
      counts[group._id] = group.n;
    }
  }

  const currency = (store?.defaultCurrency ??
    paidOrders[0]?.totals.grandTotal.currency ??
    'FAIR') as Money['currency'];
  const revenue =
    paidOrders.length > 0
      ? sumMoney(
          paidOrders.map((o) => toMoney(o.totals.grandTotal)),
          currency,
        )
      : zeroMoney(currency);

  const listingIds = await Listing.find({ ownerType: 'store', storeId })
    .select('_id')
    .lean<{ _id: IListing['_id'] }[]>();
  const lowStockVariantCount = await ProductVariant.countDocuments({
    listingId: { $in: listingIds.map((i) => String(i._id)) },
    'inventory.tracked': true,
    'inventory.available': { $lte: config.orders.lowStockThreshold },
  });

  return { counts, revenue, lowStockVariantCount };
}
