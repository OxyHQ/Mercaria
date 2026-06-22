/**
 * Unit tests for `order.service.transition`.
 *
 * `mongodb-memory-server` is not available, so the Order/SellerProfile/Store
 * models, the inventory effects (`commit`/`release`/`restock`) and the
 * order-hydration module are mocked. Tests assert the F4 lifecycle contract:
 * every LEGAL transition succeeds and saves; every ILLEGAL transition is a
 * CONFLICT; unpaid cancel RELEASES the reservation; pay COMMITS + bumps
 * salesCount; refund of a paid order RESTOCKS (not release/commit).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const commit = vi.fn();
const release = vi.fn();
const restock = vi.fn();
const sellerProfileUpdateOne = vi.fn();
const storeUpdateOne = vi.fn();

vi.mock('../inventory.service.js', () => ({
  commit: (...args: unknown[]) => commit(...args),
  release: (...args: unknown[]) => release(...args),
  restock: (...args: unknown[]) => restock(...args),
}));

vi.mock('../../models/order.js', () => ({
  Order: {
    findOne: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  },
}));

vi.mock('../../models/seller-profile.js', () => ({
  SellerProfile: { updateOne: (...args: unknown[]) => sellerProfileUpdateOne(...args) },
}));

vi.mock('../../models/store.js', () => ({
  Store: { updateOne: (...args: unknown[]) => storeUpdateOne(...args), findById: vi.fn() },
}));

vi.mock('../../models/listing.js', () => ({
  Listing: { find: vi.fn() },
}));

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: { countDocuments: vi.fn() },
}));

vi.mock('../order-hydration.service.js', () => ({
  hydrateOrders: vi.fn().mockResolvedValue([]),
  summarizeOrders: vi.fn().mockResolvedValue([]),
}));

import { transition } from '../order.service.js';
import type { IOrder } from '../../models/order.js';
import type { HydratedDocument } from 'mongoose';
import type { OrderStatus } from '@mercaria/shared-types';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** A mock order doc with a mutable status/payment/history + a spied `save`. */
function mockOrder(
  status: OrderStatus,
  options: { paymentStatus?: 'unpaid' | 'paid'; sellerType?: 'user' | 'store' } = {},
) {
  const doc = {
    _id: 'order-1',
    status,
    sellerType: options.sellerType ?? 'user',
    sellerOxyUserId: options.sellerType === 'store' ? undefined : 'seller-X',
    storeId: options.sellerType === 'store' ? 'store-A' : undefined,
    payment: { status: options.paymentStatus ?? 'unpaid', provider: 'oxy_pay' as const },
    shipping: { method: 'standard' as const, label: 'Standard shipping', cost: { amount: 500, currency: 'USD' }, trackingNumber: null as string | null },
    statusHistory: [] as IOrder['statusHistory'],
    items: [
      { variantId: 'v1', quantity: 2 },
      { variantId: 'v2', quantity: 1 },
    ],
    save: vi.fn().mockResolvedValue(undefined),
  };
  return doc as unknown as HydratedDocument<IOrder> & { save: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  commit.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  restock.mockReset().mockResolvedValue(undefined);
  sellerProfileUpdateOne.mockReset().mockResolvedValue(undefined);
  storeUpdateOne.mockReset().mockResolvedValue(undefined);
});

describe('order.service.transition — legal transitions', () => {
  const legal: { from: OrderStatus; to: OrderStatus; paymentStatus?: 'unpaid' | 'paid' }[] = [
    { from: 'pending_payment', to: 'paid' },
    { from: 'paid', to: 'processing', paymentStatus: 'paid' },
    { from: 'processing', to: 'shipped', paymentStatus: 'paid' },
    { from: 'shipped', to: 'delivered', paymentStatus: 'paid' },
    { from: 'paid', to: 'cancelled', paymentStatus: 'paid' },
    { from: 'paid', to: 'refunded', paymentStatus: 'paid' },
    { from: 'processing', to: 'cancelled', paymentStatus: 'paid' },
    { from: 'pending_payment', to: 'cancelled' },
    { from: 'delivered', to: 'refunded', paymentStatus: 'paid' },
  ];

  for (const { from, to, paymentStatus } of legal) {
    it(`allows ${from} → ${to}`, async () => {
      const doc = mockOrder(from, { paymentStatus });
      await transition(doc, to, { actorOxyUserId: 'actor-1' });
      expect(doc.status).toBe(to);
      expect(doc.save).toHaveBeenCalledTimes(1);
    });
  }
});

describe('order.service.transition — illegal transitions', () => {
  const illegal: { from: OrderStatus; to: OrderStatus }[] = [
    { from: 'pending_payment', to: 'shipped' },
    { from: 'paid', to: 'delivered' },
    { from: 'cancelled', to: 'paid' },
    { from: 'refunded', to: 'paid' },
    { from: 'delivered', to: 'shipped' },
    { from: 'shipped', to: 'processing' },
  ];

  for (const { from, to } of illegal) {
    it(`rejects ${from} → ${to} with CONFLICT`, async () => {
      const doc = mockOrder(from, { paymentStatus: 'paid' });
      await expect(transition(doc, to, {})).rejects.toSatisfy(
        (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
      );
      expect(doc.save).not.toHaveBeenCalled();
    });
  }
});

describe('order.service.transition — inventory effects', () => {
  it('cancel from pending_payment (unpaid) releases each line', async () => {
    const doc = mockOrder('pending_payment', { paymentStatus: 'unpaid' });
    await transition(doc, 'cancelled', { actorOxyUserId: 'actor-1' });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith('v1', 2);
    expect(release).toHaveBeenCalledWith('v2', 1);
    expect(restock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('paid (user seller) commits each line, bumps salesCount, marks payment paid', async () => {
    const doc = mockOrder('pending_payment', { sellerType: 'user' });
    await transition(doc, 'paid', { actorOxyUserId: 'actor-1' });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith('v1', 2);
    expect(commit).toHaveBeenCalledWith('v2', 1);
    expect(sellerProfileUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'seller-X' },
      { $inc: { salesCount: 1 } },
      { upsert: true },
    );
    expect(doc.payment.status).toBe('paid');
    expect(doc.payment.paidAt).toBeInstanceOf(Date);
  });

  it('refund of a paid order restocks each line (not release/commit) and marks payment refunded', async () => {
    const doc = mockOrder('paid', { paymentStatus: 'paid' });
    await transition(doc, 'refunded', { actorOxyUserId: 'actor-1' });
    expect(restock).toHaveBeenCalledTimes(2);
    expect(restock).toHaveBeenCalledWith('v1', 2);
    expect(restock).toHaveBeenCalledWith('v2', 1);
    expect(release).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(doc.payment.status).toBe('refunded');
  });
});
