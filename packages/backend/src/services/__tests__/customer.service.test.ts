/**
 * Unit tests for `customer.service`.
 *
 * `mongodb-memory-server` is not available, so the Customer model (and the
 * order-hydration summarizer + Order model it imports) are mocked. Tests assert
 * the B5 customer contract: `upsertOnPaid` issues ONE atomic guarded
 * `findOneAndUpdate` (upsert) that increments `orderCount`/`totalSpent.amount`,
 * sets `lastOrderAt`, and seeds identity on insert; `resolveOrCreate` upserts an
 * Oxy-backed record when given an `oxyUserId` and creates a WALK-IN otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOneAndUpdate = vi.fn();
const findOne = vi.fn();
const create = vi.fn();

vi.mock('../../models/customer.js', () => ({
  Customer: {
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
    findOne: (...args: unknown[]) => findOne(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));

vi.mock('../../models/order.js', () => ({
  Order: { find: vi.fn() },
}));

vi.mock('../order-hydration.service.js', () => ({
  summarizeOrders: vi.fn().mockResolvedValue([]),
}));

import { upsertOnPaid, resolveOrCreate } from '../customer.service.js';

const STORE = 'store-A';
const OXY = 'buyer-1';

beforeEach(() => {
  findOneAndUpdate.mockReset();
  findOne.mockReset();
  create.mockReset();
});

describe('customer.service.upsertOnPaid', () => {
  it('issues ONE guarded upsert that increments orderCount + totalSpent and sets lastOrderAt', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: 'c1' });

    await upsertOnPaid(STORE, OXY, { amount: 12_500, currency: 'FAIR' });

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ storeId: STORE, oxyUserId: OXY });
    expect((update as { $inc: Record<string, number> }).$inc).toEqual({
      'stats.orderCount': 1,
      'stats.totalSpent.amount': 12_500,
    });
    expect((update as { $set: Record<string, unknown> }).$set['stats.lastOrderAt']).toBeInstanceOf(Date);
    const onInsert = (update as { $setOnInsert: Record<string, unknown> }).$setOnInsert;
    expect(onInsert.storeId).toBe(STORE);
    expect(onInsert.oxyUserId).toBe(OXY);
    expect(onInsert.isWalkIn).toBe(false);
    expect(onInsert['stats.totalSpent.currency']).toBe('FAIR');
    // orderCount is NOT setOnInsert (would conflict with $inc on the same path).
    expect(onInsert['stats.orderCount']).toBeUndefined();
    expect(options).toEqual({ upsert: true, new: true });
  });
});

describe('customer.service.resolveOrCreate', () => {
  it('upserts an Oxy-backed customer (isWalkIn false) when given an oxyUserId', async () => {
    findOneAndUpdate.mockResolvedValueOnce({
      toObject: () => ({ _id: 'c1', storeId: STORE, oxyUserId: OXY, isWalkIn: false }),
    });

    const customer = await resolveOrCreate(STORE, { oxyUserId: OXY, displayName: 'Buyer One' });

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ storeId: STORE, oxyUserId: OXY });
    expect((update as { $set: Record<string, unknown> }).$set.isWalkIn).toBe(false);
    expect((update as { $set: Record<string, unknown> }).$set.displayName).toBe('Buyer One');
    expect(options).toEqual({ upsert: true, new: true });
    expect(customer.isWalkIn).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a WALK-IN customer (isWalkIn true, no oxyUserId) when none is given', async () => {
    create.mockResolvedValueOnce({
      toObject: () => ({ _id: 'c2', storeId: STORE, isWalkIn: true, displayName: 'Walk-in' }),
    });

    const customer = await resolveOrCreate(STORE, { displayName: 'Walk-in' });

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const doc = create.mock.calls[0][0] as { storeId: string; isWalkIn: boolean; oxyUserId?: string };
    expect(doc.storeId).toBe(STORE);
    expect(doc.isWalkIn).toBe(true);
    expect(doc.oxyUserId).toBeUndefined();
    expect(customer.isWalkIn).toBe(true);
  });
});
