/**
 * A GoWay place's weekly hours, as the location editor's seven text fields.
 *
 * GoWay stores intervals `{ day, opens, closes }` in the place's own local
 * wall-clock time (`closes <= opens` crosses midnight, `00:00`–`00:00` is the
 * whole day). A merchant types one line per weekday — `09:00-14:00, 17:00-20:00`
 * — and an empty line is a day the shop is closed. Pure, so the round trip is
 * tested without a renderer.
 */

import type { OpeningHoursInterval } from "@goway.to/sdk";

/** A weekday as GoWay numbers it: 0 = Sunday … 6 = Saturday. */
export type Weekday = OpeningHoursInterval["day"];

/** The order the editor lists the week in — Monday first, the order shop signs use. */
export const EDITOR_WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/**
 * Each weekday's label, as a translation KEY (module scope runs before the
 * locale store rehydrates, so a resolved word here would freeze one language).
 */
export const WEEKDAY_LABEL_KEYS: Record<Weekday, string> = {
  0: "settings.locations.editor.days.sun",
  1: "settings.locations.editor.days.mon",
  2: "settings.locations.editor.days.tue",
  3: "settings.locations.editor.days.wed",
  4: "settings.locations.editor.days.thu",
  5: "settings.locations.editor.days.fri",
  6: "settings.locations.editor.days.sat",
};

/** One line of the week editor per weekday. */
export type WeekText = Record<Weekday, string>;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `9:00` → `09:00`; anything that is not a clock time stays as typed and fails. */
function normalizeClock(value: string): string {
  const trimmed = value.trim();
  return /^\d:\d\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
}

/** The text a day's intervals read as. */
export function formatRanges(ranges: readonly { opens: string; closes: string }[]): string {
  return ranges.map((range) => `${range.opens}-${range.closes}`).join(", ");
}

/**
 * Read one day's line. `null` when it is not a list of `HH:mm-HH:mm` ranges;
 * `[]` for an empty line, which is a closed day.
 */
export function parseRanges(text: string): { opens: string; closes: string }[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const ranges: { opens: string; closes: string }[] = [];
  for (const part of trimmed.split(/[,;]/)) {
    const pieces = part.split(/[-–]/);
    if (pieces.length !== 2) return null;
    const opens = normalizeClock(pieces[0]);
    const closes = normalizeClock(pieces[1]);
    if (!CLOCK.test(opens) || !CLOCK.test(closes)) return null;
    ranges.push({ opens, closes });
  }
  return ranges;
}

/** The seven lines a place's weekly intervals read as. */
export function weekTextOf(intervals: readonly OpeningHoursInterval[]): WeekText {
  const week = {} as WeekText;
  for (const day of EDITOR_WEEK) {
    week[day] = formatRanges(
      intervals
        .filter((interval) => interval.day === day)
        .sort((left, right) => left.opens.localeCompare(right.opens)),
    );
  }
  return week;
}

/** The intervals seven lines say, or the first day whose line is not readable. */
export function intervalsOf(
  week: WeekText,
): { ok: true; intervals: OpeningHoursInterval[] } | { ok: false; day: Weekday } {
  const intervals: OpeningHoursInterval[] = [];
  for (const day of EDITOR_WEEK) {
    const ranges = parseRanges(week[day]);
    if (ranges === null) return { ok: false, day };
    for (const range of ranges) intervals.push({ day, opens: range.opens, closes: range.closes });
  }
  return { ok: true, intervals };
}
