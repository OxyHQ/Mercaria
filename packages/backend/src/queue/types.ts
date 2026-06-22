/**
 * Explicit, fully-typed job payloads for the Mercaria marketplace BullMQ
 * queues. Payloads carry only plain JSON-serializable data — BullMQ persists
 * them in Redis, so no Mongoose documents, class instances, or functions may be
 * placed here.
 */

import type { ReviewTargetType } from '@mercaria/shared-types';

/** Recompute one review target's rating aggregate (drift-proof backstop). */
export interface RecomputeAggregatesJob {
  targetType: ReviewTargetType;
  targetId: string;
}

/** The order lifecycle event that drives buyer/seller notifications. */
export type OrderEvent = 'placed' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

/** Deliver order-event notifications to the buyer + seller. */
export interface OrderEventNotificationJob {
  orderId: string;
  event: OrderEvent;
}

/** Alert store managers that a tracked variant dropped to/below the threshold. */
export interface LowInventoryAlertJob {
  storeId: string;
  listingId: string;
  variantId: string;
  variantTitle: string;
  available: number;
}

/** Periodic reservation-sweep job — no payload. */
export type ExpireReservationsJob = Record<string, never>;

/** Job names enqueued onto the events queue. */
export type MarketplaceEventJobName =
  | 'recompute-aggregates'
  | 'order-event-notification'
  | 'low-inventory-alert';

/** Job names enqueued onto the maintenance (repeatable) queue. */
export type MaintenanceJobName = 'expire-reservations' | 'recompute-aggregates-sweep';

/** Union of every event-queue job payload. */
export type MarketplaceEventJobData =
  | RecomputeAggregatesJob
  | OrderEventNotificationJob
  | LowInventoryAlertJob;

/** Union of every maintenance-queue job payload. */
export type MaintenanceJobData = ExpireReservationsJob | RecomputeAggregatesJob;
