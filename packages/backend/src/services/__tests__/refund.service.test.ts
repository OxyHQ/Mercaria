/**
 * Unit tests for `refund.service.process` (the B6 refund/return core).
 *
 * `mongodb-memory-server` is not available, so the Order/Refund models, the
 * inventory `restock`, the customer `decrementOnRefund`, and the RMA counter are
 * all mocked. Tests assert the B6 contract: a partial refund restocks exactly the
 * refunded units and flips the order to `partially_refunded` (payment unchanged);
 * a full refund flips it to `refunded` + `payment.status: refunded` and decrements
 * the customer's lifetime spend; a cumulative over-refund is a CONFLICT (no create,
 * no restock); the refunded amount is the DISCOUNTED net (not gross); a replayed
 * idempotency key short-circuits (no re-create, no re-restock).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const restock = vi.fn();
const decrementOnRefund = vi.fn();
const nextRmaNumber = vi.fn();
const orderFindById = vi.fn();
const orderFindOneAndUpdate = vi.fn();
const refundFind = vi.fn();
const refundFindOne = vi.fn();
const refundCreate = vi.fn();
const refundFindById = vi.fn();

vi.mock('../inventory.service.js', () => ({
  restock: (...args: unknown[]) => restock(...args),
}));

vi.mock('../customer.service.js', () => ({
  decrementOnRefund: (...args: unknown[]) => decrementOnRefund(...args),
}));

vi.mock('../../models/counter.js', () => ({
  nextRmaNumber: (...args: unknown[]) => nextRmaNumber(...args),
}));

vi.mock('../../models/order.js', () => ({
  Order: {
    findById: (...args: unknown[]) => orderFindById(...args),
    findOneAndUpdate: (...args: unknown[]) => orderFindOneAndUpdate(...args),
  },
}));

vi.mock('../../models/refund.js', () => ({
  Refund: {
    find: (...args: unknown[]) => refundFind(...args),
    findOne: (...args: unknown[]) => refundFindOne(...args),
    create: (...args: unknown[]) => refundCreate(...args),
    findById: (...args: unknown[]) => refundFindById(...args),
  },
}));

import { process } from '../refund.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE = 'store-A';
const ORDER_ID = 'order-1';
const ACTOR = 'operator-1';
const BUYER = 'buyer-1';

/** Build a `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

/** A persisted order item snapshot. */
function item(
  variantId: string,
  unitAmount: number,
  quantity: number,
  options: { discountAmount?: number; locationId?: string } = {},
) {
  const it: Record<string, unknown> = {
    variantId,
    unitPrice: { amount: unitAmount, currency: 'FAIR' },
    quantity,
    lineTotal: { amount: unitAmount * quantity, currency: 'FAIR' },
  };
  if (options.discountAmount !== undefined) {
    it.discountTotal = { amount: options.discountAmount, currency: 'FAIR' };
  }
  if (options.locationId !== undefined) {
    it.locationId = options.locationId;
  }
  return it;
}

/** A mock paid store order doc (lean shape). */
function mockOrder(overrides: Record<string, unknown> = {}) {
  const items = (overrides.items as unknown[]) ?? [item('v1', 1000, 2)];
  const grandTotal =
    (overrides.grandTotal as { amount: number; currency: string }) ?? {
      amount: 2000,
      currency: 'FAIR',
    };
  return {
    _id: ORDER_ID,
    buyerOxyUserId: BUYER,
    sellerType: 'store' as const,
    storeId: STORE,
    status: 'paid' as const,
    items,
    shipping: { method: 'standard', label: 'Standard', cost: { amount: 500, currency: 'FAIR' }, trackingNumber: null },
    totals: { grandTotal },
    payment: { status: 'paid' as const, provider: 'oxy_pay' as const },
    ...overrides,
  };
}

/** Wire `Refund.create` to echo the doc back with a `.toObject()` + timestamps. */
function wireCreateEcho() {
  refundCreate.mockImplementation((doc: Record<string, unknown>) => {
    const created = {
      _id: 'refund-1',
      ...doc,
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      updatedAt: new Date('2026-06-22T00:00:00.000Z'),
    };
    return Promise.resolve({ toObject: () => created });
  });
}

beforeEach(() => {
  restock.mockReset().mockResolvedValue(undefined);
  decrementOnRefund.mockReset().mockResolvedValue(undefined);
  nextRmaNumber.mockReset().mockResolvedValue('RMA-000001');
  orderFindById.mockReset();
  orderFindOneAndUpdate.mockReset().mockResolvedValue(undefined);
  refundFind.mockReset().mockReturnValue(leanOf([]));
  refundFindOne.mockReset().mockReturnValue(leanOf(null));
  refundCreate.mockReset();
  refundFindById.mockReset();
});

describe('refund.service.process', () => {
  it('partial refund: restocks exactly the refunded unit and flips the order to partially_refunded', async () => {
    orderFindById.mockReturnValueOnce(leanOf(mockOrder()));
    wireCreateEcho();

    await process(
      STORE,
      ORDER_ID,
      { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }] },
      ACTOR,
    );

    // Restocked EXACTLY once, for the 1 refunded unit (not the whole 2-qty line).
    expect(restock).toHaveBeenCalledTimes(1);
    expect(restock).toHaveBeenCalledWith('v1', 1, undefined);

    // Created a Refund whose line is qty 1 and status 'refunded'.
    const doc = refundCreate.mock.calls[0][0] as {
      lineItems: { quantity: number }[];
      status: string;
    };
    expect(doc.lineItems[0].quantity).toBe(1);
    expect(doc.status).toBe('refunded');

    // Order flipped to partially_refunded, payment NOT changed.
    expect(orderFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const update = orderFindOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set.status).toBe('partially_refunded');
    expect(update.$set['payment.status']).toBeUndefined();
  });

  it('full refund: flips to refunded + payment.status refunded and decrements the customer once', async () => {
    // Single-line order, qty 1; refunding the 1 unit covers the grand total.
    orderFindById.mockReturnValueOnce(
      leanOf(mockOrder({ items: [item('v1', 2000, 1)], grandTotal: { amount: 2000, currency: 'FAIR' } })),
    );
    wireCreateEcho();

    await process(STORE, ORDER_ID, { lineItems: [{ variantId: 'v1', quantity: 1 }] }, ACTOR);

    const update = orderFindOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set.status).toBe('refunded');
    expect(update.$set['payment.status']).toBe('refunded');

    // Store order with a buyer → decrement the customer's lifetime spend once.
    expect(decrementOnRefund).toHaveBeenCalledTimes(1);
    expect(decrementOnRefund).toHaveBeenCalledWith(STORE, BUYER, { amount: 2000, currency: 'FAIR' });
  });

  it('rejects a cumulative over-refund with CONFLICT (no create, no restock)', async () => {
    orderFindById.mockReturnValueOnce(leanOf(mockOrder({ items: [item('v1', 1000, 2)] })));
    // A prior refund already returned both units of v1 (ordered 2).
    refundFind.mockReturnValueOnce(
      leanOf([
        {
          lineItems: [{ variantId: 'v1', quantity: 2 }],
          totalRefunded: { amount: 2000, currency: 'FAIR' },
        },
      ]),
    );

    await expect(
      process(STORE, ORDER_ID, { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }] }, ACTOR),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT);

    expect(refundCreate).not.toHaveBeenCalled();
    expect(restock).not.toHaveBeenCalled();
  });

  it('refunds the DISCOUNTED net (not gross): 1000x2 with 400 discount → 1-unit refund is 800', async () => {
    // Gross 2000, discount 400 → net 1600; refund 1 of 2 units → 800 (not 1000).
    orderFindById.mockReturnValueOnce(
      leanOf(mockOrder({ items: [item('v1', 1000, 2, { discountAmount: 400 })] })),
    );
    wireCreateEcho();

    await process(STORE, ORDER_ID, { lineItems: [{ variantId: 'v1', quantity: 1 }] }, ACTOR);

    const doc = refundCreate.mock.calls[0][0] as { lineItems: { amount: { amount: number } }[] };
    expect(doc.lineItems[0].amount.amount).toBe(800);
  });

  it('is idempotent: a replayed idempotency key returns the prior refund without re-creating/re-restocking', async () => {
    // The step-1 short-circuit finds the existing refund and returns it.
    refundFindOne.mockReturnValueOnce(
      leanOf({
        _id: 'refund-1',
        orderId: ORDER_ID,
        type: 'refund',
        status: 'refunded',
        lineItems: [{ variantId: 'v1', quantity: 1, amount: { amount: 1000, currency: 'FAIR' }, restock: true }],
        totalRefunded: { amount: 1000, currency: 'FAIR' },
        createdAt: new Date('2026-06-22T00:00:00.000Z'),
        updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      }),
    );

    const result = await process(
      STORE,
      ORDER_ID,
      { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }], idempotencyKey: 'idem-1' },
      ACTOR,
    );

    expect(result.id).toBe('refund-1');
    expect(orderFindById).not.toHaveBeenCalled();
    expect(refundCreate).not.toHaveBeenCalled();
    expect(restock).not.toHaveBeenCalled();
  });
});
