/**
 * Repeatable-job registration for the marketplace maintenance queue.
 *
 * Uses BullMQ v5's `upsertJobScheduler`, which is idempotent per scheduler id —
 * re-registering on every boot never creates duplicate schedules. A single
 * process registers the schedules here; leader-election across a multi-process
 * fleet is a deliberate scale-out follow-up (not built — a repeatable job
 * materializes one delayed job per interval and any worker may consume it, with
 * maintenance concurrency pinned to 1 so it never overlaps itself).
 */

import { getMaintenanceQueue, getSyncQueue } from './queues.js';
import { isQueueEnabled } from './connection.js';
import {
  SCHEDULER_EXPIRE_RESERVATIONS,
  SCHEDULER_RECOMPUTE_AGGREGATES,
  SCHEDULER_REBUILD_REVIEW_AGGREGATES,
  SCHEDULER_CLASSIFY_LEGACY_REVIEWS,
  SCHEDULER_CONNECTION_RECONCILE,
  SCHEDULER_CONNECTION_WEBHOOK_REGISTRATION,
  RESERVATION_SWEEP_INTERVAL_MS,
  AGGREGATE_SWEEP_CRON,
  SCOPED_AGGREGATE_SWEEP_CRON,
  REVIEW_CLASSIFICATION_CRON,
  CONNECTOR_RECONCILE_INTERVAL_MS,
  CONNECTOR_WEBHOOK_REGISTRATION_SWEEP_INTERVAL_MS,
  JOB_EXPIRE_RESERVATIONS,
  JOB_RECOMPUTE_AGGREGATES_SWEEP,
  JOB_REBUILD_REVIEW_AGGREGATES,
  JOB_CLASSIFY_LEGACY_REVIEWS,
  JOB_CONNECTION_RECONCILE,
  JOB_CONNECTION_WEBHOOK_REGISTRATION_SWEEP,
} from './constants.js';
import { log } from '../lib/logger.js';

/**
 * Register (upsert) the marketplace repeatable jobs. No-op when Redis is not
 * configured. Safe to call repeatedly.
 */
export async function registerSchedules(): Promise<void> {
  if (!isQueueEnabled()) {
    return;
  }
  const queue = getMaintenanceQueue();
  if (!queue) {
    return;
  }

  await queue.upsertJobScheduler(
    SCHEDULER_EXPIRE_RESERVATIONS,
    { every: RESERVATION_SWEEP_INTERVAL_MS },
    { name: JOB_EXPIRE_RESERVATIONS, data: {} },
  );

  await queue.upsertJobScheduler(
    SCHEDULER_RECOMPUTE_AGGREGATES,
    { pattern: AGGREGATE_SWEEP_CRON },
    { name: JOB_RECOMPUTE_AGGREGATES_SWEEP, data: {} },
  );

  // #76's two sweeps. Both are bounded and resumable, and both are idempotent,
  // so a missed run costs freshness and never correctness.
  await queue.upsertJobScheduler(
    SCHEDULER_REBUILD_REVIEW_AGGREGATES,
    { pattern: SCOPED_AGGREGATE_SWEEP_CRON },
    { name: JOB_REBUILD_REVIEW_AGGREGATES, data: {} },
  );

  await queue.upsertJobScheduler(
    SCHEDULER_CLASSIFY_LEGACY_REVIEWS,
    { pattern: REVIEW_CLASSIFICATION_CRON },
    { name: JOB_CLASSIFY_LEGACY_REVIEWS, data: {} },
  );

  // The connector reconcile sweep lives on the SYNC queue (its work talks to
  // external commerce platforms, so it must never share the maintenance worker).
  const syncQueue = getSyncQueue();
  if (syncQueue) {
    await syncQueue.upsertJobScheduler(
      SCHEDULER_CONNECTION_RECONCILE,
      { every: CONNECTOR_RECONCILE_INTERVAL_MS },
      { name: JOB_CONNECTION_RECONCILE, data: {} },
    );

    // #262: re-register the webhooks of every connection whose registration did
    // not finish. Registered UNCONDITIONALLY — the flag that decides whether it
    // runs is read inside the sweep, so turning it back on takes effect on the
    // next tick rather than needing the schedule re-registered.
    await syncQueue.upsertJobScheduler(
      SCHEDULER_CONNECTION_WEBHOOK_REGISTRATION,
      { every: CONNECTOR_WEBHOOK_REGISTRATION_SWEEP_INTERVAL_MS },
      { name: JOB_CONNECTION_WEBHOOK_REGISTRATION_SWEEP, data: {} },
    );
  }

  log.general.info('Marketplace repeatable jobs registered');
}

/**
 * Remove the marketplace repeatable-job schedules. Safe to call when nothing is
 * registered or Redis is not configured.
 */
export async function removeSchedules(): Promise<void> {
  if (!isQueueEnabled()) {
    return;
  }
  const queue = getMaintenanceQueue();
  if (!queue) {
    return;
  }
  await queue.removeJobScheduler(SCHEDULER_EXPIRE_RESERVATIONS);
  await queue.removeJobScheduler(SCHEDULER_RECOMPUTE_AGGREGATES);
  await queue.removeJobScheduler(SCHEDULER_REBUILD_REVIEW_AGGREGATES);
  await queue.removeJobScheduler(SCHEDULER_CLASSIFY_LEGACY_REVIEWS);

  const syncQueue = getSyncQueue();
  if (syncQueue) {
    await syncQueue.removeJobScheduler(SCHEDULER_CONNECTION_RECONCILE);
    await syncQueue.removeJobScheduler(SCHEDULER_CONNECTION_WEBHOOK_REGISTRATION);
  }
}
