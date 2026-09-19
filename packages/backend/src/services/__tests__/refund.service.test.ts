/**
 * Unit tests for `refund.service.process` (the B6 refund/return core).
 *
 * The order and refund REPOSITORIES are mocked, as are the inventory `restock`
 * and the customer `decrementOnRefund`. Tests assert the B6 contract: a partial
 * refund restocks exactly the refunded units and flips the order to
 * `partially_refunded` (payment unchanged); a full refund flips it to `refunded`
 * + payment `refunded` and decrements the customer's lifetime spend; a cumulative
 * over-refund is a CONFLICT (no create, no restock); the refunded amount is the
 * DISCOUNTED net (not gross); a replayed idempotency key short-circuits (no
 * re-create, no re-restock).
 *
 * Two things the port moved OUT of this file and into SQL, so they are stubbed
 * rather than folded here: the prior-refunded quantity per variant
 * (`sumRefundedQuantities`) and the cumulative refunded amount
 * (`sumRefundedShopAmount`). Both are `GROUP BY`/`sum` aggregates now, and the
 * arithmetic that decides `partially_refunded` versus `refunded` from them is
 * exercised against a real server in `commerce.realdb.test.ts`.
 *
 * ## What #49 added here, and what it deliberately did NOT
 *
 * `process` now commits the refund and its `payment_refunded` outbox row in one
 * transaction, so the transaction boundary is stubbed. Every order in this file
 * carries NO payment pointer, which makes `refundGoesThroughProvider` false and
 * keeps every case below on the non-provider path — the `manual_pos` and
 * `external` behaviour issue #49 scope 9 says must not change. That is asserted
 * rather than assumed: `enqueuePaymentEvent` is a spy here, and the last case
 * pins that it is never called.
 *
 * The provider path itself is NOT tested here. It moves real money against a
 * real ledger and a mocked `updateOne` accepts an update a server rejects, so it
 * lives in `payments/__tests__/refund.stripe.realdb.test.ts` against a real
 * Postgres and a fake Stripe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const restock = vi.fn();
const decrementOnRefund = vi.fn();
const nextRmaNumber = vi.fn();
const findOrderById = vi.fn();
const setOrderStatus = vi.fn();
const insertRefund = vi.fn();
const findRefundById = vi.fn();
const findRefundForStoreOrderReplay = vi.fn();
const sumRefundedQuantities = vi.fn();
const sumRefundedShopAmount = vi.fn();
const enqueuePaymentEvent = vi.fn();

/**
 * The transaction boundary, and nothing else about Postgres.
 *
 * `process` opens ONE transaction so the refund row and its outbox row commit
 * together. The handle is passed straight through to the mocked repositories,
 * which ignore it — so what this stub preserves is the SHAPE (a callback that
 * runs and whose value is returned), which is the only part the service depends
 * on when its writes are mocked.
 */
vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({
    transaction: async (run: (tx: unknown) => Promise<unknown>) => await run({}),
  }),
}));

vi.mock('../payments/payment-outbox.service.js', () => ({
  enqueuePaymentEvent: (...args: unknown[]) => enqueuePaymentEvent(...args),
  paymentRefundedEventId: (refundId: string) => `payment:payment_refunded:${refundId}`,
}));

// The refund's provider path is a real-database concern; here it is stubbed to
// the answer every fixture in this file produces — no payment pointer, no rail.
vi.mock('../payments/refund-execution.service.js', () => ({
  refundGoesThroughProvider: () => false,
}));

vi.mock('../inventory.service.js', () => ({
  restock: (...args: unknown[]) => restock(...args),
}));

vi.mock('../customer.service.js', () => ({
  decrementOnRefund: (...args: unknown[]) => decrementOnRefund(...args),
}));

vi.mock('../../db/orders/orderRepository.js', () => ({
  findOrderById: (...args: unknown[]) => findOrderById(...args),
  setOrderStatus: (...args: unknown[]) => setOrderStatus(...args),
}));

vi.mock('../../db/orders/refundRepository.js', () => ({
  insertRefund: (...args: unknown[]) => insertRefund(...args),
  findRefundById: (...args: unknown[]) => findRefundById(...args),
  findRefundForStoreOrderReplay: (...args: unknown[]) => findRefundForStoreOrderReplay(...args),
  findRefundInStore: vi.fn(),
  findRefundsForOrderInStore: vi.fn(),
  nextRmaNumber: (...args: unknown[]) => nextRmaNumber(...args),
  sumRefundedQuantities: (...args: unknown[]) => sumRefundedQuantities(...args),
  sumRefundedShopAmount: (...args: unknown[]) => sumRefundedShopAmount(...args),
}));

import { process } from '../refund.service.js';
import type { OrderItemRecord, OrderRecord } from '../../db/orders/orderRepository.js';
import type { NewRefund, RefundRecord } from '../../db/orders/refundRepository.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE = 'store-A';
const ORDER_ID = 'order-1';
const ACTOR = 'operator-1';
const BUYER = 'buyer-1';

/**
 * A persisted order line, as flat columns.
 *
 * `discountTotal*` is NULL on an un-discounted line — all four columns absent
 * together, which is what `order_items_discount_total_complete_check` enforces —
 * and the refund's net-amount arithmetic reads exactly that.
 */
function item(
  variantId: string,
  unitAmount: number,
  quantity: number,
  options: { discountAmount?: number; locationId?: string } = {},
): OrderItemRecord {
  const discount = options.discountAmount ?? null;
  return {
    variantId,
    quantity,
    unitPriceShopAmount: unitAmount,
    unitPriceShopCurrency: 'FAIR',
    unitPricePresentmentAmount: unitAmount,
    unitPricePresentmentCurrency: 'FAIR',
    lineTotalShopAmount: unitAmount * quantity,
    lineTotalShopCurrency: 'FAIR',
    lineTotalPresentmentAmount: unitAmount * quantity,
    lineTotalPresentmentCurrency: 'FAIR',
    discountTotalShopAmount: discount,
    discountTotalShopCurrency: discount === null ? null : 'FAIR',
    discountTotalPresentmentAmount: discount,
    discountTotalPresentmentCurrency: discount === null ? null : 'FAIR',
    locationId: options.locationId ?? null,
  } as unknown as OrderItemRecord;
}

/** A paid store order record with flat totals and shipping columns. */
function mockOrder(
  overrides: { items?: OrderItemRecord[]; grandTotalAmount?: number } = {},
): OrderRecord {
  const grandTotal = overrides.grandTotalAmount ?? 2000;
  return {
    id: ORDER_ID,
    buyerOxyUserId: BUYER,
    sellerType: 'store',
    storeId: STORE,
    sellerOxyUserId: null,
    status: 'paid',
    paymentStatus: 'paid',
    items: overrides.items ?? [item('v1', 1000, 2)],
    shippingCostShopAmount: 500,
    shippingCostShopCurrency: 'FAIR',
    shippingCostPresentmentAmount: 500,
    shippingCostPresentmentCurrency: 'FAIR',
    totalsGrandTotalShopAmount: grandTotal,
    totalsGrandTotalShopCurrency: 'FAIR',
    totalsGrandTotalPresentmentAmount: grandTotal,
    totalsGrandTotalPresentmentCurrency: 'FAIR',
  } as unknown as OrderRecord;
}

/** Echo the inserted refund back as the row the repository would return. */
function wireInsertEcho(): void {
  insertRefund.mockImplementation((input: NewRefund) =>
    Promise.resolve({
      id: 'refund-1',
      orderId: input.orderId,
      storeId: input.storeId ?? null,
      sellerOxyUserId: input.sellerOxyUserId ?? null,
      type: input.type,
      status: input.status,
      reason: input.reason ?? null,
      refundShippingShopAmount: input.refundShipping?.shop.amount ?? null,
      refundShippingShopCurrency: input.refundShipping?.shop.currency ?? null,
      refundShippingPresentmentAmount: input.refundShipping?.presentment.amount ?? null,
      refundShippingPresentmentCurrency: input.refundShipping?.presentment.currency ?? null,
      totalRefundedShopAmount: input.totalRefunded.shop.amount,
      totalRefundedShopCurrency: input.totalRefunded.shop.currency,
      totalRefundedPresentmentAmount: input.totalRefunded.presentment.amount,
      totalRefundedPresentmentCurrency: input.totalRefunded.presentment.currency,
      restockedAt: input.restockedAt ?? null,
      processedByOxyUserId: input.processedByOxyUserId ?? null,
      rmaNumber: input.rmaNumber ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      lineItems: input.lineItems.map((line, index) => ({
        id: `line-${String(index)}`,
        refundId: 'refund-1',
        variantId: line.variantId,
        quantity: line.quantity,
        amountShopAmount: line.amount.shop.amount,
        amountShopCurrency: line.amount.shop.currency,
        amountPresentmentAmount: line.amount.presentment.amount,
        amountPresentmentCurrency: line.amount.presentment.currency,
        restock: line.restock,
        locationId: line.locationId ?? null,
        position: index,
      })),
    } as unknown as RefundRecord),
  );
}

beforeEach(() => {
  restock.mockReset().mockResolvedValue(undefined);
  decrementOnRefund.mockReset().mockResolvedValue(undefined);
  nextRmaNumber.mockReset().mockResolvedValue('RMA-000001');
  findOrderById.mockReset();
  setOrderStatus.mockReset().mockResolvedValue(undefined);
  insertRefund.mockReset();
  findRefundById.mockReset().mockResolvedValue(null);
  findRefundForStoreOrderReplay.mockReset().mockResolvedValue(null);
  enqueuePaymentEvent.mockReset().mockResolvedValue(true);
  // No prior refunds by default.
  sumRefundedQuantities.mockReset().mockResolvedValue(new Map<string, number>());
  sumRefundedShopAmount.mockReset().mockResolvedValue(0);
});

describe('refund.service.process', () => {
  it('partial refund: restocks exactly the refunded unit and flips the order to partially_refunded', async () => {
    findOrderById.mockResolvedValueOnce(mockOrder());
    wireInsertEcho();
    // This refund returns 1000 of a 2000 grand total, so some remains refundable.
    sumRefundedShopAmount.mockResolvedValue(1000);

    await process(
      STORE,
      ORDER_ID,
      { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }] },
      ACTOR,
    );

    // Restocked EXACTLY once, for the 1 refunded unit (not the whole 2-qty line).
    expect(restock).toHaveBeenCalledTimes(1);
    expect(restock).toHaveBeenCalledWith('v1', 1, undefined);

    // Created a refund whose line is qty 1 and status 'refunded'.
    const input = insertRefund.mock.calls[0][0] as NewRefund;
    expect(input.lineItems[0].quantity).toBe(1);
    expect(input.status).toBe('refunded');

    // Order flipped to partially_refunded, payment NOT changed.
    expect(setOrderStatus).toHaveBeenCalledTimes(1);
    const [, next, patch] = setOrderStatus.mock.calls[0] as [
      string,
      string,
      { paymentStatus?: string },
    ];
    expect(next).toBe('partially_refunded');
    expect(patch.paymentStatus).toBeUndefined();
  });

  it('full refund: flips to refunded + payment refunded and decrements the customer once', async () => {
    // Single-line order, qty 1; refunding the 1 unit covers the grand total.
    findOrderById.mockResolvedValueOnce(
      mockOrder({ items: [item('v1', 2000, 1)], grandTotalAmount: 2000 }),
    );
    wireInsertEcho();
    sumRefundedShopAmount.mockResolvedValue(2000);

    await process(STORE, ORDER_ID, { lineItems: [{ variantId: 'v1', quantity: 1 }] }, ACTOR);

    const [, next, patch] = setOrderStatus.mock.calls[0] as [
      string,
      string,
      { paymentStatus?: string },
    ];
    expect(next).toBe('refunded');
    expect(patch.paymentStatus).toBe('refunded');

    // Store order with a buyer → decrement the customer's lifetime spend once.
    expect(decrementOnRefund).toHaveBeenCalledTimes(1);
    expect(decrementOnRefund).toHaveBeenCalledWith(STORE, BUYER, {
      amount: 2000,
      currency: 'FAIR',
    });
  });

  it('rejects a cumulative over-refund with CONFLICT (no create, no restock)', async () => {
    findOrderById.mockResolvedValueOnce(mockOrder({ items: [item('v1', 1000, 2)] }));
    // A prior refund already returned both units of v1 (ordered 2).
    sumRefundedQuantities.mockResolvedValue(new Map([['v1', 2]]));

    await expect(
      process(
        STORE,
        ORDER_ID,
        { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }] },
        ACTOR,
      ),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT);

    expect(insertRefund).not.toHaveBeenCalled();
    expect(restock).not.toHaveBeenCalled();
  });

  it('refunds the DISCOUNTED net (not gross): 1000x2 with 400 discount → 1-unit refund is 800', async () => {
    // Gross 2000, discount 400 → net 1600; refund 1 of 2 units → 800 (not 1000).
    findOrderById.mockResolvedValueOnce(
      mockOrder({ items: [item('v1', 1000, 2, { discountAmount: 400 })] }),
    );
    wireInsertEcho();

    await process(STORE, ORDER_ID, { lineItems: [{ variantId: 'v1', quantity: 1 }] }, ACTOR);

    const input = insertRefund.mock.calls[0][0] as NewRefund;
    expect(input.lineItems[0].amount.shop.amount).toBe(800);
  });

  it('is idempotent: a replayed idempotency key returns the prior refund without re-creating/re-restocking', async () => {
    // The step-1 short-circuit finds the existing refund and returns it.
    findRefundForStoreOrderReplay.mockResolvedValueOnce({
      id: 'refund-1',
      orderId: ORDER_ID,
      type: 'refund',
      status: 'refunded',
      totalRefundedShopAmount: 1000,
      totalRefundedShopCurrency: 'FAIR',
      totalRefundedPresentmentAmount: 1000,
      totalRefundedPresentmentCurrency: 'FAIR',
      refundShippingShopAmount: null,
      refundShippingShopCurrency: null,
      refundShippingPresentmentAmount: null,
      refundShippingPresentmentCurrency: null,
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      lineItems: [],
    } as unknown as RefundRecord);

    const result = await process(
      STORE,
      ORDER_ID,
      { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }], idempotencyKey: 'idem-1' },
      ACTOR,
    );

    expect(result.id).toBe('refund-1');
    expect(findRefundForStoreOrderReplay).toHaveBeenCalledWith(STORE, ORDER_ID, 'idem-1');
    expect(findOrderById).not.toHaveBeenCalled();
    expect(insertRefund).not.toHaveBeenCalled();
    expect(restock).not.toHaveBeenCalled();
  });

  it('refuses an amount above the execution ceiling before inventory or writes', async () => {
    findOrderById.mockResolvedValueOnce(mockOrder());

    await expect(
      process(
        STORE,
        ORDER_ID,
        { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }] },
        ACTOR,
        { maximumPresentmentAmountMinor: 999 },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );

    expect(restock).not.toHaveBeenCalled();
    expect(nextRmaNumber).not.toHaveBeenCalled();
    expect(insertRefund).not.toHaveBeenCalled();
    expect(enqueuePaymentEvent).not.toHaveBeenCalled();
  });

  it('applies the execution ceiling to an idempotent replay too', async () => {
    findRefundForStoreOrderReplay.mockResolvedValueOnce({
      id: 'refund-1',
      orderId: ORDER_ID,
      type: 'refund',
      status: 'refunded',
      totalRefundedShopAmount: 1000,
      totalRefundedShopCurrency: 'FAIR',
      totalRefundedPresentmentAmount: 1000,
      totalRefundedPresentmentCurrency: 'FAIR',
      refundShippingShopAmount: null,
      refundShippingShopCurrency: null,
      refundShippingPresentmentAmount: null,
      refundShippingPresentmentCurrency: null,
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      lineItems: [],
    } as unknown as RefundRecord);

    await expect(
      process(
        STORE,
        ORDER_ID,
        { lineItems: [{ variantId: 'v1', quantity: 1 }], idempotencyKey: 'idem-1' },
        ACTOR,
        { maximumPresentmentAmountMinor: 999 },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );

    expect(findOrderById).not.toHaveBeenCalled();
    expect(insertRefund).not.toHaveBeenCalled();
    expect(restock).not.toHaveBeenCalled();
  });

  /**
   * Issue #49, scope 9: a payment Mercaria RECORDED rather than made is refunded
   * wherever it was captured — cash out of a register, or on the platform that
   * imported the order — so no provider operation is created for it.
   *
   * Asserted on BOTH sides, because either alone passes for the wrong reason: no
   * outbox row is written (nothing will try to move money), and the persisted
   * refund carries no `providerOperation` (the row does not claim a rail is
   * involved). Every fixture in this file is such an order, so this pins the
   * property the whole file's silence depends on.
   */
  it('creates NO provider operation for an order with no payment rail behind it', async () => {
    findOrderById.mockResolvedValueOnce(mockOrder());
    wireInsertEcho();
    sumRefundedShopAmount.mockResolvedValue(1000);

    await process(
      STORE,
      ORDER_ID,
      { lineItems: [{ variantId: 'v1', quantity: 1, restock: true }] },
      ACTOR,
    );

    expect(enqueuePaymentEvent).not.toHaveBeenCalled();
    const written = insertRefund.mock.calls[0]?.[0] as NewRefund;
    expect(written.providerOperation).toBeUndefined();
  });
});
