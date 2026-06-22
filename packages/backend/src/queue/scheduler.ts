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

import { getMaintenanceQueue } from './queues.js';
import { isQueueEnabled } from './connection.js';
import {
  SCHEDULER_EXPIRE_RESERVATIONS,
  SCHEDULER_RECOMPUTE_AGGREGATES,
  RESERVATION_SWEEP_INTERVAL_MS,
  AGGREGATE_SWEEP_CRON,
  JOB_EXPIRE_RESERVATIONS,
  JOB_RECOMPUTE_AGGREGATES_SWEEP,
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
}
