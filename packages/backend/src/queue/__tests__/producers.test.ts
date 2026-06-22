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
const handleRecomputeAggregates = vi.fn();
const handleOrderEventNotification = vi.fn();
const handleLowInventoryAlert = vi.fn();

vi.mock('../queues.js', () => ({
  getEventsQueue: (...args: unknown[]) => getEventsQueue(...args),
}));

vi.mock('../handlers.js', () => ({
  handleRecomputeAggregates: (...args: unknown[]) => handleRecomputeAggregates(...args),
  handleOrderEventNotification: (...args: unknown[]) => handleOrderEventNotification(...args),
  handleLowInventoryAlert: (...args: unknown[]) => handleLowInventoryAlert(...args),
}));

import {
  enqueueRecomputeAggregate,
  enqueueOrderEvent,
  enqueueLowStockAlert,
} from '../producers.js';

beforeEach(() => {
  vi.clearAllMocks();
  handleRecomputeAggregates.mockResolvedValue(undefined);
  handleOrderEventNotification.mockResolvedValue(undefined);
  handleLowInventoryAlert.mockResolvedValue(undefined);
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
