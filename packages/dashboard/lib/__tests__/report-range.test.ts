import { describe, expect, it } from 'vitest';
import { dailySales, reportCalendarDate, reportRange } from '../report-range';

describe('merchant report calendar', () => {
  it('includes exactly the requested UTC dates across a year boundary', () => {
    const range = reportRange(7, Date.parse('2026-01-03T17:30:00Z'));
    expect(range).toEqual({ from: '2025-12-28T00:00:00.000Z', to: '2026-01-03T17:30:00.000Z' });
    const points = dailySales(
      [
        {
          bucket: '2026-01-01T00:00:00.000Z',
          orders: 2,
          revenue: { amount: 1500, currency: 'EUR' },
        },
      ],
      range,
    );
    expect(points).toHaveLength(7);
    expect(points.map((point) => point.orders)).toEqual([0, 0, 0, 0, 2, 0, 0]);
    expect(points.map((point) => point.revenue.amount)).toEqual([0, 0, 0, 0, 1500, 0, 0]);
    expect(points.every((point) => point.revenue.currency === 'EUR')).toBe(true);
  });
  it('keeps a completely empty report empty rather than inventing a currency', () => {
    expect(dailySales([], reportRange(30, Date.now()))).toEqual([]);
  });
  it('displays the UTC bucket date in the reader calendar without timezone shifts', () => {
    const date = reportCalendarDate('2026-01-01T00:00:00.000Z');
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 0, 1]);
  });
});
