/**
 * The disclosure floor a partner's performance breakdown is subject to (#147,
 * under ADR 0005 A5).
 *
 * PURE, and the only place a measured breakdown is turned into one a partner
 * may read. One function, so "was the floor applied" is answered by whether
 * this module was called rather than by reading every caller.
 *
 * ## What the floor is for, and what it is not for
 *
 * It is not a general "small numbers are scary" rule. #147 states the condition
 * exactly: apply a minimum count "where a dimension could reveal an individual
 * customer or merchant". So the question is **whose fact is the dimension** —
 * `REFERRAL_SUBJECT_REVEALING_DIMENSIONS` names the two that describe the
 * person who arrived rather than the promotion that brought them.
 *
 * Applying it to the other four would be inconsistent rather than private: ADR
 * 0005 A5 already publishes per-reward `{date, state, net amount, source,
 * campaign}`, so a partner can count one conversion on one day off their own
 * earnings list. A floor withholding the same figure one tab over is a gate
 * whose cheapest green is to delete it.
 *
 * ## Suppression removes the ROW, and then removes one more
 *
 * A row's key is itself the disclosure — `market: 'AD'` with a suppressed count
 * still says somebody was referred in Andorra — so a cell under the floor is
 * dropped entirely, key and all. And because the undimensioned totals are
 * published beside the rows, subtracting the survivors recovers the suppressed
 * MASS exactly. With one suppressed row that mass IS the row, restored in full;
 * with two or more it is an aggregate over cells whose names were never
 * published. So suppression is COMPLEMENTARY:
 *
 *  1. drop every row under the floor;
 *  2. if exactly ONE fell, drop the smallest survivor as well;
 *  3. if nothing is left to publish, withhold the whole breakdown.
 *
 * Step 2 is what a mutation test aims at: removing it leaves every case with
 * two or more small rows green and leaks exactly the single-small-row case.
 *
 * ## Why the condition is the COUNT and not the suppressed mass
 *
 * The first version additionally required the suppressed mass to reach the
 * floor, and it was wrong in a way worth writing down. Given
 * `{ES: 400, FR: 300, AD: 2, GI: 3}`, that rule dropped AD and GI (mass 5),
 * found 5 under the floor, and took FR as well — costing a legitimate market
 * with three hundred clicks to hide a residual of five spread across two cells
 * whose names were never published. It bought nothing: because the KEY goes
 * with the row, what a subtraction yields is "five clicks happened in markets
 * you cannot see", which names nobody at any mass. What turns that aggregate
 * back into a CELL is there being exactly one of them, and that is the count.
 *
 * The residual bound this domain therefore claims, stated so nobody has to
 * infer it: **every published cell clears the floor, and a subtraction over the
 * totals yields a sum spread across at least two cells whose keys were never
 * disclosed.** It does not claim that sum is large.
 *
 * ## Zero is not withheld, and the whole breakdown being empty is not either
 *
 * A dimension whose measured population is entirely zero has nobody to
 * identify, so it is published as the empty breakdown it is. Withholding it
 * would report a suppression that did not happen — the distinction #82's
 * `not_present` exists to keep.
 */

import {
  REFERRAL_PARTNER_DISCLOSURE_FLOOR,
  REFERRAL_SUBJECT_REVEALING_DIMENSIONS,
  type ReferralPerformanceDimension,
  type ReferralPerformanceRow,
  type ReferralPerformanceWithholdReason,
} from '@mercaria/shared-types';

/** Whether this dimension describes the referred SUBJECT rather than the promotion. */
export function dimensionRevealsSubject(dimension: ReferralPerformanceDimension): boolean {
  return REFERRAL_SUBJECT_REVEALING_DIMENSIONS.includes(dimension);
}

/**
 * The number a suppression decision is taken on.
 *
 * The MAXIMUM of the two counts, not their sum and not the conversion count
 * alone. A row is safe only when BOTH of its published figures are safe, and
 * summing them would let nine clicks plus nine conversions clear a floor of ten
 * while each figure on its own identifies somebody.
 */
function rowMagnitude(row: ReferralPerformanceRow): number {
  return Math.max(row.humanClicks, row.qualifiedConversions);
}

export interface DisclosedBreakdown {
  rows: readonly ReferralPerformanceRow[];
  withheldRowCount: number;
  withheldReason?: ReferralPerformanceWithholdReason;
}

/**
 * Apply the floor to a measured breakdown.
 *
 * @param rows Every measured cell, in whatever order the caller assembled them.
 * @param dimension Decides whether the floor applies at all.
 */
export function applyDisclosureFloor(
  rows: readonly ReferralPerformanceRow[],
  dimension: ReferralPerformanceDimension,
): DisclosedBreakdown {
  if (!dimensionRevealsSubject(dimension)) {
    return { rows, withheldRowCount: 0 };
  }
  if (rows.length === 0) return { rows, withheldRowCount: 0 };

  // A breakdown in which nothing at all was measured has nobody to identify.
  if (rows.every((row) => rowMagnitude(row) === 0)) {
    return { rows, withheldRowCount: 0 };
  }

  // Step 1 — everything under the floor goes.
  const survivors: ReferralPerformanceRow[] = [];
  const suppressed: ReferralPerformanceRow[] = [];
  for (const row of rows) {
    if (rowMagnitude(row) < REFERRAL_PARTNER_DISCLOSURE_FLOOR) suppressed.push(row);
    else survivors.push(row);
  }

  if (suppressed.length === 0) return { rows: survivors, withheldRowCount: 0 };

  // Step 2 — exactly one row fell, so the totals restore it exactly. Take the
  // SMALLEST survivor as well, so the breakdown loses as little as it can.
  if (suppressed.length === 1 && survivors.length > 0) {
    survivors.sort((a, b) => rowMagnitude(a) - rowMagnitude(b));
    suppressed.push(survivors.shift() as ReferralPerformanceRow);
  }

  // Step 3 — nothing publishable is left, so the dimensioned answer is
  // withheld whole. The undimensioned totals still go out: they are the
  // partner's own aggregate, and with no rows published there is nothing to
  // subtract them from.
  //
  // A breakdown of ONE row that CLEARS the floor never reaches here, and that
  // is deliberate: a partner whose whole audience is in one market learns their
  // whole audience is in one market, which is nine hundred people rather than a
  // person. The floor stops an individual being identified; it is not a rule
  // against a partner seeing an aggregate they produced.
  if (survivors.length === 0) {
    return {
      rows: [],
      withheldRowCount: rows.length,
      withheldReason: 'insufficient_population',
    };
  }

  return { rows: survivors, withheldRowCount: suppressed.length };
}
