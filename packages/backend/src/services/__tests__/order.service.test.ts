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
const enqueueOrderEvent = vi.fn();
const findOneAndUpdate = vi.fn();
const upsertCustomerOnPaid = vi.fn();

vi.mock('../inventory.service.js', () => ({
  commit: (...args: unknown[]) => commit(...args),
  release: (...args: unknown[]) => release(...args),
  restock: (...args: unknown[]) => restock(...args),
}));

vi.mock('../customer.service.js', () => ({
  upsertOnPaid: (...args: unknown[]) => upsertCustomerOnPaid(...args),
}));

vi.mock('../../models/order.js', () => ({
  Order: {
    findOne: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
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

vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: (...args: unknown[]) => enqueueOrderEvent(...args),
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
    buyerOxyUserId: 'buyer-1',
    sellerType: options.sellerType ?? 'user',
    sellerOxyUserId: options.sellerType === 'store' ? undefined : 'seller-X',
    storeId: options.sellerType === 'store' ? 'store-A' : undefined,
    totals: { grandTotal: { amount: 9000, currency: 'FAIR' } },
    payment: { status: options.paymentStatus ?? 'unpaid', provider: 'oxy_pay' as const },
    shipping: { method: 'standard' as const, label: 'Standard shipping', cost: { amount: 500, currency: 'FAIR' }, trackingNumber: null as string | null },
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
  enqueueOrderEvent.mockReset().mockResolvedValue(undefined);
  upsertCustomerOnPaid.mockReset().mockResolvedValue(undefined);
  // Default: the atomic CAS WINS — resolve a non-null persisted doc reflecting
  // the requested status. Tests that simulate a lost CAS override per-call.
  findOneAndUpdate.mockReset().mockImplementation((filter: { _id: unknown }, update: { $set: { status: OrderStatus } }) =>
    Promise.resolve({ _id: filter._id, status: update.$set.status }),
  );
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
      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
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
      // Illegal transitions reject on the in-memory table check, before the CAS.
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });
  }
});

describe('order.service.transition — inventory effects', () => {
  it('cancel from pending_payment (unpaid) releases each line', async () => {
    const doc = mockOrder('pending_payment', { paymentStatus: 'unpaid' });
    await transition(doc, 'cancelled', { actorOxyUserId: 'actor-1' });
    expect(release).toHaveBeenCalledTimes(2);
    // Items carry no locationId → the 3rd arg is undefined (default location).
    expect(release).toHaveBeenCalledWith('v1', 2, undefined);
    expect(release).toHaveBeenCalledWith('v2', 1, undefined);
    expect(restock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('paid (user seller) commits each line, bumps salesCount, marks payment paid', async () => {
    const doc = mockOrder('pending_payment', { sellerType: 'user' });
    await transition(doc, 'paid', { actorOxyUserId: 'actor-1' });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith('v1', 2, undefined);
    expect(commit).toHaveBeenCalledWith('v2', 1, undefined);
    expect(sellerProfileUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'seller-X' },
      { $inc: { salesCount: 1 } },
      { upsert: true },
    );
    expect(doc.payment.status).toBe('paid');
    expect(doc.payment.paidAt).toBeInstanceOf(Date);
  });

  it('paid (store seller) bumps store salesCount and relates the customer via upsertOnPaid exactly once', async () => {
    const doc = mockOrder('pending_payment', { sellerType: 'store' });
    await transition(doc, 'paid', { actorOxyUserId: 'actor-1' });
    expect(storeUpdateOne).toHaveBeenCalledWith({ _id: 'store-A' }, { $inc: { salesCount: 1 } });
    expect(upsertCustomerOnPaid).toHaveBeenCalledTimes(1);
    expect(upsertCustomerOnPaid).toHaveBeenCalledWith('store-A', 'buyer-1', {
      amount: 9000,
      currency: 'FAIR',
    });
    // P2P seller-profile path is NOT taken for a store order.
    expect(sellerProfileUpdateOne).not.toHaveBeenCalled();
  });

  it('refund of a paid order restocks each line (not release/commit) and marks payment refunded', async () => {
    const doc = mockOrder('paid', { paymentStatus: 'paid' });
    await transition(doc, 'refunded', { actorOxyUserId: 'actor-1' });
    expect(restock).toHaveBeenCalledTimes(2);
    expect(restock).toHaveBeenCalledWith('v1', 2, undefined);
    expect(restock).toHaveBeenCalledWith('v2', 1, undefined);
    expect(release).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(doc.payment.status).toBe('refunded');
  });
});

describe('order.service.transition — atomic CAS (side effects run at most once)', () => {
  it('a concurrent double-cancel releases the reservation EXACTLY once (the loser CONFLICTs, no second release)', async () => {
    // First CAS WINS (truthy persisted doc), second CAS LOSES (null — already moved off `pending_payment`).
    findOneAndUpdate
      .mockReset()
      .mockResolvedValueOnce({ _id: 'order-1', status: 'cancelled' })
      .mockResolvedValueOnce(null);

    const doc1 = mockOrder('pending_payment', { paymentStatus: 'unpaid' });
    const doc2 = mockOrder('pending_payment', { paymentStatus: 'unpaid' });

    // Winner: releases the 2 lines once.
    await transition(doc1, 'cancelled', {});
    // Loser: CAS matched nothing → CONFLICT, no inventory effect.
    await expect(transition(doc2, 'cancelled', {})).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    // Released ONCE for the 2 lines (v1, v2) — not 4 (which a double-run would produce).
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith('v1', 2, undefined);
    expect(release).toHaveBeenCalledWith('v2', 1, undefined);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});
