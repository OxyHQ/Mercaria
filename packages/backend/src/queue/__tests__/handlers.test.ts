/**
 * Unit tests for the marketplace job handlers.
 *
 * Focus: `handleExpireReservations` cancels every stale `pending_payment` order
 * the repository returns (the date cut happens in SQL, so the handler simply
 * transitions whatever `findStalePendingOrders` returns) and is a no-op when none
 * are stale. The repository + the order-service transition are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findStalePendingOrders = vi.fn();
const transition = vi.fn();

vi.mock('../../db/orders/orderRepository.js', () => ({
  findOrderById: vi.fn(),
  findStalePendingOrders: (...args: unknown[]) => findStalePendingOrders(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({ findStoreById: vi.fn() }));

vi.mock('../../services/order.service.js', () => ({
  transition: (...args: unknown[]) => transition(...args),
  // The sweep names itself as the SYSTEM actor (#106, ADR 0003 D16). The mock
  // must carry it: reading a name a `vi.mock` factory does not export throws
  // inside the handler's own try/catch, which shows up as "transition was never
  // called" rather than as an import error.
  SYSTEM_ACTOR: { kind: 'system' },
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
    const stale = { id: 'order-old-1', status: 'pending_payment' };
    findStalePendingOrders.mockResolvedValue([stale]);

    await handleExpireReservations();

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(
      stale,
      'cancelled',
      expect.objectContaining({
        note: 'reservation expired',
        actor: { kind: 'system' },
      }),
    );
  });

  it('does nothing when no orders are stale (the date cut happens in SQL)', async () => {
    findStalePendingOrders.mockResolvedValue([]);

    await handleExpireReservations();

    expect(transition).not.toHaveBeenCalled();
  });

  it('continues past a per-order transition failure', async () => {
    const a = { id: 'order-a', status: 'pending_payment' };
    const b = { id: 'order-b', status: 'pending_payment' };
    findStalePendingOrders.mockResolvedValue([a, b]);
    transition.mockRejectedValueOnce(new Error('cannot cancel'));

    await expect(handleExpireReservations()).resolves.toBeUndefined();

    expect(transition).toHaveBeenCalledTimes(2);
  });
});
