/**
 * The next-occurrence arithmetic of an export schedule: cadences, local hours
 * across time zones, and both daylight-saving edges.
 */

import { describe, expect, it } from 'vitest';
import type { DataExportScheduleTiming } from '../../../db/dataExports/scheduleRepository.js';
import { nextDataExportOccurrence, zonedInstant } from '../occurrence.js';

function timing(partial: Partial<DataExportScheduleTiming>): DataExportScheduleTiming {
  return {
    cadence: 'daily',
    hour: 6,
    weekday: null,
    dayOfMonth: null,
    timeZone: 'UTC',
    ...partial,
  };
}

const iso = (date: Date) => date.toISOString();

describe('daily', () => {
  it('runs later today when the hour has not passed, else tomorrow', () => {
    const schedule = timing({ hour: 6 });
    expect(iso(nextDataExportOccurrence(schedule, new Date('2026-03-10T05:59:00Z')))).toBe(
      '2026-03-10T06:00:00.000Z',
    );
    expect(iso(nextDataExportOccurrence(schedule, new Date('2026-03-10T06:00:00Z')))).toBe(
      '2026-03-11T06:00:00.000Z',
    );
  });

  it('is STRICTLY after: an occurrence advances to the next one, never itself', () => {
    const schedule = timing({ hour: 0 });
    const first = nextDataExportOccurrence(schedule, new Date('2026-01-31T12:00:00Z'));
    expect(iso(first)).toBe('2026-02-01T00:00:00.000Z');
    expect(iso(nextDataExportOccurrence(schedule, first))).toBe('2026-02-02T00:00:00.000Z');
  });

  it('reads the hour in the schedule’s own time zone', () => {
    // 06:00 in Tokyo (UTC+9, no DST) is 21:00Z the previous day.
    const schedule = timing({ hour: 6, timeZone: 'Asia/Tokyo' });
    expect(iso(nextDataExportOccurrence(schedule, new Date('2026-07-01T00:00:00Z')))).toBe(
      '2026-07-01T21:00:00.000Z',
    );
    // 06:00 in Los Angeles is 13:00Z in summer and 14:00Z in winter.
    const la = timing({ hour: 6, timeZone: 'America/Los_Angeles' });
    expect(iso(nextDataExportOccurrence(la, new Date('2026-07-01T00:00:00Z')))).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(iso(nextDataExportOccurrence(la, new Date('2025-12-01T00:00:00Z')))).toBe(
      '2025-12-01T14:00:00.000Z',
    );
  });
});

describe('weekly and monthly', () => {
  it('runs on the named weekday', () => {
    // 2026-03-10 is a Tuesday; the next Monday (1) is the 16th.
    const schedule = timing({ cadence: 'weekly', weekday: 1, hour: 9, timeZone: 'Europe/Madrid' });
    expect(iso(nextDataExportOccurrence(schedule, new Date('2026-03-10T12:00:00Z')))).toBe(
      '2026-03-16T08:00:00.000Z',
    );
  });

  it('runs on the named day of the month, rolling over the year', () => {
    const schedule = timing({ cadence: 'monthly', dayOfMonth: 28, hour: 23 });
    expect(iso(nextDataExportOccurrence(schedule, new Date('2026-02-28T23:00:00Z')))).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    const first = timing({ cadence: 'monthly', dayOfMonth: 1, hour: 0 });
    expect(iso(nextDataExportOccurrence(first, new Date('2025-12-15T00:00:00Z')))).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('a schedule reached late advances ONCE, to the next future occurrence', () => {
    const schedule = timing({ hour: 6 });
    // Ten days behind: the next occurrence is from NOW, not from ten days ago.
    expect(iso(nextDataExportOccurrence(schedule, new Date('2026-05-20T10:00:00Z')))).toBe(
      '2026-05-21T06:00:00.000Z',
    );
  });
});

describe('daylight saving', () => {
  it('a local hour inside the spring-forward gap runs at the end of the gap', () => {
    // Europe/Madrid skipped 02:00→03:00 on 2026-03-29 (01:00Z).
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 2, 'Europe/Madrid'))).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    // The hour after the gap is ordinary.
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 3, 'Europe/Madrid'))).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 4, 'Europe/Madrid'))).toBe(
      '2026-03-29T02:00:00.000Z',
    );
  });

  it('a local hour that happens twice runs at the FIRST of them', () => {
    // Europe/Madrid repeated 02:00–03:00 on 2026-10-25 (01:00Z is the switch).
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 25 }, 2, 'Europe/Madrid'))).toBe(
      '2026-10-25T00:00:00.000Z',
    );
  });

  it('a daily schedule in the gap still runs once that day', () => {
    const schedule = timing({ hour: 2, timeZone: 'Europe/Madrid' });
    const day = nextDataExportOccurrence(schedule, new Date('2026-03-28T12:00:00Z'));
    expect(iso(day)).toBe('2026-03-29T01:00:00.000Z');
    expect(iso(nextDataExportOccurrence(schedule, day))).toBe('2026-03-30T00:00:00.000Z');
  });
});
