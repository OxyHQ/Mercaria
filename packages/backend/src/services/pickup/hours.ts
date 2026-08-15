/**
 * Is this shop open, in ITS OWN local time.
 *
 * Pure, clock-injected, and reading the publication's IANA `timezone` through
 * `Intl.DateTimeFormat` rather than an offset. An offset is the wrong shape for
 * the question: Europe/Madrid is +01:00 in January and +02:00 in July, so a
 * stored offset is correct for half the year and silently an hour out for the
 * other half — and the half it is wrong in is the half with the long opening
 * hours.
 *
 * ## The answer is three-valued, not two
 *
 * `{ known: false }` covers a publication whose timezone the runtime does not
 * recognise. That is a real state — a zone can be removed from the IANA
 * database, and a merchant can be migrated from a deployment that validated
 * differently — and rendering it as CLOSED would take a working shop off the
 * map, while rendering it as OPEN would send somebody to a locked door. Saying
 * "we do not know" is the only answer that is not a lie, and the nearby read
 * treats it as a fact to show rather than a reason to hide the location.
 *
 * ## A closure beats the schedule, and says so
 *
 * A dated closure is the merchant's most specific statement about one day, so
 * it wins over the weekly hours and carries its own note into the answer. A
 * schedule that also said "open" on that day is not a conflict — it is the
 * ordinary case, since a holiday closure is precisely an exception to a day the
 * shop is normally open.
 */

import type {
  LocationClosure,
  LocationOpenState,
  LocationOpeningHour,
} from '@mercaria/shared-types';

/** A publication's schedule, as the derivation needs to see it. */
export interface LocationSchedule {
  readonly timezone: string;
  readonly hours: readonly LocationOpeningHour[];
  readonly closures: readonly LocationClosure[];
}

/** The local calendar facts one instant has in one zone. */
interface LocalMoment {
  /** `YYYY-MM-DD` in the location's own zone. */
  readonly date: string;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  /** Minutes since local midnight. */
  readonly minuteOfDay: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Project an instant into one IANA zone.
 *
 * `formatToParts` rather than parsing a formatted string: the parts are named,
 * so a locale that renders `2026-08-10` as `10/08/2026` cannot silently swap the
 * day and the month. `en-US` is pinned for the same reason — the weekday
 * abbreviations this maps are that locale's, and a runtime default locale would
 * make the mapping depend on where the server happens to be configured.
 *
 * Returns `null` for a zone `Intl` refuses, which is the `{ known: false }`
 * branch above.
 */
function localMoment(timezone: string, at: Date): LocalMoment | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    // A zone `Intl` does not know. Reported as unknown rather than absorbed —
    // the caller renders it, and `readPublicationHealth` counts it.
    return null;
  }

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = WEEKDAY_INDEX[value('weekday')];
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return {
    date: `${year}-${month}-${day}`,
    weekday,
    minuteOfDay: hour * 60 + minute,
  };
}

/** `HH:MM` from minutes since midnight, with 1440 rendered as `24:00`. */
function renderMinute(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Whether a location is open at `at`, and when that changes.
 *
 * The `changesAt` half is what makes the answer actionable: "closed" alone
 * sends a shopper away, and "closed, opens 09:00" sends them back tomorrow.
 * It is only emitted when the schedule actually says — a closure with no end
 * inside the current day answers `open: false` with no time, because the next
 * opening is on a day this function was not asked about.
 */
export function deriveLocationOpenState(schedule: LocationSchedule, at: Date): LocationOpenState {
  const moment = localMoment(schedule.timezone, at);
  if (!moment) return { known: false };

  const closure = schedule.closures.find(
    (entry) => entry.fromDate <= moment.date && moment.date <= entry.throughDate,
  );
  if (closure) {
    return closure.note === undefined
      ? { known: true, open: false }
      : { known: true, open: false, closureNote: closure.note };
  }

  const today = schedule.hours
    .filter((entry) => entry.weekday === moment.weekday)
    .sort((left, right) => left.opensMinute - right.opensMinute);
  if (today.length === 0) return { known: true, open: false };

  const current = today.find(
    (entry) => entry.opensMinute <= moment.minuteOfDay && moment.minuteOfDay < entry.closesMinute,
  );
  if (current) {
    return { known: true, open: true, changesAt: renderMinute(current.closesMinute) };
  }

  const next = today.find((entry) => entry.opensMinute > moment.minuteOfDay);
  return next
    ? { known: true, open: false, changesAt: renderMinute(next.opensMinute) }
    : { known: true, open: false };
}

/**
 * Whether a location has ANY opening interval inside the next `horizonHours`.
 *
 * The nearby read's `location_closed` block reason uses this rather than
 * "closed right now": a shop that opens in the morning is a perfectly good
 * answer to "where can I collect this", and hiding every shop in a city at 11pm
 * would make the feature useless at exactly the hour people browse. What it
 * does exclude is a location that is shut for the whole horizon — a refit, a
 * three-week holiday — which is a place nobody should be sent to.
 *
 * A publication with NO hours at all answers `true`: a merchant who published a
 * collection point and no schedule has told us nothing about when it is shut,
 * and inventing "never open" from silence would delist them for an empty form.
 */
export function opensWithin(schedule: LocationSchedule, at: Date, horizonHours: number): boolean {
  if (schedule.hours.length === 0) return true;

  const stepMinutes = 30;
  const steps = Math.ceil((horizonHours * 60) / stepMinutes);
  for (let step = 0; step <= steps; step += 1) {
    const probe = new Date(at.getTime() + step * stepMinutes * 60_000);
    const state = deriveLocationOpenState(schedule, probe);
    // An unknown zone cannot exclude anything — the same reasoning as the
    // absent-schedule case, one layer down.
    if (!state.known) return true;
    if (state.open) return true;
  }
  return false;
}

/** How far ahead {@link opensWithin} looks by default — a week's worth of a shop's calendar. */
export const DEFAULT_OPEN_HORIZON_HOURS = 7 * 24;
