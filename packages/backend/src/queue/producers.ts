/**
 * Producer helpers — the single place that enqueues marketplace jobs.
 *
 * Graceful degradation: when the queue is ENABLED a job is added to Redis; when
 * DISABLED (no REDIS_URL) the SAME handler runs INLINE (awaited, best-effort),
 * so behavior is preserved without Redis. The inline path imports the handlers
 * from `handlers.ts` — the exact functions the workers run — so queued and
 * inline execution are identical.
 */

import { createHash } from 'node:crypto';
import { getEventsQueue, getSyncQueue } from './queues.js';
import {
  JOB_RECOMPUTE_AGGREGATES,
  JOB_ORDER_EVENT_NOTIFICATION,
  JOB_LOW_INVENTORY_ALERT,
  JOB_CONNECTION_BACKFILL,
  JOB_WEBHOOK_PROCESS,
  JOB_PRODUCT_PUSH,
  JOB_ORDER_SYNC,
  JOB_INVENTORY_SYNC,
  JOB_FULFILLMENT_PUSH,
} from './constants.js';
import {
  handleRecomputeAggregates,
  handleOrderEventNotification,
  handleLowInventoryAlert,
  handleConnectionBackfill,
  handleWebhookProcess,
  handleProductPush,
  handleOrderSync,
  handleInventorySync,
  handleFulfillmentPush,
} from './handlers.js';
import { log } from '../lib/logger.js';
import type {
  RecomputeAggregatesJob,
  OrderEventNotificationJob,
  LowInventoryAlertJob,
  ConnectionBackfillJob,
  WebhookProcessJob,
  ProductPushJob,
  OrderSyncJob,
  InventorySyncJob,
  FulfillmentPushJob,
} from './types.js';

/**
 * Derive a colon-free, stable BullMQ job/dedup id from a composite key. BullMQ
 * rejects `:` in a custom job id, and connection ids / topics can carry colons or
 * slashes — hashing to sha256 hex yields a safe, collision-resistant id.
 */
function hashJobId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Run an inline handler fallback, logging (never rethrowing) on failure. */
async function runInline(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    log.general.warn({ err, job: label }, 'Inline job handler failed (queue disabled)');
  }
}

/**
 * Enqueue a rating-aggregate recompute (drift-proof backstop). Falls back to an
 * inline recompute when the queue is disabled.
 */
export async function enqueueRecomputeAggregate(data: RecomputeAggregatesJob): Promise<void> {
  const queue = getEventsQueue();
  if (!queue) {
    await runInline(JOB_RECOMPUTE_AGGREGATES, () => handleRecomputeAggregates(data));
    return;
  }
  await queue.add(JOB_RECOMPUTE_AGGREGATES, data);
}

/**
 * Enqueue order-event notifications. Falls back to inline delivery when the
 * queue is disabled.
 */
export async function enqueueOrderEvent(data: OrderEventNotificationJob): Promise<void> {
  const queue = getEventsQueue();
  if (!queue) {
    await runInline(JOB_ORDER_EVENT_NOTIFICATION, () => handleOrderEventNotification(data));
    return;
  }
  await queue.add(JOB_ORDER_EVENT_NOTIFICATION, data);
}

/**
 * Enqueue a low-inventory alert. Falls back to inline delivery when the queue is
 * disabled.
 */
export async function enqueueLowStockAlert(data: LowInventoryAlertJob): Promise<void> {
  const queue = getEventsQueue();
  if (!queue) {
    await runInline(JOB_LOW_INVENTORY_ALERT, () => handleLowInventoryAlert(data));
    return;
  }
  await queue.add(JOB_LOW_INVENTORY_ALERT, data);
}

/**
 * Enqueue an initial catalog backfill for a `pull` connection. Falls back to
 * running the backfill INLINE when the sync queue is disabled (no Redis), so the
 * catalog still imports with identical behavior. A stable, hashed `jobId` dedupes
 * an overlapping backfill of the same connection (a second enqueue while one is
 * pending/active is ignored by BullMQ).
 */
export async function enqueueConnectionBackfill(data: ConnectionBackfillJob): Promise<void> {
  const queue = getSyncQueue();
  if (!queue) {
    await runInline(JOB_CONNECTION_BACKFILL, () => handleConnectionBackfill(data));
    return;
  }
  await queue.add(JOB_CONNECTION_BACKFILL, data, {
    jobId: hashJobId(JOB_CONNECTION_BACKFILL, data.connectionId),
  });
}

/**
 * Enqueue processing of one inbound platform webhook. Falls back to processing it
 * INLINE when the sync queue is disabled (no Redis) — the ingress route then
 * blocks until the single product upsert/archive completes, preserving behavior.
 */
export async function enqueueWebhookProcess(data: WebhookProcessJob): Promise<void> {
  const queue = getSyncQueue();
  if (!queue) {
    await runInline(JOB_WEBHOOK_PROCESS, () => handleWebhookProcess(data));
    return;
  }
  await queue.add(JOB_WEBHOOK_PROCESS, data);
}

/**
 * Enqueue a product PUSH of a store listing to its push/bidirectional connections.
 * Falls back to running the push INLINE when the sync queue is disabled (no Redis).
 * A stable, hashed `jobId` dedupes an overlapping push of the same listing (a
 * second enqueue while one is pending/active is ignored by BullMQ).
 */
export async function enqueueProductPush(data: ProductPushJob): Promise<void> {
  const queue = getSyncQueue();
  if (!queue) {
    await runInline(JOB_PRODUCT_PUSH, () => handleProductPush(data));
    return;
  }
  await queue.add(JOB_PRODUCT_PUSH, data, {
    jobId: hashJobId(JOB_PRODUCT_PUSH, data.listingId),
  });
}

/**
 * Enqueue an order sync (pull orders from a `pull` connection). Falls back to
 * running the sync INLINE when the sync queue is disabled (no Redis). A stable,
 * hashed `jobId` dedupes an overlapping order sync of the same connection.
 */
export async function enqueueOrderSync(data: OrderSyncJob): Promise<void> {
  const queue = getSyncQueue();
  if (!queue) {
    await runInline(JOB_ORDER_SYNC, () => handleOrderSync(data));
    return;
  }
  await queue.add(JOB_ORDER_SYNC, data, {
    jobId: hashJobId(JOB_ORDER_SYNC, data.connectionId),
  });
}

/**
 * Enqueue an inventory sync (pull inventory levels from a `pull` connection). Falls
 * back to running the sync INLINE when the sync queue is disabled (no Redis). A
 * stable, hashed `jobId` dedupes an overlapping inventory sync of the same connection.
 */
export async function enqueueInventorySync(data: InventorySyncJob): Promise<void> {
  const queue = getSyncQueue();
  if (!queue) {
    await runInline(JOB_INVENTORY_SYNC, () => handleInventorySync(data));
    return;
  }
  await queue.add(JOB_INVENTORY_SYNC, data, {
    jobId: hashJobId(JOB_INVENTORY_SYNC, data.connectionId),
  });
}

/**
 * Enqueue a fulfillment push (Mercaria order → its origin connection). Falls back to
 * running the push INLINE when the sync queue is disabled (no Redis). A stable,
 * hashed `jobId` dedupes an overlapping push of the same order.
 */
export async function enqueueFulfillmentPush(data: FulfillmentPushJob): Promise<void> {
  const queue = getSyncQueue();
  if (!queue) {
    await runInline(JOB_FULFILLMENT_PUSH, () => handleFulfillmentPush(data));
    return;
  }
  await queue.add(JOB_FULFILLMENT_PUSH, data, {
    jobId: hashJobId(JOB_FULFILLMENT_PUSH, data.orderId),
  });
}
