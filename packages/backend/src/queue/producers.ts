/**
 * Producer helpers — the single place that enqueues marketplace jobs.
 *
 * Graceful degradation: when the queue is ENABLED a job is added to Redis; when
 * DISABLED (no REDIS_URL) the SAME handler runs INLINE (awaited, best-effort),
 * so behavior is preserved without Redis. The inline path imports the handlers
 * from `handlers.ts` — the exact functions the workers run — so queued and
 * inline execution are identical.
 */

import { getEventsQueue } from './queues.js';
import {
  JOB_RECOMPUTE_AGGREGATES,
  JOB_ORDER_EVENT_NOTIFICATION,
  JOB_LOW_INVENTORY_ALERT,
} from './constants.js';
import {
  handleRecomputeAggregates,
  handleOrderEventNotification,
  handleLowInventoryAlert,
} from './handlers.js';
import { log } from '../lib/logger.js';
import type {
  RecomputeAggregatesJob,
  OrderEventNotificationJob,
  LowInventoryAlertJob,
} from './types.js';

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
