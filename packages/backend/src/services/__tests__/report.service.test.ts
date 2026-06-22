/**
 * Unit tests for `report.service` (B7 store analytics).
 *
 * `mongodb-memory-server` is not available, so the Order/Refund/Store models are
 * mocked. The reports run Mongo aggregation pipelines; each test stubs
 * `Order.aggregate`/`Refund.aggregate` to return the rows a real `$group`/
 * `$dateTrunc` would produce for a KNOWN set of paid orders, then asserts the
 * service shapes them correctly: summary (revenue = Σ paid grandTotal, AOV,
 * byStatus, bySourceChannel, refundTotal), sales time-buckets (grouping +
 * ordering), and top-products (units/revenue ranking). The aggregation pipeline
 * itself is exercised end-to-end by the seed + curl checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const orderAggregate = vi.fn();
const refundAggregate = vi.fn();
const storeFindById = vi.fn();

vi.mock('../../models/order.js', () => ({
  Order: { aggregate: (...args: unknown[]) => orderAggregate(...args) },
}));

vi.mock('../../models/refund.js', () => ({
  Refund: { aggregate: (...args: unknown[]) => refundAggregate(...args) },
}));

vi.mock('../../models/store.js', () => ({
  Store: { findById: (...args: unknown[]) => storeFindById(...args) },
}));

import { getSummary, getSalesReport, getTopProducts } from '../report.service.js';

const STORE_ID = '000000000000000000000099';

/** Stub `Store.findById(...).select(...).lean()` to resolve a default currency. */
function stubStoreCurrency(currency: string | null): void {
  storeFindById.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve(currency === null ? null : { defaultCurrency: currency }),
    }),
  });
}

/** True iff the aggregation pipeline contains a stage whose key set includes `stage`. */
function hasStage(pipeline: unknown, stage: string): boolean {
  return (
    Array.isArray(pipeline) &&
    pipeline.some((s) => typeof s === 'object' && s !== null && stage in s)
  );
}

beforeEach(() => {
  orderAggregate.mockReset();
  refundAggregate.mockReset();
  storeFindById.mockReset();
});

describe('report.service.getSummary', () => {
  it('computes revenue (Σ paid grandTotal), AOV, byStatus, bySourceChannel and refundTotal', async () => {
    stubStoreCurrency('FAIR');

    // The summary issues 4 aggregations: [status-by-all], [channel-of-paid],
    // [revenue/count of paid], and Refund [total]. Route by pipeline shape.
    orderAggregate.mockImplementation((pipeline: unknown[]) => {
      const group = pipeline.find(
        (s): s is { $group: Record<string, unknown> } =>
          typeof s === 'object' && s !== null && '$group' in s,
      );
      const groupId = group?.$group._id;
      if (groupId === '$status') {
        // 5 orders total: 3 paid, 1 pending, 1 refunded.
        return Promise.resolve([
          { _id: 'paid', n: 3 },
          { _id: 'pending_payment', n: 1 },
          { _id: 'refunded', n: 1 },
        ]);
      }
      if (groupId === '$sourceChannel') {
        // Of the paid orders: 2 storefront + 1 pos.
        return Promise.resolve([
          { _id: 'storefront', n: 2 },
          { _id: 'pos', n: 1 },
        ]);
      }
      // Revenue/count of paid orders: 3 orders summing to 30_000 minor units.
      return Promise.resolve([{ _id: null, count: 3, revenue: 30_000 }]);
    });
    // Refund total across the store: 5_000 minor units refunded.
    refundAggregate.mockResolvedValue([{ _id: null, total: 5_000 }]);

    const summary = await getSummary(STORE_ID);

    // 3 + 1 + 1 = 5 orders total; 3 paid.
    expect(summary.orderCount).toBe(5);
    expect(summary.paidOrderCount).toBe(3);
    // Revenue = Σ paid grandTotal.
    expect(summary.revenue).toEqual({ amount: 30_000, currency: 'FAIR' });
    // AOV = 30_000 / 3 = 10_000.
    expect(summary.averageOrderValue).toEqual({ amount: 10_000, currency: 'FAIR' });
    expect(summary.refundTotal).toEqual({ amount: 5_000, currency: 'FAIR' });
    // byStatus zero-fills every status and reflects the groups.
    expect(summary.byStatus.paid).toBe(3);
    expect(summary.byStatus.pending_payment).toBe(1);
    expect(summary.byStatus.refunded).toBe(1);
    expect(summary.byStatus.delivered).toBe(0);
    // bySourceChannel splits POS vs online.
    expect(summary.bySourceChannel).toEqual({ storefront: 2, pos: 1, draft: 0 });
  });

  it('returns a zero AOV (not NaN/Infinity) when there are no paid orders', async () => {
    stubStoreCurrency('FAIR');
    orderAggregate.mockImplementation((pipeline: unknown[]) => {
      const group = pipeline.find(
        (s): s is { $group: Record<string, unknown> } =>
          typeof s === 'object' && s !== null && '$group' in s,
      );
      const groupId = group?.$group._id;
      if (groupId === '$status') return Promise.resolve([{ _id: 'pending_payment', n: 2 }]);
      if (groupId === '$sourceChannel') return Promise.resolve([]);
      return Promise.resolve([]); // no paid orders
    });
    refundAggregate.mockResolvedValue([]);

    const summary = await getSummary(STORE_ID);

    expect(summary.paidOrderCount).toBe(0);
    expect(summary.revenue).toEqual({ amount: 0, currency: 'FAIR' });
    expect(summary.averageOrderValue).toEqual({ amount: 0, currency: 'FAIR' });
    expect(summary.refundTotal).toEqual({ amount: 0, currency: 'FAIR' });
    expect(summary.orderCount).toBe(2);
  });

  it('falls back to FAIR when the store has no default currency', async () => {
    stubStoreCurrency(null);
    orderAggregate.mockResolvedValue([]);
    refundAggregate.mockResolvedValue([]);

    const summary = await getSummary(STORE_ID);
    expect(summary.revenue.currency).toBe('FAIR');
  });
});

describe('report.service.getSalesReport', () => {
  it('maps $dateTrunc buckets to ascending points with order counts + revenue', async () => {
    stubStoreCurrency('FAIR');
    // Two day buckets the $group/$sort would yield (already ascending).
    const day1 = new Date('2026-06-01T00:00:00.000Z');
    const day2 = new Date('2026-06-02T00:00:00.000Z');
    orderAggregate.mockResolvedValue([
      { _id: day1, orders: 2, revenue: 20_000 },
      { _id: day2, orders: 1, revenue: 12_500 },
    ]);

    const points = await getSalesReport(STORE_ID, { interval: 'day' });

    expect(points).toEqual([
      { bucket: day1.toISOString(), orders: 2, revenue: { amount: 20_000, currency: 'FAIR' } },
      { bucket: day2.toISOString(), orders: 1, revenue: { amount: 12_500, currency: 'FAIR' } },
    ]);
    // The pipeline groups via $dateTrunc and filters paid orders only.
    const pipeline = orderAggregate.mock.calls[0][0];
    expect(hasStage(pipeline, '$group')).toBe(true);
    const groupStage = (pipeline as { $group?: { _id?: unknown } }[]).find((s) => '$group' in s);
    expect(JSON.stringify(groupStage)).toContain('$dateTrunc');
  });

  it('passes the requested interval (week) into the $dateTrunc unit', async () => {
    stubStoreCurrency('FAIR');
    orderAggregate.mockResolvedValue([]);

    await getSalesReport(STORE_ID, { interval: 'week' });

    const pipeline = orderAggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).toContain('"unit":"week"');
  });

  it('defaults the interval to day when none is given', async () => {
    stubStoreCurrency('FAIR');
    orderAggregate.mockResolvedValue([]);

    await getSalesReport(STORE_ID, {});

    const pipeline = orderAggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).toContain('"unit":"day"');
  });
});

describe('report.service.getTopProducts', () => {
  it('ranks products by units sold then revenue, mapping to the TopProduct shape', async () => {
    stubStoreCurrency('FAIR');
    // The $group/$sort/$limit would yield rows already ranked by unitsSold desc.
    orderAggregate.mockResolvedValue([
      { _id: 'listing-A', title: 'Mopit Top', unitsSold: 5, revenue: 50_000 },
      { _id: 'listing-B', title: 'Franny', unitsSold: 2, revenue: 30_000 },
    ]);

    const products = await getTopProducts(STORE_ID, { limit: 10 });

    expect(products).toEqual([
      { listingId: 'listing-A', title: 'Mopit Top', unitsSold: 5, revenue: { amount: 50_000, currency: 'FAIR' } },
      { listingId: 'listing-B', title: 'Franny', unitsSold: 2, revenue: { amount: 30_000, currency: 'FAIR' } },
    ]);
    // The pipeline unwinds line items + sorts by unitsSold then revenue.
    const pipeline = orderAggregate.mock.calls[0][0];
    expect(hasStage(pipeline, '$unwind')).toBe(true);
    expect(JSON.stringify(pipeline)).toContain('"unitsSold":-1');
  });

  it('clamps the limit into [1, 100] and applies the default of 10 when absent', async () => {
    stubStoreCurrency('FAIR');
    orderAggregate.mockResolvedValue([]);

    await getTopProducts(STORE_ID, {});
    let pipeline = orderAggregate.mock.calls[0][0] as { $limit?: number }[];
    expect(pipeline.find((s) => '$limit' in s)?.$limit).toBe(10);

    orderAggregate.mockClear();
    await getTopProducts(STORE_ID, { limit: 9999 });
    pipeline = orderAggregate.mock.calls[0][0] as { $limit?: number }[];
    expect(pipeline.find((s) => '$limit' in s)?.$limit).toBe(100);

    orderAggregate.mockClear();
    await getTopProducts(STORE_ID, { limit: 0 });
    pipeline = orderAggregate.mock.calls[0][0] as { $limit?: number }[];
    expect(pipeline.find((s) => '$limit' in s)?.$limit).toBe(1);
  });
});
