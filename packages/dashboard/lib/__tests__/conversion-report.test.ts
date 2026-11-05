import { describe, expect, it } from 'vitest';
import {
  calendarDate,
  conversionWindow,
  formatPointsChange,
  formatRate,
  formatRelativeChange,
} from '../conversion-report';

describe('the conversion report window', () => {
  it('ends today in UTC and counts today as one of its days', () => {
    expect(conversionWindow(7, Date.parse('2026-01-03T23:30:00Z'))).toEqual({
      from: '2025-12-28',
      to: '2026-01-03',
    });
    expect(conversionWindow(90, Date.parse('2026-11-05T01:00:00Z'))).toEqual({
      from: '2026-08-08',
      to: '2026-11-05',
    });
  });

  it('formats a calendar date without moving it across midnight', () => {
    const date = calendarDate('2026-10-05');
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 9, 5]);
  });
});

describe('the conversion figures as text', () => {
  it('formats rates and signed changes', () => {
    expect(formatRate(0.5, 'en')).toBe('50%');
    expect(formatRate(0.1234, 'en')).toBe('12.3%');
    expect(formatRelativeChange(0.25, 'en')).toBe('+25%');
    expect(formatRelativeChange(-0.1, 'en')).toBe('-10%');
    expect(formatPointsChange(0.05, 'en')).toBe('+5.0');
    expect(formatPointsChange(0, 'en')).toBe('0.0');
  });
});
