/**
 * Explicit, fully-typed job payloads for the Mercaria marketplace BullMQ
 * queues. Payloads carry only plain JSON-serializable data — BullMQ persists
 * them in Redis, so no class instances, functions or driver-bound row objects
 * may be placed here.
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

/**
 * PUSH a store listing OUT to every push/bidirectional connection of its store.
 * `storeId` scopes the resolution (IDOR-safe) and the listing is re-resolved by
 * `listingId` server-side (loop-prevention + connection targeting live in the
 * connector-sync service).
 */
export interface ProductPushJob {
  storeId: string;
  listingId: string;
}

/**
 * Periodic connector reconcile sweep (repeatable, scheduler-driven). Carries no
 * payload — the handler resolves every connected `pull`/`bidirectional` connection
 * itself and enqueues a backfill per connection. This is the safety net that
 * re-converges catalogs after a missed real-time webhook.
 */
export type ConnectionReconcileJob = Record<string, never>;

/**
 * Re-register ONE connection's platform webhooks (#262).
 *
 * Both ids travel and both are re-resolved server-side: `storeId` scopes the
 * connection lookup, so a job payload naming another store's connection resolves
 * to nothing rather than to that store's credentials. The handler takes the
 * connection's registration LEASE, so two of these for one connection cannot
 * recreate its subscriptions concurrently.
 */
export interface ConnectionWebhookReregisterJob {
  storeId: string;
  connectionId: string;
}

/**
 * Periodic webhook re-registration sweep (#262, repeatable, scheduler-driven).
 * Carries no payload — the handler derives the population itself from the
 * connections whose registration did not finish.
 */
export type ConnectionWebhookRegistrationSweepJob = Record<string, never>;

/**
 * AUDIT one connection's live webhook subscriptions against what Mercaria
 * recorded (#295), and re-register when the platform contradicts it.
 *
 * One job per connection, enqueued by the EXISTING six-hourly catalogue
 * reconcile rather than by a schedule of its own — the audit is one `GET` per
 * shop, and doing every connection inside the reconcile job would make one job's
 * duration a function of how many merchants have connected.
 *
 * Both ids travel and both are re-resolved server-side, exactly as
 * {@link ConnectionWebhookReregisterJob} does and for the same reason.
 */
export interface ConnectionWebhookAuditJob {
  storeId: string;
  connectionId: string;
}

/**
 * Pull orders from a `pull` connection into Mercaria. `storeId` scopes the
 * connection lookup (a member of one store can never reach another's connection),
 * so both ids are carried and re-resolved server-side by the handler.
 */
export interface OrderSyncJob {
  storeId: string;
  connectionId: string;
}

/**
 * Pull inventory levels from a `pull` connection into Mercaria. `storeId` scopes the
 * connection lookup (IDOR-safe), so both ids are carried and re-resolved server-side
 * by the handler.
 */
export interface InventorySyncJob {
  storeId: string;
  connectionId: string;
}

/**
 * Push a Mercaria order's fulfillment OUT to the connection it was pulled from. The
 * order is re-resolved by `orderId` server-side (the origin connection + the
 * bidirectional gate + loop-prevention live in the connector-sync service).
 */
export interface FulfillmentPushJob {
  orderId: string;
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

/**
 * One bounded pass of the scoped review-aggregate rebuild (#76).
 *
 * `afterTargetKey` is what makes the pass RESUMABLE: the handler loops until
 * the sweep reports no more work, so a run with more targets than one batch
 * still finishes, and a crash mid-run costs one batch.
 */
export interface RebuildReviewAggregatesJob {
  afterTargetKey?: string;
}

/** One bounded pass of the #76 legacy-review classification. No payload. */
export type ClassifyLegacyReviewsJob = Record<string, never>;

/** Job names enqueued onto the events queue. */
export type MarketplaceEventJobName =
  | 'recompute-aggregates'
  | 'order-event-notification'
  | 'low-inventory-alert';

/** Job names enqueued onto the maintenance (repeatable) queue. */
export type MaintenanceJobName =
  | 'expire-reservations'
  | 'recompute-aggregates-sweep'
  | 'rebuild-review-aggregates'
  | 'classify-legacy-reviews';

/** Job names enqueued onto the connector-sync queue. */
export type MarketplaceSyncJobName =
  | 'connection.backfill'
  | 'connection.reconcile'
  | 'webhook.process'
  | 'product.push'
  | 'order.sync'
  | 'inventory.sync'
  | 'fulfillment.push';

/** Union of every connector-sync-queue job payload. */
export type MarketplaceSyncJobData =
  | ConnectionBackfillJob
  | ConnectionReconcileJob
  | ConnectionWebhookReregisterJob
  | ConnectionWebhookRegistrationSweepJob
  | ConnectionWebhookAuditJob
  | WebhookProcessJob
  | ProductPushJob
  | OrderSyncJob
  | InventorySyncJob
  | FulfillmentPushJob;

/** Union of every event-queue job payload. */
export type MarketplaceEventJobData =
  | RecomputeAggregatesJob
  | OrderEventNotificationJob
  | LowInventoryAlertJob;

/** Union of every maintenance-queue job payload. */
export type MaintenanceJobData =
  | ExpireReservationsJob
  | RecomputeAggregatesJob
  | RebuildReviewAggregatesJob
  | ClassifyLegacyReviewsJob;
