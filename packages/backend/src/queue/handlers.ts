/**
 * Pure marketplace job handlers.
 *
 * These functions hold the ACTUAL work for each job. They are imported by BOTH
 * `producers.ts` (run inline when Redis is disabled) and `workers.ts` (the
 * BullMQ processors), so queued and inline behavior are identical. Keeping them
 * here breaks the producers ↔ workers cycle.
 *
 * Every handler is best-effort with respect to side-effect notifications: a
 * notification failure is logged and never aborts the rest of the job.
 */

import type { NotificationType } from '../models/notification.js';
import { Order, type IOrder } from '../models/order.js';
import { Store, type IStore, type IStoreMember } from '../models/store.js';
import { Review } from '../models/review.js';
import { transition } from '../services/order.service.js';
import { sendNotification } from '../lib/notification-service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import type {
  RecomputeAggregatesJob,
  OrderEventNotificationJob,
  OrderEvent,
  LowInventoryAlertJob,
} from './types.js';

/** Store-member permissions that grant inventory/low-stock visibility. */
const INVENTORY_MANAGER_PERMISSIONS = ['store:manage', 'inventory:write'] as const;

/** Map an order-lifecycle event to the buyer-facing notification type. */
const EVENT_TO_BUYER_TYPE: Record<OrderEvent, NotificationType> = {
  placed: 'order_placed',
  paid: 'order_paid',
  shipped: 'order_shipped',
  delivered: 'order_delivered',
  cancelled: 'order_cancelled',
};

/** Human title/body for the buyer notification per event. */
const BUYER_COPY: Record<OrderEvent, { title: string; body: string }> = {
  placed: { title: 'Order placed', body: 'Your order has been placed.' },
  paid: { title: 'Payment received', body: 'Your payment was received and your order is confirmed.' },
  shipped: { title: 'Order shipped', body: 'Your order is on its way.' },
  delivered: { title: 'Order delivered', body: 'Your order has been delivered.' },
  cancelled: { title: 'Order cancelled', body: 'Your order has been cancelled.' },
};

/** Human title/body for the seller notification per event. */
const SELLER_COPY: Record<OrderEvent, { title: string; body: string }> = {
  placed: { title: 'New order', body: 'You have a new order.' },
  paid: { title: 'Order paid', body: 'An order has been paid.' },
  shipped: { title: 'Order shipped', body: 'An order was marked shipped.' },
  delivered: { title: 'Order delivered', body: 'An order was delivered.' },
  cancelled: { title: 'Order cancelled', body: 'An order was cancelled.' },
};

/** Fire a notification, swallowing (and warning on) any failure. NEVER throws. */
async function notifySafe(options: Parameters<typeof sendNotification>[0]): Promise<void> {
  try {
    await sendNotification(options);
  } catch (err) {
    log.general.warn(
      { err, userId: options.userId, type: options.type },
      'Notification delivery failed (best-effort)',
    );
  }
}

/** The distinct owner-member oxy user ids of a store. */
function storeOwnerIds(store: Pick<IStore, 'members'>): string[] {
  return [...new Set(store.members.filter((m) => m.role === 'owner').map((m) => m.oxyUserId))];
}

/** The distinct member ids who can act on inventory (owner or inventory perms). */
function inventoryManagerIds(members: IStoreMember[]): string[] {
  const ids = members
    .filter(
      (m) => m.role === 'owner' || INVENTORY_MANAGER_PERMISSIONS.some((p) => m.permissions.includes(p)),
    )
    .map((m) => m.oxyUserId);
  return [...new Set(ids)];
}

/**
 * Recompute a single review target's rating aggregate. Delegates to the review
 * service (dynamic import to fully avoid a static handlers→review.service→
 * producers→handlers cycle at module-load time).
 */
export async function handleRecomputeAggregates(job: RecomputeAggregatesJob): Promise<void> {
  const { recomputeAggregate } = await import('../services/review.service.js');
  await recomputeAggregate(job.targetType, job.targetId);
}

/**
 * Deliver order-event notifications to the buyer and the seller. On `placed`,
 * a P2P (`sellerType: 'user'`) seller additionally gets a `listing_sold`
 * notification. Best-effort: a missing order logs a warning and returns; each
 * notification is isolated so one failure doesn't abort the rest.
 */
export async function handleOrderEventNotification(job: OrderEventNotificationJob): Promise<void> {
  const order = await Order.findById(job.orderId).lean<IOrder | null>();
  if (!order) {
    log.general.warn({ orderId: job.orderId, event: job.event }, 'Order-event notification: order not found');
    return;
  }

  const buyerType = EVENT_TO_BUYER_TYPE[job.event];
  const buyerCopy = BUYER_COPY[job.event];
  await notifySafe({
    userId: String(order.buyerOxyUserId),
    type: buyerType,
    title: buyerCopy.title,
    body: buyerCopy.body,
    data: { orderId: job.orderId, orderNumber: order.orderNumber, event: job.event },
  });

  const sellerCopy = SELLER_COPY[job.event];
  const sellerData = { orderId: job.orderId, orderNumber: order.orderNumber, event: job.event };

  if (order.sellerType === 'user' && order.sellerOxyUserId) {
    const sellerId = String(order.sellerOxyUserId);
    await notifySafe({
      userId: sellerId,
      type: buyerType,
      title: sellerCopy.title,
      body: sellerCopy.body,
      data: sellerData,
    });
    if (job.event === 'placed') {
      await notifySafe({
        userId: sellerId,
        type: 'listing_sold',
        title: 'Item sold',
        body: 'One of your listings just sold.',
        data: sellerData,
      });
    }
  } else if (order.sellerType === 'store' && order.storeId) {
    const store = await Store.findById(order.storeId).lean<IStore | null>();
    if (store) {
      for (const ownerId of storeOwnerIds(store)) {
        await notifySafe({
          userId: ownerId,
          type: buyerType,
          title: sellerCopy.title,
          body: sellerCopy.body,
          data: { ...sellerData, storeId: String(order.storeId) },
        });
      }
    }
  }
}

/**
 * Expire stale `pending_payment` reservations: cancel every order older than
 * `config.orders.reservationTtlMs`, releasing the held stock via the order
 * transition. Loads NON-lean docs (transition mutates + saves). Per-order
 * failures are logged and skipped so one bad order doesn't abort the sweep.
 */
export async function handleExpireReservations(): Promise<void> {
  const cutoff = new Date(Date.now() - config.orders.reservationTtlMs);
  const stale = await Order.find({ status: 'pending_payment', createdAt: { $lt: cutoff } });

  if (stale.length === 0) {
    return;
  }

  for (const order of stale) {
    try {
      await transition(order, 'cancelled', { note: 'reservation expired' });
    } catch (err) {
      log.general.warn(
        { err, orderId: String(order._id) },
        'Failed to expire reservation (skipping order)',
      );
    }
  }

  log.general.info({ count: stale.length }, 'Expired stale reservations');
}

/**
 * Alert a store's inventory managers that a tracked variant dropped to/below
 * the low-stock threshold. Best-effort; a missing store logs a warning.
 */
export async function handleLowInventoryAlert(job: LowInventoryAlertJob): Promise<void> {
  const store = await Store.findById(job.storeId).lean<IStore | null>();
  if (!store) {
    log.general.warn({ storeId: job.storeId }, 'Low-inventory alert: store not found');
    return;
  }

  const recipients = inventoryManagerIds(store.members);
  for (const userId of recipients) {
    await notifySafe({
      userId,
      type: 'low_inventory',
      title: 'Low inventory',
      body: `${job.variantTitle} is low on stock (${job.available} left).`,
      data: {
        storeId: job.storeId,
        listingId: job.listingId,
        variantId: job.variantId,
        available: job.available,
      },
    });
  }
}

/**
 * Daily drift-correction sweep: recompute the rating aggregate of every distinct
 * review target that has published reviews. Each target is recomputed
 * independently; a single failure is logged and the sweep continues.
 */
export async function handleAggregateSweep(): Promise<void> {
  const { recomputeAggregate } = await import('../services/review.service.js');

  const groups = await Review.aggregate<{
    _id: { targetType: 'listing' | 'store' | 'seller'; targetId: string };
  }>([
    { $match: { status: 'published' } },
    {
      $group: {
        _id: {
          targetType: '$targetType',
          targetId: {
            $switch: {
              branches: [
                { case: { $eq: ['$targetType', 'listing'] }, then: '$listingId' },
                { case: { $eq: ['$targetType', 'store'] }, then: '$storeId' },
                { case: { $eq: ['$targetType', 'seller'] }, then: '$sellerOxyUserId' },
              ],
              default: null,
            },
          },
        },
      },
    },
  ]);

  let recomputed = 0;
  for (const group of groups) {
    const { targetType, targetId } = group._id;
    if (!targetId) {
      continue;
    }
    try {
      await recomputeAggregate(targetType, targetId);
      recomputed += 1;
    } catch (err) {
      log.general.warn({ err, targetType, targetId }, 'Aggregate sweep: recompute failed (skipping)');
    }
  }

  log.general.info({ recomputed }, 'Rating-aggregate sweep complete');
}
