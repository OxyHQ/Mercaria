/**
 * Unit tests for `order.service.transition`.
 *
 * The order, refund, seller-profile and store REPOSITORIES are mocked, as are
 * the inventory effects (`commit`/`release`/`restock`) and the order-hydration
 * module. Tests assert the F4 lifecycle contract: every LEGAL transition
 * succeeds; every ILLEGAL transition is a CONFLICT; unpaid cancel RELEASES the
 * reservation; pay COMMITS + bumps salesCount; refund of a paid order RESTOCKS
 * (not release/commit).
 *
 * The CAS is what makes the side-effects run at most once, and `transitionOrderStatus`
 * standing in for it here is what lets a LOST race be simulated: the mock returns
 * `null`, which is the repository's contract for "the guard refused" and never
 * "nothing to do". The SQL that actually enforces it is exercised against a real
 * server in `commerce.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const commit = vi.fn();
const release = vi.fn();
const restock = vi.fn();
const adjustSellerSalesCount = vi.fn();
const adjustStoreSalesCount = vi.fn();
const enqueueOrderEvent = vi.fn();
const enqueueFulfillmentPush = vi.fn();
const transitionOrderStatus = vi.fn();
const upsertCustomerOnPaid = vi.fn();
const sumRestockedQuantities = vi.fn();

vi.mock('../inventory.service.js', () => ({
  commit: (...args: unknown[]) => commit(...args),
  release: (...args: unknown[]) => release(...args),
  restock: (...args: unknown[]) => restock(...args),
}));

vi.mock('../customer.service.js', () => ({
  upsertOnPaid: (...args: unknown[]) => upsertCustomerOnPaid(...args),
}));

vi.mock('../../db/orders/orderRepository.js', () => ({
  transitionOrderStatus: (...args: unknown[]) => transitionOrderStatus(...args),
  findOrderMatching: vi.fn(),
  findOrdersPage: vi.fn(),
  countOrdersByStatus: vi.fn(),
  sumPaidRevenue: vi.fn(),
}));

vi.mock('../../db/orders/refundRepository.js', () => ({
  sumRestockedQuantities: (...args: unknown[]) => sumRestockedQuantities(...args),
}));

vi.mock('../../db/buyers/sellerProfileRepository.js', () => ({
  adjustSellerSalesCount: (...args: unknown[]) => adjustSellerSalesCount(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  adjustStoreSalesCount: (...args: unknown[]) => adjustStoreSalesCount(...args),
  findStoreRow: vi.fn(),
}));

vi.mock('../../db/catalog/variantRepository.js', () => ({
  countLowStockVariantsForStore: vi.fn(),
}));

vi.mock('../order-hydration.service.js', () => ({
  hydrateOrders: vi.fn().mockResolvedValue([]),
  summarizeOrders: vi.fn().mockResolvedValue([]),
}));

/**
 * A lifecycle transition must never consult FX. Every export throws, so if the
 * service ever reaches for a rate again the transition fails loudly instead of
 * acquiring a hidden dependency on a currency being quotable.
 */
vi.mock('../fx.service.js', () => {
  const unavailable = (): never => {
    throw new Error('order.service must not consult FX during a lifecycle transition');
  };
  return { getRates: unavailable, convert: unavailable, pairRate: unavailable, toDualMoney: unavailable };
});

vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: (...args: unknown[]) => enqueueOrderEvent(...args),
  enqueueFulfillmentPush: (...args: unknown[]) => enqueueFulfillmentPush(...args),
}));

import { transition } from '../order.service.js';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import type { OrderStatus } from '@mercaria/shared-types';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/**
 * An order RECORD as the repository returns it — flat columns, and `items` with
 * an explicit `locationId: null` because that is what the column holds for a
 * storefront line. The service passes `?? undefined` down to the inventory
 * effects, which is the distinction the `expect(...).toHaveBeenCalledWith(…,
 * undefined)` assertions below are checking.
 *
 * The cast is confined to this builder: every column the service reads is
 * spelled out, and the ones it never touches are absent rather than filled in.
 */
function mockOrder(
  status: OrderStatus,
  options: {
    paymentStatus?: 'unpaid' | 'paid';
    sellerType?: 'user' | 'store';
    grandTotalCurrency?: string;
    grandTotalAmount?: number;
    sourceExternalId?: string;
  } = {},
): OrderRecord {
  const gtAmount = options.grandTotalAmount ?? 9000;
  const gtCurrency = options.grandTotalCurrency ?? 'FAIR';
  return {
    id: 'order-1',
    status,
    buyerOxyUserId: 'buyer-1',
    sellerType: options.sellerType ?? 'user',
    sellerOxyUserId: options.sellerType === 'store' ? null : 'seller-X',
    storeId: options.sellerType === 'store' ? 'store-A' : null,
    // shop == presentment for these fixtures. The paid transition relates the
    // store customer in the SHOP side and converts nothing.
    totalsGrandTotalShopAmount: gtAmount,
    totalsGrandTotalShopCurrency: gtCurrency,
    totalsGrandTotalPresentmentAmount: gtAmount,
    totalsGrandTotalPresentmentCurrency: gtCurrency,
    paymentStatus: options.paymentStatus ?? 'unpaid',
    paymentProvider: 'oxy_pay',
    moderationHold: null,
    sourceExternalId: options.sourceExternalId ?? null,
    statusHistory: [],
    appliedDiscounts: [],
    taxLines: [],
    items: [
      { variantId: 'v1', quantity: 2, locationId: null },
      { variantId: 'v2', quantity: 1, locationId: null },
    ],
  } as unknown as OrderRecord;
}

beforeEach(() => {
  commit.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  restock.mockReset().mockResolvedValue(undefined);
  adjustSellerSalesCount.mockReset().mockResolvedValue(undefined);
  adjustStoreSalesCount.mockReset().mockResolvedValue(undefined);
  enqueueOrderEvent.mockReset().mockResolvedValue(undefined);
  enqueueFulfillmentPush.mockReset().mockResolvedValue(undefined);
  upsertCustomerOnPaid.mockReset().mockResolvedValue(undefined);
  // No prior refunds by default → transition restocks each line at its full qty.
  sumRestockedQuantities.mockReset().mockResolvedValue(new Map<string, number>());
  // Default: the atomic CAS WINS — resolve the persisted row plus the appended
  // event. Tests that simulate a LOST race resolve `null` instead, which is the
  // repository's contract for "the guard refused".
  transitionOrderStatus
    .mockReset()
    .mockImplementation((orderId: string, _expected: OrderStatus, next: OrderStatus) =>
      Promise.resolve({
        order: { id: orderId, status: next },
        event: { id: 'event-1', orderId, status: next, at: new Date() },
      }),
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
      const order = mockOrder(from, { paymentStatus });
      const moved = await transition(order, to, { actorOxyUserId: 'actor-1' });
      // The RETURNED record is what the caller hydrates, and it carries the
      // persisted status — the passed-in record is not mutated any more.
      expect(moved.status).toBe(to);
      expect(transitionOrderStatus).toHaveBeenCalledTimes(1);
      // The CAS is guarded on the status the order was AT, which is the whole
      // reason a concurrent second call cannot also run the side-effects.
      expect(transitionOrderStatus.mock.calls[0][1]).toBe(from);
      expect(transitionOrderStatus.mock.calls[0][2]).toBe(to);
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
      const order = mockOrder(from, { paymentStatus: 'paid' });
      await expect(transition(order, to, {})).rejects.toSatisfy(
        (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
      );
      // Illegal transitions reject on the in-memory table check, before the CAS.
      expect(transitionOrderStatus).not.toHaveBeenCalled();
    });
  }
});

describe('order.service.transition — connector fulfillment push', () => {
  it('enqueues a fulfillment push when a CONNECTOR order (with source) ships', async () => {
    // Provenance is `source_external_id` being non-NULL now, not a nested
    // `source` object — the three source columns move together on insert.
    const order = mockOrder('processing', {
      paymentStatus: 'paid',
      sourceExternalId: 'shp-1001',
    });

    await transition(order, 'shipped', { actorOxyUserId: 'actor-1' });

    expect(enqueueFulfillmentPush).toHaveBeenCalledWith({ orderId: 'order-1' });
  });

  it('does NOT enqueue a fulfillment push for a native order (no source)', async () => {
    const order = mockOrder('processing', { paymentStatus: 'paid' });
    await transition(order, 'shipped', { actorOxyUserId: 'actor-1' });
    expect(enqueueFulfillmentPush).not.toHaveBeenCalled();
  });

  it('does NOT enqueue a fulfillment push on a non-ship transition of a connector order', async () => {
    const order = mockOrder('pending_payment', { sourceExternalId: 'shp-1001' });
    await transition(order, 'paid', { actorOxyUserId: 'actor-1' });
    expect(enqueueFulfillmentPush).not.toHaveBeenCalled();
  });
});

describe('order.service.transition — inventory effects', () => {
  it('cancel from pending_payment (unpaid) releases each line', async () => {
    const order = mockOrder('pending_payment', { paymentStatus: 'unpaid' });
    await transition(order, 'cancelled', { actorOxyUserId: 'actor-1' });
    expect(release).toHaveBeenCalledTimes(2);
    // Items carry no locationId → the 3rd arg is undefined (default location).
    expect(release).toHaveBeenCalledWith('v1', 2, undefined);
    expect(release).toHaveBeenCalledWith('v2', 1, undefined);
    expect(restock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('paid (user seller) commits each line, bumps salesCount, marks payment paid', async () => {
    const order = mockOrder('pending_payment', { sellerType: 'user' });
    await transition(order, 'paid', { actorOxyUserId: 'actor-1' });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith('v1', 2, undefined);
    expect(commit).toHaveBeenCalledWith('v2', 1, undefined);
    expect(adjustSellerSalesCount).toHaveBeenCalledWith('seller-X', 1);
    // The payment columns travel in the CAS patch rather than being assigned to
    // an in-memory document, so that is where they are asserted.
    const patch = transitionOrderStatus.mock.calls[0][3] as {
      paymentStatus?: string;
      paymentPaidAt?: Date;
    };
    expect(patch.paymentStatus).toBe('paid');
    expect(patch.paymentPaidAt).toBeInstanceOf(Date);
  });

  it('paid (store seller) bumps store salesCount and relates the customer via upsertOnPaid exactly once', async () => {
    const order = mockOrder('pending_payment', { sellerType: 'store' });
    await transition(order, 'paid', { actorOxyUserId: 'actor-1' });
    expect(adjustStoreSalesCount).toHaveBeenCalledWith('store-A', 1);
    expect(upsertCustomerOnPaid).toHaveBeenCalledTimes(1);
    expect(upsertCustomerOnPaid).toHaveBeenCalledWith('store-A', 'buyer-1', {
      amount: 9000,
      currency: 'FAIR',
    });
    // P2P seller-profile path is NOT taken for a store order.
    expect(adjustSellerSalesCount).not.toHaveBeenCalled();
  });

  it('refund of a paid order restocks each line (not release/commit) and marks payment refunded', async () => {
    const order = mockOrder('paid', { paymentStatus: 'paid' });
    await transition(order, 'refunded', { actorOxyUserId: 'actor-1' });
    expect(restock).toHaveBeenCalledTimes(2);
    expect(restock).toHaveBeenCalledWith('v1', 2, undefined);
    expect(restock).toHaveBeenCalledWith('v2', 1, undefined);
    expect(release).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    const patch = transitionOrderStatus.mock.calls[0][3] as { paymentStatus?: string };
    expect(patch.paymentStatus).toBe('refunded');
  });

  it('does NOT double-restock units a prior refund already restocked', async () => {
    // A prior Refund restocked the full 2 units of v1 (v2 untouched). A later full
    // refund/cancel through transition must restock only the REMAINING units:
    // v1 remaining 0 → NOT called; v2 remaining 1 → restock('v2', 1, undefined).
    // The repository sums the RESTOCKED quantities in SQL, so the fixture is the
    // map it returns rather than a list of refund documents to fold in memory.
    sumRestockedQuantities.mockResolvedValue(new Map([['v1', 2]]));
    const order = mockOrder('paid', { paymentStatus: 'paid' });
    await transition(order, 'refunded', { actorOxyUserId: 'actor-1' });
    // Total restock calls across refund(2)+transition(1) units === 2 === ordered.
    expect(restock).toHaveBeenCalledTimes(1);
    expect(restock).toHaveBeenCalledWith('v2', 1, undefined);
    expect(restock).not.toHaveBeenCalledWith('v1', 0, undefined);
    expect(release).not.toHaveBeenCalled();
  });
});

describe('order.service.transition — paid converts NO currency', () => {
  /**
   * The whole `fx.service` module is mocked to throw. `order.service` does not
   * import it, so these calls are inert TODAY — which is the point: the mock is
   * a tripwire that fires the moment a currency conversion is reintroduced at
   * the `paid` seam, and it fails the transition rather than passing quietly.
   * Verified by temporarily calling `getRates` in `transition`: these two cases
   * go red, and go green again when it is removed.
   */
  it('moves a native EUR order to paid with NO exchange rate obtainable', async () => {
    const order = mockOrder('pending_payment', {
      sellerType: 'user',
      grandTotalCurrency: 'EUR',
      grandTotalAmount: 4500,
    });

    const moved = await transition(order, 'paid', { actorOxyUserId: 'actor-1' });

    expect(moved.status).toBe('paid');
    // The sale still finalizes: stock committed, seller credited.
    expect(commit).toHaveBeenCalledTimes(2);
    expect(adjustSellerSalesCount).toHaveBeenCalledTimes(1);
  });

  it('patches ONLY the payment columns — no settlement of any kind', async () => {
    const order = mockOrder('pending_payment', { sellerType: 'user' });
    await transition(order, 'paid', { actorOxyUserId: 'actor-1' });

    // The patch is the WHOLE set of columns the move writes besides `status`
    // (which `transitionOrderStatus` takes as its own argument), so an exact key
    // match is what proves no settlement column is written — asserting
    // `patch.settlement` is undefined would also pass if it were renamed.
    const patch = transitionOrderStatus.mock.calls[0][3] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(['paymentPaidAt', 'paymentStatus']);
  });
});

describe('order.service.transition — atomic CAS (side effects run at most once)', () => {
  it('a concurrent double-cancel releases the reservation EXACTLY once (the loser CONFLICTs, no second release)', async () => {
    // First CAS WINS (a result), second CAS LOSES (null — the row had already
    // moved off `pending_payment`, so `WHERE status = 'pending_payment'` matched
    // nothing).
    transitionOrderStatus
      .mockReset()
      .mockResolvedValueOnce({
        order: { id: 'order-1', status: 'cancelled' },
        event: { id: 'event-1', orderId: 'order-1', status: 'cancelled', at: new Date() },
      })
      .mockResolvedValueOnce(null);

    const order1 = mockOrder('pending_payment', { paymentStatus: 'unpaid' });
    const order2 = mockOrder('pending_payment', { paymentStatus: 'unpaid' });

    // Winner: releases the 2 lines once.
    await transition(order1, 'cancelled', {});
    // Loser: CAS matched nothing → CONFLICT, no inventory effect.
    await expect(transition(order2, 'cancelled', {})).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    // Released ONCE for the 2 lines (v1, v2) — not 4 (which a double-run would produce).
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith('v1', 2, undefined);
    expect(release).toHaveBeenCalledWith('v2', 1, undefined);
    expect(transitionOrderStatus).toHaveBeenCalledTimes(2);
  });
});
