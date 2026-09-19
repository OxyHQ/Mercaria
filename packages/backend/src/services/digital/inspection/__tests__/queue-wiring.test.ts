/**
 * That the inspection jobs are actually REACHED — the edge nothing else can see.
 *
 * ## Why this file exists, and why it lives here
 *
 * `~/Oxy/AGENTS.md` records the shape from Alia's expiry sweeper: a mechanism that
 * was unit-tested, contract-tested and had ZERO callers. The whole of this
 * workstream has that failure available to it — every parser could be exhaustively
 * proven while the worker's `case` or the producer's `add` was dropped in a rebase,
 * and no upload would ever be inspected with the suite green.
 *
 * `sync-worker-wiring.test.ts` does this for the connector queue. This file is its
 * sibling for the digital queue, and it sits in this directory rather than beside it
 * because the inspection directory is what this workstream owns — the queue files
 * are modified, not owned. The assertion is the same and so is the vacuity floor.
 *
 * ## The floor
 *
 * Every assertion about the NEW queue is paired with the same assertion about a
 * PRE-EXISTING one, in the same currency: a mocked `Worker` that captured no
 * processor, or a queue mock nothing called, would make an empty dispatch table read
 * exactly like a complete one. The pre-existing pair is what fails first if this
 * file's own harness stops measuring anything.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleAssetFileInspect = vi.fn();
const handleAssetVersionInspect = vi.fn();
const handleConnectionBackfill = vi.fn();
const add = vi.fn();

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
  Queue: class {},
  UnrecoverableError: class extends Error {},
}));
vi.mock('../../../../queue/connection.js', () => ({
  isQueueEnabled: () => true,
  getQueueConnection: () => ({}),
  closeQueueConnection: vi.fn(),
}));

/** Swapped to `null` by the inline-fallback case. */
let digitalQueue: unknown = { add: (...args: unknown[]) => add(...args) };
const stubQueue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn(), close: vi.fn() };

vi.mock('../../../../queue/queues.js', () => ({
  getEventsQueue: () => stubQueue,
  getMaintenanceQueue: () => stubQueue,
  getSyncQueue: () => stubQueue,
  getDigitalQueue: () => digitalQueue,
  closeQueues: vi.fn(),
}));
vi.mock('../../../../queue/handlers.js', () => ({
  handleRecomputeAggregates: vi.fn(),
  handleOrderEventNotification: vi.fn(),
  handleLowInventoryAlert: vi.fn(),
  handleExpireReservations: vi.fn(),
  handleAggregateSweep: vi.fn(),
  handleScopedAggregateSweep: vi.fn(),
  handleReviewClassificationSweep: vi.fn(),
  handleConnectionBackfill: (...args: unknown[]) => handleConnectionBackfill(...args),
  handleConnectionReconcile: vi.fn(),
  handleConnectionWebhookReregister: vi.fn(),
  handleConnectionWebhookRegistrationSweep: vi.fn(),
  handleConnectionWebhookAudit: vi.fn(),
  handleWebhookProcess: vi.fn(),
  handleProductPush: vi.fn(),
  handleOrderSync: vi.fn(),
  handleInventorySync: vi.fn(),
  handleFulfillmentPush: vi.fn(),
  handleAssetFileInspect: (...args: unknown[]) => handleAssetFileInspect(...args),
  handleAssetVersionInspect: (...args: unknown[]) => handleAssetVersionInspect(...args),
}));
vi.mock('../../../../lib/logger.js', () => ({
  log: { general: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  DIGITAL_WORKER_CONCURRENCY,
  JOB_ASSET_FILE_INSPECT,
  JOB_ASSET_VERSION_INSPECT,
  JOB_CONNECTION_BACKFILL,
  MARKETPLACE_DIGITAL_QUEUE,
  MARKETPLACE_SYNC_QUEUE,
} from '../../../../queue/constants.js';
import { enqueueAssetFileInspection, enqueueAssetVersionInspection } from '../../../../queue/producers.js';
import { startWorkers } from '../../../../queue/workers.js';

beforeEach(() => {
  vi.clearAllMocks();
  handleAssetFileInspect.mockResolvedValue(undefined);
  handleAssetVersionInspect.mockResolvedValue(undefined);
  digitalQueue = { add: (...args: unknown[]) => add(...args) };
});

describe('the digital worker is installed and its dispatch reaches the handlers', () => {
  it('installs a processor for the digital queue, as it does for the sync queue', () => {
    startWorkers();
    // The floor: if this harness captured nothing, the pre-existing sync queue would
    // be missing too and this assertion is what says so.
    expect(processors.get(MARKETPLACE_SYNC_QUEUE)).toBeTypeOf('function');
    expect(processors.get(MARKETPLACE_DIGITAL_QUEUE)).toBeTypeOf('function');
  });

  it('dispatches a per-FILE inspection to its handler with the whole payload', async () => {
    startWorkers();
    const processor = processors.get(MARKETPLACE_DIGITAL_QUEUE);
    expect(processor).toBeTypeOf('function');
    await processor?.({
      name: JOB_ASSET_FILE_INSPECT,
      data: { versionId: 'ver_1', fileId: 'file_1' },
    });
    expect(handleAssetFileInspect).toHaveBeenCalledWith({ versionId: 'ver_1', fileId: 'file_1' });
  });

  it('dispatches a per-VERSION fan-out to its handler', async () => {
    startWorkers();
    await processors.get(MARKETPLACE_DIGITAL_QUEUE)?.({
      name: JOB_ASSET_VERSION_INSPECT,
      data: { versionId: 'ver_9' },
    });
    expect(handleAssetVersionInspect).toHaveBeenCalledWith({ versionId: 'ver_9' });
  });

  it('still reaches the PRE-EXISTING sync jobs, which is the control', async () => {
    startWorkers();
    await processors.get(MARKETPLACE_SYNC_QUEUE)?.({
      name: JOB_CONNECTION_BACKFILL,
      data: { storeId: 'store_1', connectionId: 'conn_1' },
    });
    expect(handleConnectionBackfill).toHaveBeenCalledWith({
      storeId: 'store_1',
      connectionId: 'conn_1',
    });
  });

  it('rejects an unknown job on the digital queue rather than silently ignoring it', async () => {
    startWorkers();
    await expect(
      processors.get(MARKETPLACE_DIGITAL_QUEUE)?.({ name: 'not-a-job', data: {} }),
    ).rejects.toThrow(/Unknown digital inspection job/u);
  });

  it('gives the digital queue its own modest concurrency', () => {
    // Derived from `MAX_INSPECTED_FILE_BYTES` rather than chosen: the product is the
    // memory this queue may hold. The assertion is that it is SMALL, which is the
    // property, not the exact number.
    expect(DIGITAL_WORKER_CONCURRENCY).toBeGreaterThan(0);
    expect(DIGITAL_WORKER_CONCURRENCY).toBeLessThanOrEqual(4);
  });

  it('uses a colon-free queue name, which BullMQ requires', () => {
    expect(MARKETPLACE_DIGITAL_QUEUE).not.toContain(':');
    expect(MARKETPLACE_SYNC_QUEUE).not.toContain(':');
  });
});

describe('the producers enqueue, and fall back inline without Redis', () => {
  it('enqueues a per-file inspection with a stable job id', async () => {
    await enqueueAssetFileInspection({ versionId: 'ver_1', fileId: 'file_1' });
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, options] = add.mock.calls[0];
    expect(name).toBe(JOB_ASSET_FILE_INSPECT);
    expect(data).toEqual({ versionId: 'ver_1', fileId: 'file_1' });
    // A hashed, colon-free id per FILE: two submissions of one file are one job.
    expect(options.jobId).toMatch(/^[0-9a-f]{64}$/u);
    expect(handleAssetFileInspect).not.toHaveBeenCalled();

    // And the id is STABLE for the same file, which is what dedupes it.
    await enqueueAssetFileInspection({ versionId: 'ver_1', fileId: 'file_1' });
    expect(add.mock.calls[1][2].jobId).toBe(options.jobId);
    // ...and different for a different file, or it would dedupe two real jobs into one.
    await enqueueAssetFileInspection({ versionId: 'ver_1', fileId: 'file_2' });
    expect(add.mock.calls[2][2].jobId).not.toBe(options.jobId);
  });

  it('enqueues a per-version fan-out keyed by the VERSION', async () => {
    await enqueueAssetVersionInspection({ versionId: 'ver_1' });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe(JOB_ASSET_VERSION_INSPECT);
  });

  it('runs the handler INLINE when there is no queue, so a Redis-less deployment still inspects', async () => {
    digitalQueue = null;
    await enqueueAssetFileInspection({ versionId: 'ver_1', fileId: 'file_1' });
    expect(add).not.toHaveBeenCalled();
    expect(handleAssetFileInspect).toHaveBeenCalledWith({ versionId: 'ver_1', fileId: 'file_1' });
  });

  it('swallows an inline failure rather than failing the caller that enqueued', async () => {
    digitalQueue = null;
    handleAssetFileInspect.mockRejectedValue(new Error('storage is down'));
    // The producers' existing contract: an inline handler is best-effort, because the
    // caller is an upload request and the durable record is the inspection row.
    await expect(
      enqueueAssetFileInspection({ versionId: 'ver_1', fileId: 'file_1' }),
    ).resolves.toBeUndefined();
  });
});
