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

import type { NotificationType } from '../db/schema/notifications.js';
import {
  findOrderById,
  findStalePendingOrders,
} from '../db/orders/orderRepository.js';
import { findStoreById, type StoreMemberRecord } from '../db/stores/storeRepository.js';
import { findPublishedReviewTargets } from '../db/reviews/reviewRepository.js';
import { SYSTEM_ACTOR, transition } from '../services/order.service.js';
import { accountWithBuyerAccess, orderBuyerOf } from '../services/orders/order-buyer.js';
import { releaseCheckoutPayments } from '../services/payments/checkout-payment.service.js';
import { sendNotification } from '../lib/notification-service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import type {
  RecomputeAggregatesJob,
  OrderEventNotificationJob,
  OrderEvent,
  LowInventoryAlertJob,
  ConnectionBackfillJob,
  WebhookProcessJob,
  ProductPushJob,
  OrderSyncJob,
  InventorySyncJob,
  FulfillmentPushJob,
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
function storeOwnerIds(members: StoreMemberRecord[]): string[] {
  return [...new Set(members.filter((m) => m.role === 'owner').map((m) => m.oxyUserId))];
}

/** The distinct member ids who can act on inventory (owner or inventory perms). */
function inventoryManagerIds(members: StoreMemberRecord[]): string[] {
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
  const order = await findOrderById(job.orderId);
  if (!order) {
    log.general.warn({ orderId: job.orderId, event: job.event }, 'Order-event notification: order not found');
    return;
  }

  const buyerType = EVENT_TO_BUYER_TYPE[job.event];
  const buyerCopy = BUYER_COPY[job.event];
  /**
   * The account to notify — the original Oxy buyer, or the Oxy account that
   * CLAIMED a guest order (ADR 0003 D7, #106 events rule 1).
   *
   * `notifications.oxy_user_id` is NOT NULL and stays so, so an unclaimed guest
   * order produces NO notification row and no push: a guest's channel is
   * transactional mail to their `guest_checkouts` contact, which #108 owns and
   * which is deliberately not faked here. In-app notification for a guest order
   * begins at the claim, addressed to the claimant — which is exactly what
   * `accountWithBuyerAccess` returns.
   */
  const notifiableBuyer = accountWithBuyerAccess(orderBuyerOf(order));
  if (notifiableBuyer !== undefined) {
    await notifySafe({
      userId: notifiableBuyer,
      type: buyerType,
      title: buyerCopy.title,
      body: buyerCopy.body,
      data: { orderId: job.orderId, orderNumber: order.orderNumber, event: job.event },
    });
  }

  const sellerCopy = SELLER_COPY[job.event];
  const sellerData = { orderId: job.orderId, orderNumber: order.orderNumber, event: job.event };

  if (order.sellerType === 'user' && order.sellerOxyUserId) {
    const sellerId = order.sellerOxyUserId;
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
    const storeId = order.storeId;
    const store = await findStoreById(storeId);
    if (store) {
      for (const ownerId of storeOwnerIds(store.members)) {
        await notifySafe({
          userId: ownerId,
          type: buyerType,
          title: sellerCopy.title,
          body: sellerCopy.body,
          data: { ...sellerData, storeId },
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
 *
 * ## The payment is given up on too, and AFTER the stock goes back
 *
 * An order whose reservation expired must not stay payable: a buyer whose
 * payment sheet is still open would otherwise be charged for goods this sweep
 * has just released. So each released group's payment is cancelled at its rail
 * and marked `canceled` here — see `cancelPaymentForCheckoutGroup`, which also
 * explains why a rail that refuses (because it already captured) leads to a
 * visible exception rather than a silent one.
 *
 * Stock first, payment second, and never the reverse: releasing inventory is
 * Mercaria's own decision and cannot fail on a third party, while cancelling at
 * a rail is a network call. Holding stock hostage to it would let a Stripe
 * outage keep a whole day's abandoned carts out of the catalogue.
 */
export async function handleExpireReservations(): Promise<void> {
  const cutoff = new Date(Date.now() - config.orders.reservationTtlMs);
  const stale = await findStalePendingOrders(cutoff);

  if (stale.length === 0) {
    return;
  }

  // Distinct, because a multi-seller cart's sibling orders share one payment and
  // one PaymentIntent (ADR 0001 D4) — cancelling it once per order would be the
  // same call repeated, and its `changed` result would read as a bug.
  const releasedGroups = new Set<string>();
  for (const order of stale) {
    try {
      // The sweep is the SYSTEM, and now says so: before #106 this row was
      // indistinguishable from a guest's own cancellation, because both left
      // `by_oxy_user_id` NULL (ADR 0003 D16).
      await transition(order, 'cancelled', { actor: SYSTEM_ACTOR, note: 'reservation expired' });
      if (order.checkoutGroupId) {
        releasedGroups.add(order.checkoutGroupId);
      }
    } catch (err) {
      log.general.warn(
        { err, orderId: order.id },
        'Failed to expire reservation (skipping order)',
      );
    }
  }

  await releaseCheckoutPayments([...releasedGroups]);

  log.general.info(
    { count: stale.length, groups: releasedGroups.size },
    'Expired stale reservations',
  );
}

/**
 * Alert a store's inventory managers that a tracked variant dropped to/below
 * the low-stock threshold. Best-effort; a missing store logs a warning.
 */
export async function handleLowInventoryAlert(job: LowInventoryAlertJob): Promise<void> {
  const store = await findStoreById(job.storeId);
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
 *
 * The Mongo version skipped a group whose resolved `targetId` came back null,
 * because its `$switch` had a `default: null` branch and nothing stopped a
 * review from carrying a `targetType` with the matching id unset. Postgres
 * states both halves as constraints — `reviews_target_type_check` bounds the
 * type to the three the CASE covers, and `reviews_target_exclusivity_check`
 * requires the matching column to be non-null — so the skip had nothing left to
 * skip and went with the query.
 */
export async function handleAggregateSweep(): Promise<void> {
  const { recomputeAggregate } = await import('../services/review.service.js');

  const targets = await findPublishedReviewTargets();

  let recomputed = 0;
  for (const { targetType, targetId } of targets) {
    try {
      await recomputeAggregate(targetType, targetId);
      recomputed += 1;
    } catch (err) {
      log.general.warn({ err, targetType, targetId }, 'Aggregate sweep: recompute failed (skipping)');
    }
  }

  log.general.info({ recomputed }, 'Rating-aggregate sweep complete');
}

/**
 * How many bounded passes one scheduled run of a #76 sweep may take.
 *
 * A ceiling and not a `while (hasMore)`: a runaway loop on a shared Postgres is
 * worse than finishing tomorrow, and both sweeps are idempotent and resumable,
 * so the remainder is picked up by the next run with nothing lost.
 */
const MAX_SWEEP_PASSES = 25;

/**
 * Daily SCOPED review-aggregate rebuild (#76).
 *
 * Derives every scoped aggregate from the review rows and reports what
 * disagreed with what was stored. DRIFT IS THE POINT: the rebuild converges the
 * stored figures — it is the repair — and logs what it had to change, so a
 * persistent disagreement shows up as a number rather than as silence. Zero
 * drift over many runs is the healthy reading; a non-zero count names the exact
 * (scope, target) to look at.
 */
export async function handleScopedAggregateSweep(): Promise<void> {
  const { rebuildReviewAggregates } = await import(
    '../services/reviews/review-aggregate.service.js'
  );

  let cursor: string | null = null;
  let scanned = 0;
  const drifted: { scope: string; targetId: string }[] = [];

  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    const report = await rebuildReviewAggregates(
      cursor === null ? {} : { afterTargetKey: cursor },
    );
    scanned += report.scanned;
    for (const drift of report.drifted) {
      drifted.push({ scope: drift.scope, targetId: drift.targetId });
      log.general.warn(
        {
          scope: drift.scope,
          targetId: drift.targetId,
          storedRating: drift.storedRating,
          storedReviewCount: drift.storedReviewCount,
          derivedRating: drift.derivedRating,
          derivedReviewCount: drift.derivedReviewCount,
        },
        'Review aggregate drift detected and corrected',
      );
    }
    if (!report.hasMore || report.nextTargetKey === null) break;
    cursor = report.nextTargetKey;
  }

  log.general.info(
    { scanned, drifted: drifted.length },
    'Scoped review-aggregate rebuild complete',
  );
}

/**
 * Daily #76 legacy-review classification pass.
 *
 * Bounded and resumable through the `classification_state` column itself: a
 * decided review leaves the job's predicate, so consecutive runs make progress
 * with no stored cursor to keep honest. Reviews it REFUSED are not re-examined
 * (they are waiting for a fact to arrive, not for another look) — an operator
 * re-runs with `includeAmbiguous` after landing the facts.
 */
export async function handleReviewClassificationSweep(): Promise<void> {
  const { classifyLegacyReviews } = await import(
    '../services/reviews/review-migration.service.js'
  );

  let scanned = 0;
  let classified = 0;
  let ambiguous = 0;

  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    const report = await classifyLegacyReviews();
    scanned += report.scanned;
    classified += report.classified;
    ambiguous += report.ambiguous;
    if (!report.hasMore) break;
  }

  log.general.info(
    { scanned, classified, ambiguous },
    'Legacy review classification pass complete',
  );
}

/**
 * Run an initial catalog backfill for a `pull` connection. Delegates to the
 * connector-sync service (dynamic import to avoid a static
 * handlers→connector-sync→queue-producers cycle at module-load, mirroring the
 * review-service delegation above).
 */
export async function handleConnectionBackfill(job: ConnectionBackfillJob): Promise<void> {
  const { runBackfill } = await import('../services/connector-sync.service.js');
  await runBackfill(job.storeId, job.connectionId);
}

/**
 * Periodic connector reconcile sweep — the SAFETY NET for missed real-time
 * webhooks. A dropped `products/*` webhook means the platform change never reached
 * Mercaria; this repeatable job re-pulls every connected `pull`/`bidirectional`
 * catalog (which re-prices changed variants and delete-reconciles removed products)
 * by enqueuing a backfill per connection. Delegates to the connector-sync service
 * (dynamic import — same cycle-breaking reason as {@link handleConnectionBackfill}).
 */
export async function handleConnectionReconcile(): Promise<void> {
  const { reconcileAllConnections } = await import('../services/connector-sync.service.js');
  await reconcileAllConnections();
}

/**
 * Process one inbound platform webhook (product create/update/delete). Delegates
 * to the connector-sync service (dynamic import — same cycle-breaking reason as
 * {@link handleConnectionBackfill}).
 */
export async function handleWebhookProcess(job: WebhookProcessJob): Promise<void> {
  const { processConnectorWebhook } = await import('../services/connector-sync.service.js');
  await processConnectorWebhook(job);
}

/**
 * Push a store listing OUT to its push/bidirectional connections. Delegates to the
 * connector-sync service (dynamic import — same cycle-breaking reason as
 * {@link handleConnectionBackfill}).
 */
export async function handleProductPush(job: ProductPushJob): Promise<void> {
  const { pushListingToChannels } = await import('../services/connector-sync.service.js');
  await pushListingToChannels(job.storeId, job.listingId);
}

/**
 * Pull orders from a `pull` connection into Mercaria. Delegates to the
 * connector-sync service (dynamic import — same cycle-breaking reason as
 * {@link handleConnectionBackfill}).
 */
export async function handleOrderSync(job: OrderSyncJob): Promise<void> {
  const { syncOrders } = await import('../services/connector-sync.service.js');
  await syncOrders(job.storeId, job.connectionId);
}

/**
 * Pull inventory levels from a `pull` connection into Mercaria. Delegates to the
 * connector-sync service (dynamic import — same cycle-breaking reason as
 * {@link handleConnectionBackfill}).
 */
export async function handleInventorySync(job: InventorySyncJob): Promise<void> {
  const { syncInventory } = await import('../services/connector-sync.service.js');
  await syncInventory(job.storeId, job.connectionId);
}

/**
 * Push a Mercaria order's fulfillment OUT to its origin connection. Delegates to the
 * connector-sync service (dynamic import — same cycle-breaking reason as
 * {@link handleConnectionBackfill}).
 */
export async function handleFulfillmentPush(job: FulfillmentPushJob): Promise<void> {
  const { pushOrderFulfillment } = await import('../services/connector-sync.service.js');
  await pushOrderFulfillment(job.orderId);
}
