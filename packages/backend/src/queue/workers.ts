/**
 * BullMQ consumers (workers) for the marketplace queues.
 *
 * `startWorkers` is a no-op when Redis is not configured (jobs run inline via
 * the producers instead). When enabled it creates the events + maintenance
 * workers, attaches error logging, and registers the repeatable schedules.
 * `shutdownQueues` closes workers, queues, and the connection — safe to call
 * when nothing started.
 */

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { getQueueConnection, isQueueEnabled, closeQueueConnection } from './connection.js';
import { closeQueues } from './queues.js';
import { registerSchedules, removeSchedules } from './scheduler.js';
import {
  MARKETPLACE_EVENTS_QUEUE,
  MARKETPLACE_MAINTENANCE_QUEUE,
  MARKETPLACE_SYNC_QUEUE,
  EVENTS_WORKER_CONCURRENCY,
  MAINTENANCE_WORKER_CONCURRENCY,
  SYNC_WORKER_CONCURRENCY,
  JOB_RECOMPUTE_AGGREGATES,
  JOB_ORDER_EVENT_NOTIFICATION,
  JOB_LOW_INVENTORY_ALERT,
  JOB_EXPIRE_RESERVATIONS,
  JOB_RECOMPUTE_AGGREGATES_SWEEP,
  JOB_CONNECTION_BACKFILL,
  JOB_WEBHOOK_PROCESS,
} from './constants.js';
import {
  handleRecomputeAggregates,
  handleOrderEventNotification,
  handleLowInventoryAlert,
  handleExpireReservations,
  handleAggregateSweep,
  handleConnectionBackfill,
  handleWebhookProcess,
} from './handlers.js';
import { log } from '../lib/logger.js';
import type {
  MarketplaceEventJobData,
  MaintenanceJobData,
  MarketplaceSyncJobData,
} from './types.js';
import type {
  RecomputeAggregatesJob,
  OrderEventNotificationJob,
  LowInventoryAlertJob,
  ConnectionBackfillJob,
  WebhookProcessJob,
} from './types.js';

let eventsWorker: Worker<MarketplaceEventJobData> | null = null;
let maintenanceWorker: Worker<MaintenanceJobData> | null = null;
let syncWorker: Worker<MarketplaceSyncJobData> | null = null;
let workersStarted = false;

/** Process one events-queue job, dispatching on its job name. */
async function processEventJob(job: Job<MarketplaceEventJobData>): Promise<void> {
  switch (job.name) {
    case JOB_RECOMPUTE_AGGREGATES:
      await handleRecomputeAggregates(job.data as RecomputeAggregatesJob);
      return;
    case JOB_ORDER_EVENT_NOTIFICATION:
      await handleOrderEventNotification(job.data as OrderEventNotificationJob);
      return;
    case JOB_LOW_INVENTORY_ALERT:
      await handleLowInventoryAlert(job.data as LowInventoryAlertJob);
      return;
    default:
      throw new UnrecoverableError(`Unknown marketplace event job: ${job.name}`);
  }
}

/** Process one maintenance-queue job, dispatching on its job name. */
async function processMaintenanceJob(job: Job<MaintenanceJobData>): Promise<void> {
  switch (job.name) {
    case JOB_EXPIRE_RESERVATIONS:
      await handleExpireReservations();
      return;
    case JOB_RECOMPUTE_AGGREGATES_SWEEP:
      await handleAggregateSweep();
      return;
    default:
      throw new UnrecoverableError(`Unknown maintenance job: ${job.name}`);
  }
}

/** Process one connector-sync-queue job, dispatching on its job name. */
async function processSyncJob(job: Job<MarketplaceSyncJobData>): Promise<void> {
  switch (job.name) {
    case JOB_CONNECTION_BACKFILL:
      await handleConnectionBackfill(job.data as ConnectionBackfillJob);
      return;
    case JOB_WEBHOOK_PROCESS:
      await handleWebhookProcess(job.data as WebhookProcessJob);
      return;
    default:
      throw new UnrecoverableError(`Unknown connector-sync job: ${job.name}`);
  }
}

/**
 * Start the marketplace queue workers for this process. Idempotent; a no-op when
 * Redis is not configured (jobs run inline via the producers).
 */
export function startWorkers(): void {
  if (workersStarted) {
    return;
  }
  if (!isQueueEnabled()) {
    log.general.info('Marketplace queue disabled (REDIS_URL not set) — jobs run inline');
    return;
  }
  workersStarted = true;

  const connection = getQueueConnection();

  eventsWorker = new Worker<MarketplaceEventJobData>(MARKETPLACE_EVENTS_QUEUE, processEventJob, {
    connection,
    concurrency: EVENTS_WORKER_CONCURRENCY,
  });

  maintenanceWorker = new Worker<MaintenanceJobData>(
    MARKETPLACE_MAINTENANCE_QUEUE,
    processMaintenanceJob,
    { connection, concurrency: MAINTENANCE_WORKER_CONCURRENCY },
  );

  syncWorker = new Worker<MarketplaceSyncJobData>(MARKETPLACE_SYNC_QUEUE, processSyncJob, {
    connection,
    concurrency: SYNC_WORKER_CONCURRENCY,
  });

  for (const worker of [eventsWorker, maintenanceWorker, syncWorker]) {
    worker.on('failed', (job, err) => {
      const jobId = job?.id ?? 'unknown';
      log.general.warn({ queue: worker.name, jobId, err: err.message }, 'Queue job failed');
    });
    worker.on('error', (err) => {
      log.general.error({ queue: worker.name, err }, 'Queue worker error');
    });
  }

  registerSchedules().catch((err) =>
    log.general.error({ err }, 'Failed to register marketplace repeatable jobs'),
  );

  log.general.info('Marketplace workers started');
}

/**
 * Close workers, producer queues, and the connection. Safe to call when nothing
 * started. The shared repeatable schedules are removed ONLY if THIS process
 * registered them (i.e. it started workers) — a web-only process (Redis
 * configured but workers never started) must not unregister fleet-wide schedules.
 */
export async function shutdownQueues(): Promise<void> {
  const didStartWorkers = workersStarted;
  if (!workersStarted && !isQueueEnabled()) {
    return;
  }

  if (didStartWorkers) {
    await removeSchedules().catch((err) =>
      log.general.warn({ err }, 'Failed to remove marketplace repeatable jobs'),
    );
  }

  const workers: Array<
    Worker<MarketplaceEventJobData> | Worker<MaintenanceJobData> | Worker<MarketplaceSyncJobData>
  > = [];
  if (eventsWorker) workers.push(eventsWorker);
  if (maintenanceWorker) workers.push(maintenanceWorker);
  if (syncWorker) workers.push(syncWorker);

  await Promise.allSettled(workers.map((w) => w.close()));

  eventsWorker = null;
  maintenanceWorker = null;
  syncWorker = null;
  workersStarted = false;

  await closeQueues();
  await closeQueueConnection();

  log.general.info('Marketplace queues closed');
}
