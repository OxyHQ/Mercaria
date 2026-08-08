/**
 * Unit tests for `report.service` (B7 store analytics).
 *
 * The aggregates live in the repositories now, so what this file mocks is those
 * five functions, and what it asserts is what the SERVICE still owns: the shape
 * of the summary (zero-filled status and channel breakdowns, AOV derived from the
 * same filtered set as the revenue), the range/interval/limit clamps, and — the
 * one thing that would silently mix currencies — that the store's settlement
 * currency is the value passed to every money aggregate.
 *
 * What is DELIBERATELY not asserted here any more: the pipeline text. The old
 * tests read `$dateTrunc` and `totals.grandTotal.shop.currency` out of a
 * serialized Mongo pipeline, which checked that a string was present, not that a
 * query was right. The SQL equivalent is exercised against a real server in
 * `commerce.realdb.test.ts`, including the month-boundary bucketing a serialized
 * pipeline could never have shown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const countOrdersByStatus = vi.fn();
const countPaidOrdersBySourceChannel = vi.fn();
const sumPaidRevenue = vi.fn();
const sumPaidRevenueByBucket = vi.fn();
const findTopProducts = vi.fn();
const sumStoreRefunds = vi.fn();
const findStoreRow = vi.fn();

vi.mock('../../db/orders/orderRepository.js', () => ({
  countOrdersByStatus: (...args: unknown[]) => countOrdersByStatus(...args),
  countPaidOrdersBySourceChannel: (...args: unknown[]) =>
    countPaidOrdersBySourceChannel(...args),
  sumPaidRevenue: (...args: unknown[]) => sumPaidRevenue(...args),
  sumPaidRevenueByBucket: (...args: unknown[]) => sumPaidRevenueByBucket(...args),
  findTopProducts: (...args: unknown[]) => findTopProducts(...args),
}));

vi.mock('../../db/orders/refundRepository.js', () => ({
  sumStoreRefunds: (...args: unknown[]) => sumStoreRefunds(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreRow: (...args: unknown[]) => findStoreRow(...args),
}));

import { getSummary, getSalesReport, getTopProducts } from '../report.service.js';

const STORE_ID = '000000000000000000000099';

/** Resolve the store row the reports read their settlement currency from. */
function stubStoreCurrency(currency: string | null): void {
  findStoreRow.mockResolvedValue(
    currency === null ? null : { id: STORE_ID, defaultCurrency: currency },
  );
}

beforeEach(() => {
  countOrdersByStatus.mockReset().mockResolvedValue(new Map());
  countPaidOrdersBySourceChannel.mockReset().mockResolvedValue(new Map());
  sumPaidRevenue.mockReset().mockResolvedValue({ revenue: 0, paidOrderCount: 0 });
  sumPaidRevenueByBucket.mockReset().mockResolvedValue([]);
  findTopProducts.mockReset().mockResolvedValue([]);
  sumStoreRefunds.mockReset().mockResolvedValue(0);
  findStoreRow.mockReset();
});

describe('report.service.getSummary', () => {
  it('computes revenue (Σ paid grandTotal), AOV, byStatus, bySourceChannel and refundTotal', async () => {
    stubStoreCurrency('FAIR');
    // 5 orders total: 3 paid, 1 pending, 1 refunded.
    countOrdersByStatus.mockResolvedValue(
      new Map([
        ['paid', 3],
        ['pending_payment', 1],
        ['refunded', 1],
      ]),
    );
    // Of the paid orders: 2 storefront + 1 pos.
    countPaidOrdersBySourceChannel.mockResolvedValue(
      new Map([
        ['storefront', 2],
        ['pos', 1],
      ]),
    );
    sumPaidRevenue.mockResolvedValue({ revenue: 30_000, paidOrderCount: 3 });
    sumStoreRefunds.mockResolvedValue(5_000);

    const summary = await getSummary(STORE_ID);

    // 3 + 1 + 1 = 5 orders total; 3 paid.
    expect(summary.orderCount).toBe(5);
    expect(summary.paidOrderCount).toBe(3);
    expect(summary.revenue).toEqual({ amount: 30_000, currency: 'FAIR' });
    // AOV = 30_000 / 3 = 10_000, from the SAME filtered set as the revenue.
    expect(summary.averageOrderValue).toEqual({ amount: 10_000, currency: 'FAIR' });
    expect(summary.refundTotal).toEqual({ amount: 5_000, currency: 'FAIR' });
    // byStatus zero-fills every status and reflects the counts.
    expect(summary.byStatus.paid).toBe(3);
    expect(summary.byStatus.pending_payment).toBe(1);
    expect(summary.byStatus.refunded).toBe(1);
    expect(summary.byStatus.delivered).toBe(0);
    // bySourceChannel splits POS vs online.
    expect(summary.bySourceChannel).toEqual({ storefront: 2, pos: 1, draft: 0 });
  });

  it('returns a zero AOV (not NaN/Infinity) when there are no paid orders', async () => {
    stubStoreCurrency('FAIR');
    countOrdersByStatus.mockResolvedValue(new Map([['pending_payment', 2]]));

    const summary = await getSummary(STORE_ID);

    expect(summary.paidOrderCount).toBe(0);
    expect(summary.revenue).toEqual({ amount: 0, currency: 'FAIR' });
    expect(summary.averageOrderValue).toEqual({ amount: 0, currency: 'FAIR' });
    expect(summary.refundTotal).toEqual({ amount: 0, currency: 'FAIR' });
    expect(summary.orderCount).toBe(2);
  });

  it('falls back to FAIR when the store has no default currency', async () => {
    stubStoreCurrency(null);

    const summary = await getSummary(STORE_ID);
    expect(summary.revenue.currency).toBe('FAIR');
  });

  it('scopes every money aggregate to the store shop currency (never mixes currencies)', async () => {
    stubStoreCurrency('EUR');

    await getSummary(STORE_ID);

    // The currency is not decoration on the response — it is the FILTER the
    // aggregate applies, so a store settling in EUR never sums a FAIR order.
    expect(sumPaidRevenue).toHaveBeenCalledWith(STORE_ID, 'EUR');
    expect(sumStoreRefunds).toHaveBeenCalledWith(STORE_ID, 'EUR');
  });
});

describe('report.service.getSalesReport', () => {
  it('maps buckets to ascending points with order counts + revenue', async () => {
    stubStoreCurrency('FAIR');
    const day1 = new Date('2026-06-01T00:00:00.000Z');
    const day2 = new Date('2026-06-02T00:00:00.000Z');
    sumPaidRevenueByBucket.mockResolvedValue([
      { bucket: day1, orders: 2, revenue: 20_000 },
      { bucket: day2, orders: 1, revenue: 12_500 },
    ]);

    const points = await getSalesReport(STORE_ID, { interval: 'day' });

    expect(points).toEqual([
      { bucket: day1.toISOString(), orders: 2, revenue: { amount: 20_000, currency: 'FAIR' } },
      { bucket: day2.toISOString(), orders: 1, revenue: { amount: 12_500, currency: 'FAIR' } },
    ]);
  });

  it('passes the requested interval and the store currency into the aggregate', async () => {
    stubStoreCurrency('EUR');

    await getSalesReport(STORE_ID, { interval: 'week' });

    const [storeId, currency, , interval] = sumPaidRevenueByBucket.mock.calls[0];
    expect(storeId).toBe(STORE_ID);
    expect(currency).toBe('EUR');
    expect(interval).toBe('week');
  });

  it('defaults the interval to day when none is given', async () => {
    stubStoreCurrency('FAIR');

    await getSalesReport(STORE_ID, {});

    expect(sumPaidRevenueByBucket.mock.calls[0][3]).toBe('day');
  });

  it('swaps an inverted range so the window is always ascending', async () => {
    stubStoreCurrency('FAIR');

    await getSalesReport(STORE_ID, {
      from: '2026-06-30T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    });

    const window = sumPaidRevenueByBucket.mock.calls[0][2] as { from: Date; to: Date };
    expect(window.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });
});

describe('report.service.getTopProducts', () => {
  it('maps ranked rows to the TopProduct shape', async () => {
    stubStoreCurrency('FAIR');
    findTopProducts.mockResolvedValue([
      { listingId: 'listing-A', title: 'Mopit Top', unitsSold: 5, revenue: 50_000 },
      { listingId: 'listing-B', title: 'Franny', unitsSold: 2, revenue: 30_000 },
    ]);

    const products = await getTopProducts(STORE_ID, { limit: 10 });

    expect(products).toEqual([
      {
        listingId: 'listing-A',
        title: 'Mopit Top',
        unitsSold: 5,
        revenue: { amount: 50_000, currency: 'FAIR' },
      },
      {
        listingId: 'listing-B',
        title: 'Franny',
        unitsSold: 2,
        revenue: { amount: 30_000, currency: 'FAIR' },
      },
    ]);
  });

  it('clamps the limit into [1, 100] and applies the default of 10 when absent', async () => {
    stubStoreCurrency('FAIR');

    await getTopProducts(STORE_ID, {});
    expect(findTopProducts.mock.calls[0][3]).toBe(10);

    findTopProducts.mockClear();
    await getTopProducts(STORE_ID, { limit: 9999 });
    expect(findTopProducts.mock.calls[0][3]).toBe(100);

    findTopProducts.mockClear();
    await getTopProducts(STORE_ID, { limit: 0 });
    expect(findTopProducts.mock.calls[0][3]).toBe(1);
  });
});
