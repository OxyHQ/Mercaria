/**
 * Unit tests for the marketplace queue producers' graceful-degradation contract.
 *
 * When the queue is DISABLED (no events queue), a producer runs the SAME handler
 * INLINE rather than enqueuing. When ENABLED, it enqueues via `queue.add` and
 * does NOT run the handler inline. `queues.js` and `handlers.js` are mocked so no
 * Redis or Mongo is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getEventsQueue = vi.fn();
const getSyncQueue = vi.fn();
const handleRecomputeAggregates = vi.fn();
const handleOrderEventNotification = vi.fn();
const handleLowInventoryAlert = vi.fn();
const handleConnectionBackfill = vi.fn();
const handleWebhookProcess = vi.fn();

vi.mock('../queues.js', () => ({
  getEventsQueue: (...args: unknown[]) => getEventsQueue(...args),
  getSyncQueue: (...args: unknown[]) => getSyncQueue(...args),
}));

vi.mock('../handlers.js', () => ({
  handleRecomputeAggregates: (...args: unknown[]) => handleRecomputeAggregates(...args),
  handleOrderEventNotification: (...args: unknown[]) => handleOrderEventNotification(...args),
  handleLowInventoryAlert: (...args: unknown[]) => handleLowInventoryAlert(...args),
  handleConnectionBackfill: (...args: unknown[]) => handleConnectionBackfill(...args),
  handleWebhookProcess: (...args: unknown[]) => handleWebhookProcess(...args),
}));

import {
  enqueueRecomputeAggregate,
  enqueueOrderEvent,
  enqueueLowStockAlert,
  enqueueConnectionBackfill,
  enqueueWebhookProcess,
} from '../producers.js';

beforeEach(() => {
  vi.clearAllMocks();
  handleRecomputeAggregates.mockResolvedValue(undefined);
  handleOrderEventNotification.mockResolvedValue(undefined);
  handleLowInventoryAlert.mockResolvedValue(undefined);
  handleConnectionBackfill.mockResolvedValue(undefined);
  handleWebhookProcess.mockResolvedValue(undefined);
});

describe('producers — queue DISABLED runs the inline handler', () => {
  beforeEach(() => {
    getEventsQueue.mockReturnValue(null);
  });

  it('enqueueRecomputeAggregate runs the handler inline', async () => {
    const payload = { targetType: 'listing' as const, targetId: 'listing-1' };
    await enqueueRecomputeAggregate(payload);
    expect(handleRecomputeAggregates).toHaveBeenCalledWith(payload);
  });

  it('enqueueOrderEvent runs the handler inline', async () => {
    const payload = { orderId: 'order-1', event: 'placed' as const };
    await enqueueOrderEvent(payload);
    expect(handleOrderEventNotification).toHaveBeenCalledWith(payload);
  });

  it('enqueueLowStockAlert runs the handler inline', async () => {
    const payload = {
      storeId: 'store-1',
      listingId: 'listing-1',
      variantId: 'variant-1',
      variantTitle: 'Size / M',
      available: 2,
    };
    await enqueueLowStockAlert(payload);
    expect(handleLowInventoryAlert).toHaveBeenCalledWith(payload);
  });

  it('swallows an inline handler failure (never throws)', async () => {
    handleRecomputeAggregates.mockRejectedValue(new Error('boom'));
    await expect(
      enqueueRecomputeAggregate({ targetType: 'store', targetId: 'store-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('producers — queue ENABLED enqueues and does NOT run inline', () => {
  it('enqueueRecomputeAggregate calls queue.add with the job name + payload', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getEventsQueue.mockReturnValue({ add });
    const payload = { targetType: 'listing' as const, targetId: 'listing-1' };

    await enqueueRecomputeAggregate(payload);

    expect(add).toHaveBeenCalledWith('recompute-aggregates', payload);
    expect(handleRecomputeAggregates).not.toHaveBeenCalled();
  });

  it('enqueueOrderEvent calls queue.add with the job name + payload', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getEventsQueue.mockReturnValue({ add });
    const payload = { orderId: 'order-1', event: 'paid' as const };

    await enqueueOrderEvent(payload);

    expect(add).toHaveBeenCalledWith('order-event-notification', payload);
    expect(handleOrderEventNotification).not.toHaveBeenCalled();
  });
});

describe('connector-sync producers — queue DISABLED runs the handler inline', () => {
  beforeEach(() => {
    getSyncQueue.mockReturnValue(null);
  });

  it('enqueueConnectionBackfill runs the backfill handler inline (no Redis)', async () => {
    const payload = { storeId: 'store-1', connectionId: 'conn-1' };
    await enqueueConnectionBackfill(payload);
    expect(handleConnectionBackfill).toHaveBeenCalledWith(payload);
  });

  it('enqueueWebhookProcess runs the webhook handler inline (no Redis)', async () => {
    const payload = { connectionId: 'conn-1', topic: 'products/update', payload: { id: 1 } };
    await enqueueWebhookProcess(payload);
    expect(handleWebhookProcess).toHaveBeenCalledWith(payload);
  });

  it('swallows an inline backfill failure (never throws)', async () => {
    handleConnectionBackfill.mockRejectedValue(new Error('boom'));
    await expect(
      enqueueConnectionBackfill({ storeId: 'store-1', connectionId: 'conn-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('connector-sync producers — queue ENABLED enqueues and does NOT run inline', () => {
  it('enqueueConnectionBackfill adds the job with a colon-free hashed dedup jobId', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getSyncQueue.mockReturnValue({ add });
    const payload = { storeId: 'store-1', connectionId: 'conn-1' };

    await enqueueConnectionBackfill(payload);

    expect(handleConnectionBackfill).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe('connection.backfill');
    expect(data).toEqual(payload);
    // A sha256 hex jobId — deterministic, stable, and free of any ':'.
    expect(opts.jobId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enqueueWebhookProcess adds the webhook job with the topic + payload', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getSyncQueue.mockReturnValue({ add });
    const payload = { connectionId: 'conn-1', topic: 'products/delete', payload: { id: 9 } };

    await enqueueWebhookProcess(payload);

    expect(handleWebhookProcess).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith('webhook.process', payload);
  });
});
