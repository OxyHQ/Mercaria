/**
 * Explicit, fully-typed job payloads for the Mercaria marketplace BullMQ
 * queues. Payloads carry only plain JSON-serializable data — BullMQ persists
 * them in Redis, so no Mongoose documents, class instances, or functions may be
 * placed here.
 */

import type { ReviewTargetType } from '@mercaria/shared-types';

// --- Connector-sync queue payloads ------------------------------------------

/**
 * Run an initial catalog backfill for a `pull` connection. `storeId` scopes the
 * connection lookup (a member of one store can never reach another's connection),
 * so both ids are carried and re-resolved server-side by the handler.
 */
export interface ConnectionBackfillJob {
  storeId: string;
  connectionId: string;
}

/**
 * Process ONE inbound platform webhook. The connection is re-resolved by
 * `connectionId` (which carries the provider + credentials); `topic` is the raw
 * platform topic (e.g. `products/update`) and `payload` the parsed webhook JSON
 * (already HMAC-verified at the ingress route before enqueue).
 */
export interface WebhookProcessJob {
  connectionId: string;
  topic: string;
  payload: unknown;
}

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

/** Job names enqueued onto the connector-sync queue. */
export type MarketplaceSyncJobName = 'connection.backfill' | 'webhook.process';

/** Union of every connector-sync-queue job payload. */
export type MarketplaceSyncJobData = ConnectionBackfillJob | WebhookProcessJob;

/** Union of every event-queue job payload. */
export type MarketplaceEventJobData =
  | RecomputeAggregatesJob
  | OrderEventNotificationJob
  | LowInventoryAlertJob;

/** Union of every maintenance-queue job payload. */
export type MaintenanceJobData = ExpireReservationsJob | RecomputeAggregatesJob;
