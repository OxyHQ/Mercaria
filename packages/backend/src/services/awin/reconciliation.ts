/**
 * The seam onto commission reconciliation (#66 design item 8, owned by #67).
 *
 * **#66 calls Awin's transactions endpoint from nowhere, and that is deliberate
 * rather than unfinished.** #67 owns the outbound redirect AND reconciliation,
 * and a transaction row Mercaria cannot attribute to a click it recorded is not
 * reconciliation — it is a number in a table with nothing to compare it
 * against. Storing them early would produce exactly the "looked fine" shape this
 * domain exists to avoid: a growing table, a green dashboard, and no answer to
 * the only question anybody asks of it.
 *
 * So the seam fails closed by ABSENCE, which is the strongest form: there is no
 * `awin_transactions` table, no sink port and no scheduled job, so there is
 * nothing to mistake for a working feature.
 *
 * What IS here is the one piece that is easy to get wrong invisibly, and that
 * #67 would otherwise re-derive: the window chunker. Awin accepts a range of at
 * most 31 days, and a chunker that is off by one at the boundary silently drops
 * a day of commission at every seam — a fault whose only symptom is a number
 * that is slightly too small, forever.
 */

import { AWIN_PUBLISHER_API_MAX_WINDOW_DAYS } from '@mercaria/shared-types';
import type { AwinTransactionWindow } from '@mercaria/shared-types';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Chunk a range into windows Awin will accept.
 *
 * Both ends INCLUSIVE, contiguous, and covering the range exactly — no gap and
 * no overlap. The three properties are asserted over randomized ranges in
 * `awin-rules.test.ts` rather than by example, because the failure this function
 * exists to prevent is a one-day gap at one boundary out of twelve, which every
 * hand-written example happens to miss.
 *
 * An INVERTED range yields nothing rather than one backwards window: `to`
 * before `from` is a caller's mistake, and answering it with a query Awin would
 * accept turns a bug into a silently empty result.
 *
 * The maximum is `AWIN_PUBLISHER_API_MAX_WINDOW_DAYS` (31) and the arithmetic
 * is in whole DAYS on the UTC timeline, so a window never straddles a
 * daylight-saving boundary into 32 days — which is a rejection from Awin at
 * exactly two moments a year, in one of the two hemispheres.
 */
export function splitAwinTransactionWindows(from: Date, to: Date): readonly AwinTransactionWindow[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];

  const windows: AwinTransactionWindow[] = [];
  // The last day the window may cover is `start + (max - 1)` days: a window of
  // 31 days INCLUSIVE spans 30 day-steps. Writing `max` here is the off-by-one
  // that produces a 32-day request Awin refuses.
  const stepMs = (AWIN_PUBLISHER_API_MAX_WINDOW_DAYS - 1) * DAY_MS;
  for (let cursor = start; cursor <= end; cursor += stepMs + DAY_MS) {
    const windowEnd = Math.min(cursor + stepMs, end);
    windows.push({
      from: new Date(cursor).toISOString(),
      to: new Date(windowEnd).toISOString(),
    });
  }
  return windows;
}
