/**
 * Lazily-constructed BullMQ producer queues for the marketplace.
 *
 * Queues are created on first access (never at import time) so merely importing
 * this module is side-effect free (important for tests that run without Redis).
 * Each accessor returns `null` when Redis is not configured; producers then fall
 * back to running the handler inline (see `producers.ts`).
 */

import { Queue, type QueueOptions } from 'bullmq';
import { getQueueConnection, isQueueEnabled } from './connection.js';
import {
  MARKETPLACE_EVENTS_QUEUE,
  MARKETPLACE_MAINTENANCE_QUEUE,
  MARKETPLACE_SYNC_QUEUE,
  EVENTS_JOB_ATTEMPTS,
  EVENTS_BACKOFF_BASE_MS,
  MAINTENANCE_JOB_ATTEMPTS,
  SYNC_JOB_ATTEMPTS,
  SYNC_BACKOFF_BASE_MS,
  REMOVE_ON_COMPLETE_COUNT,
  REMOVE_ON_FAIL_COUNT,
} from './constants.js';
import type {
  MarketplaceEventJobData,
  MaintenanceJobData,
  MarketplaceSyncJobData,
} from './types.js';

/** Shared default job options (retention + retry/backoff) for a queue. */
function baseQueueOptions(attempts: number, backoffDelayMs: number): QueueOptions {
  return {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: backoffDelayMs },
      removeOnComplete: { count: REMOVE_ON_COMPLETE_COUNT },
      removeOnFail: { count: REMOVE_ON_FAIL_COUNT },
    },
  };
}

let eventsQueue: Queue<MarketplaceEventJobData> | null = null;
let maintenanceQueue: Queue<MaintenanceJobData> | null = null;
let syncQueue: Queue<MarketplaceSyncJobData> | null = null;

/** Get the events queue, or null when Redis is not configured. */
export function getEventsQueue(): Queue<MarketplaceEventJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!eventsQueue) {
    eventsQueue = new Queue<MarketplaceEventJobData>(
      MARKETPLACE_EVENTS_QUEUE,
      baseQueueOptions(EVENTS_JOB_ATTEMPTS, EVENTS_BACKOFF_BASE_MS),
    );
  }
  return eventsQueue;
}

/**
 * Get the connector-sync queue, or null when Redis is not configured. Producers
 * fall back to running the handler inline (see `producers.ts`) when this is null.
 */
export function getSyncQueue(): Queue<MarketplaceSyncJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!syncQueue) {
    syncQueue = new Queue<MarketplaceSyncJobData>(
      MARKETPLACE_SYNC_QUEUE,
      baseQueueOptions(SYNC_JOB_ATTEMPTS, SYNC_BACKOFF_BASE_MS),
    );
  }
  return syncQueue;
}

/**
 * Get the maintenance (repeatable-job) queue, or null when Redis is not
 * configured. Repeatable schedules are registered onto this queue by
 * `scheduler.ts`.
 */
export function getMaintenanceQueue(): Queue<MaintenanceJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue<MaintenanceJobData>(
      MARKETPLACE_MAINTENANCE_QUEUE,
      baseQueueOptions(MAINTENANCE_JOB_ATTEMPTS, EVENTS_BACKOFF_BASE_MS),
    );
  }
  return maintenanceQueue;
}

/** Close all open producer queues and null them. Used by {@link shutdownQueues}. */
export async function closeQueues(): Promise<void> {
  const open: Array<
    Queue<MarketplaceEventJobData> | Queue<MaintenanceJobData> | Queue<MarketplaceSyncJobData>
  > = [];
  if (eventsQueue) open.push(eventsQueue);
  if (maintenanceQueue) open.push(maintenanceQueue);
  if (syncQueue) open.push(syncQueue);

  await Promise.allSettled(open.map((q) => q.close()));

  eventsQueue = null;
  maintenanceQueue = null;
  syncQueue = null;
}
