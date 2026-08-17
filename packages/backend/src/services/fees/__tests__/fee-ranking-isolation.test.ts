/**
 * Trust rule 1 (#88): paying a different fee never changes organic ranking —
 * asserted STRUCTURALLY. No feed, search or catalogue-read module may import
 * the fee domain or name its tables; a ranking function that cannot reach fee
 * data cannot rank by it, which is a stronger statement than any behavioural
 * fixture could make.
 *
 * The scanner follows the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor (every scanned file must exist and be non-trivial, so a moved file
 * fails the gate instead of silently shrinking it) and a mutation self-test
 * (the detector is run against a seeded positive, so a broken regex cannot
 * pass by matching nothing).
 */

import { describe, expect, it } from 'vitest';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

/**
 * The organic discovery surface: everything that decides WHICH listings a buyer
 * sees, and in what order.
 *
 * This was nineteen hand-written paths, and the same nineteen (give or take a
 * drifted copy) appeared in ten other isolation gates. It is now ONE derivation
 * — `__tests__/ranking-surface.ts` — walked and derived from the import graph,
 * so a ranking module nobody has written yet is behind this wall on the day it
 * lands rather than on the day somebody remembers eleven files (#460).
 */

/**
 * What reaching the fee domain looks like, from any direction: an import of a
 * fee module, a reference to a fee table object, or a raw-SQL mention of the
 * tables themselves.
 */
const FEE_REFERENCE = /fees\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee/;

describe('organic ranking cannot read fee data', () => {
  it('walks the ranking surface rather than listing it, and every shape found something', () => {
    assertRankingSurfaceIsWhole();
  });

  it('no feed, search or catalogue-read module references the fee domain', () => {
    let scanned = 0;
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);
      expect(
        FEE_REFERENCE.test(source),
        `${relative} references the fee domain; ranking must not be able to read fee data`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });

  it('the detector actually detects — the mutation self-test', () => {
    // Break the thing the gate guards, in miniature, and confirm the gate sees
    // it: a scanner whose regex rotted would pass the test above vacuously and
    // fail this one loudly.
    const seeded = "import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';";
    expect(FEE_REFERENCE.test(seeded)).toBe(true);
    expect(FEE_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(FEE_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);
  });

  it('the fee schedule scope columns cannot express a ranking input either', async () => {
    // The reverse direction of the same wall: a schedule can scope on the
    // seller type and the currency and on NOTHING else — not sales volume, not
    // plan, not any figure ranking also consumes — so "pay more, rank higher"
    // has no field to live in.
    const { feeSchedules } = await import('../../../db/schema/fees.js');
    const { getTableColumns } = await import('drizzle-orm');
    const scopeColumns = Object.keys(getTableColumns(feeSchedules)).filter((name) =>
      name.startsWith('eligible'),
    );
    expect(scopeColumns.sort()).toEqual(['eligibleCurrency', 'eligibleSellerType']);
  });
});
