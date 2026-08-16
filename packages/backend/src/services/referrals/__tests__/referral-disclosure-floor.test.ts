/**
 * The disclosure floor (#147, ADR 0005 A5).
 *
 * Every case here is aimed at a MUTATION rather than at a shape:
 *
 *  - drop the complementary step (step 2) and `leaks a lone small row through
 *    the residual` goes red — the only case that can see it, because with two
 *    or more small rows the first step already removes enough;
 *  - relax the magnitude to a SUM of the two counts and `judges a row on its
 *    LARGER count` goes red;
 *  - publish the key with a withheld marker instead of dropping the row and
 *    `never publishes a suppressed key` goes red;
 *  - apply the floor to a partner-instrument dimension and
 *    `publishes a small campaign cell` goes red;
 *  - round a suppressed cell up to the floor instead of dropping it and the
 *    residual case goes red, because the totals no longer reconcile.
 */

import { describe, expect, it } from 'vitest';
import {
  REFERRAL_PARTNER_DISCLOSURE_FLOOR,
  REFERRAL_PERFORMANCE_DIMENSIONS,
  REFERRAL_SUBJECT_REVEALING_DIMENSIONS,
  type ReferralPerformanceRow,
} from '@mercaria/shared-types';
import {
  applyDisclosureFloor,
  dimensionRevealsSubject,
} from '../dashboard/disclosure.js';

function row(key: string, humanClicks: number, qualifiedConversions: number): ReferralPerformanceRow {
  return { key, label: key, humanClicks, qualifiedConversions };
}

describe('the floor applies only to subject-revealing dimensions', () => {
  it('names market and client surface, and nothing else', () => {
    expect([...REFERRAL_SUBJECT_REVEALING_DIMENSIONS].sort()).toEqual([
      'client_surface',
      'market',
    ]);
  });

  it('is a SUBSET of the published dimensions', () => {
    // A floor naming a dimension nobody can request is a rule that cannot fire.
    for (const dimension of REFERRAL_SUBJECT_REVEALING_DIMENSIONS) {
      expect(REFERRAL_PERFORMANCE_DIMENSIONS).toContain(dimension);
    }
  });

  it('publishes a small campaign cell', () => {
    // A partner-instrument dimension. A5 already publishes per-reward
    // {date, state, amount, source, campaign}, so withholding the same figure
    // one tab over would be inconsistent rather than private.
    const measured = [row('summer', 3, 1), row('winter', 40, 12)];
    const disclosed = applyDisclosureFloor(measured, 'campaign');
    expect(disclosed.rows).toEqual(measured);
    expect(disclosed.withheldRowCount).toBe(0);
    expect(dimensionRevealsSubject('campaign')).toBe(false);
  });

  it('publishes a small DATE cell for the same reason', () => {
    const measured = [row('2026-08-01', 1, 1)];
    expect(applyDisclosureFloor(measured, 'date').rows).toEqual(measured);
  });
});

describe('suppression on a subject-revealing dimension', () => {
  it('never publishes a suppressed key', () => {
    const measured = [row('ES', 400, 90), row('AD', 2, 1), row('GI', 3, 1)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    const keys = disclosed.rows.map((r) => r.key);
    expect(keys).not.toContain('AD');
    expect(keys).not.toContain('GI');
    // The key is the disclosure: a row saying "AD, withheld" tells the partner
    // exactly what a count of one would have.
    expect(JSON.stringify(disclosed.rows)).not.toContain('AD');
    expect(JSON.stringify(disclosed.rows)).not.toContain('GI');
  });

  it('counts what it removed, and the count names nobody', () => {
    const disclosed = applyDisclosureFloor(
      [row('ES', 400, 90), row('AD', 2, 1), row('GI', 3, 1)],
      'market',
    );
    expect(disclosed.withheldRowCount).toBe(2);
    expect(disclosed.rows).toHaveLength(1);
    expect(disclosed.rows[0]?.key).toBe('ES');
  });

  it('leaks a lone small row through the residual', () => {
    // THE mutation case. One market under the floor: dropping it alone leaves
    // `totals - Σ(published rows)` equal to exactly that row, recovered in
    // full. Complementary suppression must take a second row.
    const measured = [row('ES', 400, 90), row('FR', 120, 30), row('AD', 2, 1)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    expect(disclosed.withheldRowCount).toBeGreaterThanOrEqual(2);
    expect(disclosed.rows.map((r) => r.key)).not.toContain('AD');
    // The smallest survivor is what was taken, so the breakdown loses as little
    // as it can — `ES` (the largest) must survive.
    expect(disclosed.rows.map((r) => r.key)).toContain('ES');
    expect(disclosed.rows.map((r) => r.key)).not.toContain('FR');
  });

  it('does NOT cost a healthy market to hide a small residual', () => {
    // The rule that was rejected: additionally requiring the suppressed MASS to
    // reach the floor took FR — three hundred clicks, a legitimate market — to
    // hide a residual of five spread over two cells whose names were never
    // published. Since the KEY goes with the row, that residual names nobody at
    // any mass, so the condition is the COUNT.
    const measured = [row('ES', 400, 90), row('FR', 300, 80), row('AD', 2, 0), row('GI', 3, 0)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    const survivorKeys = disclosed.rows.map((r) => r.key);
    expect(survivorKeys).toContain('ES');
    expect(survivorKeys).toContain('FR');
    expect(survivorKeys).not.toContain('AD');
    expect(survivorKeys).not.toContain('GI');
    expect(disclosed.withheldRowCount).toBe(2);
  });

  it('publishes a SINGLE row that clears the floor', () => {
    // A partner whose whole audience is in one market learns their whole
    // audience is in one market, which is nine hundred people rather than a
    // person. The floor exists to stop an individual being identified, not to
    // hide an aggregate from the partner who produced it — and withholding
    // here would leave a working dashboard blank for the commonest shape a
    // successful partner has.
    const disclosed = applyDisclosureFloor([row('ES', 900, 400)], 'market');
    expect(disclosed.rows).toHaveLength(1);
    expect(disclosed.withheldRowCount).toBe(0);
    expect(disclosed.withheldReason).toBeUndefined();
  });

  it('withholds a single row that does NOT clear the floor', () => {
    // The same shape one order of magnitude down is a person: there is no
    // second row to suppress alongside it, so the whole breakdown goes.
    const disclosed = applyDisclosureFloor([row('AD', 2, 1)], 'market');
    expect(disclosed.rows).toEqual([]);
    expect(disclosed.withheldRowCount).toBe(1);
    expect(disclosed.withheldReason).toBe('insufficient_population');
  });

  it('judges a row on its LARGER count', () => {
    // Nine clicks and nine conversions is not eighteen: each figure on its own
    // identifies somebody, so a magnitude that SUMMED them would clear a floor
    // of ten and publish both.
    const measured = [row('ES', 400, 90), row('FR', 200, 60), row('AD', 9, 9)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    expect(disclosed.rows.map((r) => r.key)).not.toContain('AD');
  });

  it('publishes a row that clears the floor on BOTH counts', () => {
    const measured = [row('ES', 400, 90), row('FR', 60, 20)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    expect(disclosed.rows).toHaveLength(2);
    expect(disclosed.withheldRowCount).toBe(0);
    expect(disclosed.withheldReason).toBeUndefined();
  });

  it('withholds the WHOLE breakdown when nothing can be made safe', () => {
    // A new partner: three markets, all tiny. There is no subset whose removal
    // leaves a safe residual, so the dimensioned answer is withheld entirely
    // and the undimensioned totals still go out.
    const measured = [row('ES', 3, 1), row('AD', 2, 0), row('GI', 1, 0)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    expect(disclosed.rows).toEqual([]);
    expect(disclosed.withheldRowCount).toBe(3);
    expect(disclosed.withheldReason).toBe('insufficient_population');
  });

  it('does not withhold an entirely EMPTY breakdown', () => {
    // Zero identifies nobody. Reporting suppression here would tell a partner
    // their data was hidden when what happened is that nothing happened —
    // #82's `not_present` distinction.
    const measured = [row('ES', 0, 0), row('FR', 0, 0)];
    const disclosed = applyDisclosureFloor(measured, 'market');
    expect(disclosed.rows).toEqual(measured);
    expect(disclosed.withheldRowCount).toBe(0);
    expect(disclosed.withheldReason).toBeUndefined();
  });

  it('handles a breakdown with no rows at all', () => {
    const disclosed = applyDisclosureFloor([], 'market');
    expect(disclosed.rows).toEqual([]);
    expect(disclosed.withheldRowCount).toBe(0);
  });

  it('is bounded by the published floor rather than a private one', () => {
    // A vacuity guard on the constant itself: a floor of 1 would make every
    // case above pass while suppressing nothing.
    expect(REFERRAL_PARTNER_DISCLOSURE_FLOOR).toBe(10);
    const justUnder = REFERRAL_PARTNER_DISCLOSURE_FLOOR - 1;
    const measured = [row('ES', 500, 500), row('FR', 400, 400), row('AD', justUnder, justUnder)];
    expect(applyDisclosureFloor(measured, 'market').rows.map((r) => r.key)).not.toContain('AD');

    const atFloor = [
      row('ES', 500, 500),
      row('FR', 400, 400),
      row('AD', REFERRAL_PARTNER_DISCLOSURE_FLOOR, REFERRAL_PARTNER_DISCLOSURE_FLOOR),
    ];
    expect(applyDisclosureFloor(atFloor, 'market').rows.map((r) => r.key)).toContain('AD');
  });
});

describe('the property a subtraction attack rests on', () => {
  it('spreads whatever it hides over at least two never-named cells', () => {
    // Randomised, because the cases above are the ones somebody thought of.
    // The invariant is exactly what a subtraction can learn: either the
    // breakdown is empty, or every published cell clears the floor and the
    // mass it hides is spread over two or more cells whose keys never left.
    let sawSuppression = false;
    let sawWholeWithhold = false;
    for (let seed = 0; seed < 400; seed += 1) {
      const size = 1 + (seed % 6);
      const measured: ReferralPerformanceRow[] = [];
      for (let i = 0; i < size; i += 1) {
        const clicks = (seed * 7 + i * 13) % 40;
        const conversions = (seed * 3 + i * 5) % 25;
        measured.push(row(`m${i}`, clicks, conversions));
      }
      const total = measured.reduce((sum, r) => sum + Math.max(r.humanClicks, r.qualifiedConversions), 0);
      const disclosed = applyDisclosureFloor(measured, 'market');
      const publishedMass = disclosed.rows.reduce(
        (sum, r) => sum + Math.max(r.humanClicks, r.qualifiedConversions),
        0,
      );
      const residual = total - publishedMass;

      if (disclosed.withheldRowCount === 0) {
        expect(residual).toBe(0);
        continue;
      }
      sawSuppression = true;
      if (disclosed.rows.length === 0) {
        sawWholeWithhold = true;
        continue;
      }
      expect(disclosed.withheldRowCount).toBeGreaterThanOrEqual(2);
      // Every published cell cleared the floor, and no suppressed key left.
      for (const published of disclosed.rows) {
        expect(Math.max(published.humanClicks, published.qualifiedConversions)).toBeGreaterThanOrEqual(
          REFERRAL_PARTNER_DISCLOSURE_FLOOR,
        );
      }
      expect(residual).toBeGreaterThan(0);
    }
    // Vacuity floors: a run in which nothing was ever suppressed would pass
    // every assertion above while measuring nothing at all.
    expect(sawSuppression).toBe(true);
    expect(sawWholeWithhold).toBe(true);
  });
});
