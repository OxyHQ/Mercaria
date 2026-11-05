import type { ConversionReportWindow } from '@mercaria/shared-types';

/** The windows the screen offers, in days, today included. All within the server's 92. */
export const CONVERSION_WINDOW_DAYS = [7, 28, 90] as const;
export type ConversionWindowDays = (typeof CONVERSION_WINDOW_DAYS)[number];

const DAY_MS = 86_400_000;

/** The last `days` UTC calendar days ending today, as the report's inclusive dates. */
export function conversionWindow(days: ConversionWindowDays, now: number): ConversionReportWindow {
  const today = new Date(now);
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return {
    from: new Date(end - (days - 1) * DAY_MS).toISOString().slice(0, 10),
    to: new Date(end).toISOString().slice(0, 10),
  };
}

/** A 0–1 rate as a percentage, at most one decimal: `0.5` → `50%`. */
export function formatRate(rate: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(rate);
}

/** A relative change with its sign: `0.25` → `+25%`, `-0.1` → `-10%`. */
export function formatRelativeChange(change: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }).format(change);
}

/** A rate difference in percentage points, signed: `0.05` → `+5.0`. */
export function formatPointsChange(change: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(change * 100);
}

/** A UTC calendar date (`YYYY-MM-DD`) as a local noon, so formatting never shifts the day. */
export function calendarDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}
