/**
 * Unit tests for the marketplace job handlers.
 *
 * Focus: `handleExpireReservations` cancels every stale `pending_payment` order
 * the Mongo filter returns (the date cut happens in Mongo, so the handler simply
 * transitions whatever `Order.find` returns) and is a no-op when none are stale.
 * Models + the order-service transition are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const orderFind = vi.fn();
const transition = vi.fn();

vi.mock('../../models/order.js', () => ({
  Order: { find: (...args: unknown[]) => orderFind(...args) },
}));

vi.mock('../../models/listing.js', () => ({ Listing: { findById: vi.fn() } }));
vi.mock('../../models/store.js', () => ({ Store: { findById: vi.fn() } }));
vi.mock('../../models/review.js', () => ({ Review: { aggregate: vi.fn() } }));

vi.mock('../../services/order.service.js', () => ({
  transition: (...args: unknown[]) => transition(...args),
}));

vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

import { handleExpireReservations } from '../handlers.js';

beforeEach(() => {
  vi.clearAllMocks();
  transition.mockResolvedValue(undefined);
});

describe('handleExpireReservations', () => {
  it('cancels each stale pending_payment order via transition', async () => {
    const stale = { _id: 'order-old-1', status: 'pending_payment' };
    orderFind.mockResolvedValue([stale]);

    await handleExpireReservations();

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(
      stale,
      'cancelled',
      expect.objectContaining({ note: 'reservation expired' }),
    );
  });

  it('does nothing when no orders are stale (filtered out by Mongo)', async () => {
    orderFind.mockResolvedValue([]);

    await handleExpireReservations();

    expect(transition).not.toHaveBeenCalled();
  });

  it('continues past a per-order transition failure', async () => {
    const a = { _id: 'order-a', status: 'pending_payment' };
    const b = { _id: 'order-b', status: 'pending_payment' };
    orderFind.mockResolvedValue([a, b]);
    transition.mockRejectedValueOnce(new Error('cannot cancel'));

    await expect(handleExpireReservations()).resolves.toBeUndefined();

    expect(transition).toHaveBeenCalledTimes(2);
  });
});
