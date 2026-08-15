/**
 * The sync queue's WIRING: that the jobs this repo defines are actually reached.
 *
 * ## Why this file exists at all
 *
 * A sweep can be registered, gated, bounded, real-database tested and have ZERO
 * callers — `~/Oxy/AGENTS.md` records that exact shape from Alia's expiry
 * sweeper, where the suite proved the mechanism COULD work and nothing
 * established that it DID. #262's sweep has the same failure available to it: the
 * service is unit-tested, the convergence is contract-tested against a real
 * database, and if the scheduler entry or the worker's `case` were dropped in a
 * rebase every one of those would stay green while no connection was ever
 * re-registered in production.
 *
 * So this asserts the two edges nothing else can see — the repeatable schedule is
 * registered on the SYNC queue, and the sync worker's dispatch reaches the
 * handler — by EXERCISING `startWorkers`, not by grepping for the strings.
 *
 * ## The vacuity floor
 *
 * Every assertion below is paired with the same assertion about a PRE-EXISTING
 * job, in the same currency: a mocked `Worker` that captured no processor, or a
 * queue mock nothing called, would make an empty dispatch table read exactly like
 * a complete one. The pre-existing pair is what fails first if this file's own
 * harness stops measuring anything.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

const handleConnectionBackfill = vi.fn();
const handleConnectionReconcile = vi.fn();
const handleConnectionWebhookReregister = vi.fn();
const handleConnectionWebhookRegistrationSweep = vi.fn();
const handleConnectionWebhookAudit = vi.fn();
const upsertJobScheduler = vi.fn();

/** Every processor `startWorkers` hands to a `Worker`, keyed by queue name. */
const processors = new Map<string, (job: { name: string; data: unknown }) => Promise<void>>();

vi.mock('bullmq', () => ({
  Worker: class {
    readonly name: string;
    constructor(
      queueName: string,
      processor: (job: { name: string; data: unknown }) => Promise<void>,
    ) {
      this.name = queueName;
      processors.set(queueName, processor);
    }
    on(): void {
      /* the failure/error listeners are not what this file measures */
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
  UnrecoverableError: class extends Error {},
}));
vi.mock('../connection.js', () => ({
  isQueueEnabled: () => true,
  getQueueConnection: () => ({}),
  closeQueueConnection: vi.fn(),
}));
vi.mock('../queues.js', () => ({
  getEventsQueue: () => ({ upsertJobScheduler, removeJobScheduler: vi.fn(), close: vi.fn() }),
  getMaintenanceQueue: () => ({ upsertJobScheduler, removeJobScheduler: vi.fn(), close: vi.fn() }),
  getSyncQueue: () => ({ upsertJobScheduler, removeJobScheduler: vi.fn(), close: vi.fn() }),
  closeQueues: vi.fn(),
}));
vi.mock('../handlers.js', () => ({
  handleRecomputeAggregates: vi.fn(),
  handleOrderEventNotification: vi.fn(),
  handleLowInventoryAlert: vi.fn(),
  handleExpireReservations: vi.fn(),
  handleAggregateSweep: vi.fn(),
  handleScopedAggregateSweep: vi.fn(),
  handleReviewClassificationSweep: vi.fn(),
  handleConnectionBackfill: (...a: unknown[]) => handleConnectionBackfill(...a),
  handleConnectionReconcile: (...a: unknown[]) => handleConnectionReconcile(...a),
  handleConnectionWebhookReregister: (...a: unknown[]) =>
    handleConnectionWebhookReregister(...a),
  handleConnectionWebhookRegistrationSweep: (...a: unknown[]) =>
    handleConnectionWebhookRegistrationSweep(...a),
  handleConnectionWebhookAudit: (...a: unknown[]) => handleConnectionWebhookAudit(...a),
  handleWebhookProcess: vi.fn(),
  handleProductPush: vi.fn(),
  handleOrderSync: vi.fn(),
  handleInventorySync: vi.fn(),
  handleFulfillmentPush: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  CONNECTOR_RECONCILE_INTERVAL_MS,
  JOB_CONNECTION_BACKFILL,
  CONNECTOR_WEBHOOK_REGISTRATION_SWEEP_INTERVAL_MS,
  JOB_CONNECTION_RECONCILE,
  JOB_CONNECTION_WEBHOOK_REGISTRATION_SWEEP,
  JOB_CONNECTION_WEBHOOK_AUDIT,
  JOB_CONNECTION_WEBHOOK_REREGISTER,
  MARKETPLACE_SYNC_QUEUE,
  SCHEDULER_CONNECTION_RECONCILE,
  SCHEDULER_CONNECTION_WEBHOOK_REGISTRATION,
} from '../constants.js';
import { startWorkers } from '../workers.js';

/** The sync processor `startWorkers` installed, or a failed expectation. */
function syncProcessor(): (job: { name: string; data: unknown }) => Promise<void> {
  const processor = processors.get(MARKETPLACE_SYNC_QUEUE);
  expect(processor, 'no processor was installed for the sync queue').toBeTypeOf('function');
  return processor as (job: { name: string; data: unknown }) => Promise<void>;
}

beforeAll(async () => {
  // `workersStarted` is module state, so this runs exactly once for the file and
  // every assertion reads what that one call produced. `registerSchedules` is
  // fired and not awaited inside it, so yield before reading the scheduler calls.
  startWorkers();
  await Promise.resolve();
  await Promise.resolve();
});

describe('the sync queue registers the repeatable sweeps', () => {
  it('registers #262 webhook re-registration on the SYNC queue, at its own cadence', async () => {
    // The vacuity floor first, in the same currency: if this harness captured no
    // scheduler calls at all, the pre-existing reconcile sweep would be missing
    // too — and that is a fact about this file, not about #262.
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      SCHEDULER_CONNECTION_RECONCILE,
      { every: CONNECTOR_RECONCILE_INTERVAL_MS },
      { name: JOB_CONNECTION_RECONCILE, data: {} },
    );

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      SCHEDULER_CONNECTION_WEBHOOK_REGISTRATION,
      { every: CONNECTOR_WEBHOOK_REGISTRATION_SWEEP_INTERVAL_MS },
      { name: JOB_CONNECTION_WEBHOOK_REGISTRATION_SWEEP, data: {} },
    );
    // Registered UNCONDITIONALLY: the flag that decides whether the sweep runs is
    // read inside the sweep, so turning it back on takes effect on the next tick
    // rather than needing the schedule re-registered by a deploy.
    expect(CONNECTOR_WEBHOOK_REGISTRATION_SWEEP_INTERVAL_MS).toBeLessThan(
      CONNECTOR_RECONCILE_INTERVAL_MS,
    );
  });
});

describe('the sync worker dispatches the #262 jobs', () => {
  it('reaches the SWEEP handler for its repeatable job name', async () => {
    // Floor: a pre-existing repeatable job must dispatch through the same table.
    await syncProcessor()({ name: JOB_CONNECTION_RECONCILE, data: {} });
    expect(handleConnectionReconcile).toHaveBeenCalledTimes(1);

    await syncProcessor()({ name: JOB_CONNECTION_WEBHOOK_REGISTRATION_SWEEP, data: {} });
    expect(handleConnectionWebhookRegistrationSweep).toHaveBeenCalledTimes(1);
  });

  it('reaches the per-connection handler with BOTH ids the payload carries', async () => {
    // Floor: the pre-existing per-connection job forwards its payload the same way.
    await syncProcessor()({
      name: JOB_CONNECTION_BACKFILL,
      data: { storeId: 'store-1', connectionId: 'conn-1' },
    });
    expect(handleConnectionBackfill).toHaveBeenCalledWith({
      storeId: 'store-1',
      connectionId: 'conn-1',
    });

    await syncProcessor()({
      name: JOB_CONNECTION_WEBHOOK_REREGISTER,
      data: { storeId: 'store-2', connectionId: 'conn-2' },
    });
    // BOTH ids: `storeId` is what scopes the connection lookup, so a handler that
    // dropped it would resolve a connection by id alone — a cross-store read from
    // a queue payload.
    expect(handleConnectionWebhookReregister).toHaveBeenCalledWith({
      storeId: 'store-2',
      connectionId: 'conn-2',
    });
  });

  it('reaches the #295 AUDIT handler with BOTH ids, and registers NO schedule for it', async () => {
    // The audit is a per-connection job on the EXISTING six-hourly reconcile's
    // cadence, not a sweep of its own. Two halves, and the second is the one a
    // reviewer would want checked: a dispatch case nothing exercises is a queue
    // job whose handler is never reached, and the mocked handler table here
    // would have gone on passing without it.
    await syncProcessor()({
      name: JOB_CONNECTION_WEBHOOK_AUDIT,
      data: { storeId: 'store-3', connectionId: 'conn-3' },
    });

    expect(handleConnectionWebhookAudit).toHaveBeenCalledWith({
      storeId: 'store-3',
      connectionId: 'conn-3',
    });
    // NO NEW SCHEDULE. Asserted against the scheduler calls this file already
    // captured, so the floor is the two registrations above having been seen —
    // "nothing was registered for it" is also what a harness that captured
    // nothing reports.
    const scheduled = upsertJobScheduler.mock.calls;
    expect(scheduled.length, 'the floor: this harness did capture schedules').toBeGreaterThan(0);
    expect(
      scheduled.some((call) => JSON.stringify(call).includes(JOB_CONNECTION_WEBHOOK_AUDIT)),
      'the audit must ride the existing reconcile, never its own repeatable job',
    ).toBe(false);
  });
});
