/**
 * When a schedule is next due — pure arithmetic over a cadence, a local hour and
 * an IANA time zone, with no dependency beyond the runtime's `Intl`.
 *
 * A schedule says "every Monday at 06:00 in Europe/Madrid", so its due instants
 * move with daylight saving: 06:00 is 05:00Z in winter and 04:00Z in summer.
 * Two edges, each decided once:
 *
 * - A local hour that does not exist (the spring-forward gap) runs at the first
 *   instant after it — 02:00 on a night that skips from 02:00 to 03:00 runs at
 *   03:00 — rather than being skipped for that day.
 * - A local hour that happens twice (the fall-back overlap) runs at the FIRST of
 *   them, once.
 *
 * A monthly schedule names a day from 1 to 28, so every month has it and no
 * "the 31st in February" rule is needed.
 */

import type { DataExportScheduleTiming } from '../../db/dataExports/scheduleRepository.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

interface LocalDate {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of `at` in `timeZone`, as if it were UTC (ms). */
function wallClockMs(at: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
}

/** How far `timeZone` is ahead of UTC at instant `at`, in ms. */
function offsetMs(at: number, timeZone: string): number {
  // Whole seconds: `Intl` reads no milliseconds.
  const floored = Math.floor(at / 1_000) * 1_000;
  return wallClockMs(floored, timeZone) - floored;
}

/** The local calendar date `at` falls on in `timeZone`. */
function localDateOf(at: number, timeZone: string): LocalDate {
  const wall = new Date(wallClockMs(at, timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

/**
 * The UTC instant of `hour:00` on a local date — the first such instant when
 * the hour repeats, and the first instant after the gap when it does not exist.
 */
export function zonedInstant(date: LocalDate, hour: number, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour);
  // The offsets a day either side of the wall time: equal on an ordinary day,
  // and the two sides of the one transition when the day has one.
  const before = offsetMs(wall - DAY_MS, timeZone);
  const after = offsetMs(wall + DAY_MS, timeZone);
  const candidates = [wall - before, wall - after].sort((a, b) => a - b);
  // The earliest candidate that reads back as the requested wall time: the
  // only one on an ordinary day, the FIRST of two in a fall-back overlap.
  for (const candidate of candidates) {
    if (wallClockMs(candidate, timeZone) === wall) return new Date(candidate);
  }
  // Neither reads back: the wall time is inside a spring-forward gap. Applying
  // the offset from BEFORE the jump lands on the jump itself — the first
  // instant after the gap (02:00 on a 02:00→03:00 night runs at 03:00).
  return new Date(wall - before);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function matches(date: LocalDate, timing: DataExportScheduleTiming): boolean {
  switch (timing.cadence) {
    case 'daily':
      return true;
    case 'weekly':
      return weekdayOf(date) === timing.weekday;
    case 'monthly':
      return date.day === timing.dayOfMonth;
  }
}

/**
 * The first due instant STRICTLY after `after`.
 *
 * Strictly, so a run materialized at its occurrence advances to the NEXT one
 * rather than to itself, and a schedule the worker reaches late (a deploy, an
 * outage, a paused loop) advances to the next future occurrence — one run for
 * the missed time, never a burst of catch-up runs.
 */
export function nextDataExportOccurrence(timing: DataExportScheduleTiming, after: Date): Date {
  const start = localDateOf(after.getTime() - DAY_MS, timing.timeZone);
  // A monthly day ≤ 28 recurs within 31 days, so 64 days always finds two.
  for (let offset = 0; offset < 64; offset += 1) {
    const date = addDays(start, offset);
    if (!matches(date, timing)) continue;
    const instant = zonedInstant(date, timing.hour, timing.timeZone);
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new RangeError('A data export schedule produced no occurrence within 64 days.');
}
