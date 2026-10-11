import type { SalesReportPoint } from '@mercaria/shared-types';

export type ReportDays = 7 | 30 | 90;
export interface ReportRange {
  from: string;
  to: string;
}
const DAY_MS = 86_400_000;

/** Reports bucket in UTC; keep the requested bounds and empty chart days aligned. */
export function reportRange(days: ReportDays, now: number): ReportRange {
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return {
    from: new Date(start - (days - 1) * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
  };
}

export function dailySales(points: SalesReportPoint[], range: ReportRange): SalesReportPoint[] {
  if (!points.length) return [];
  const indexed = new Map(points.map((point) => [point.bucket.slice(0, 10), point]));
  const result: SalesReportPoint[] = [];
  for (let day = Date.parse(range.from); day <= Date.parse(range.to); day += DAY_MS) {
    const bucket = new Date(day).toISOString();
    result.push(
      indexed.get(bucket.slice(0, 10)) ?? {
        bucket,
        orders: 0,
        revenue: { amount: 0, currency: points[0].revenue.currency },
      },
    );
  }
  return result;
}

/** A UTC bucket is a calendar day, not an instant to shift into the reader's zone. */
export function reportCalendarDate(bucket: string): Date {
  const utc = new Date(bucket);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), 12);
}
