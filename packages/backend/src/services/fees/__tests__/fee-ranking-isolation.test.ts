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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The organic discovery surface: everything that decides WHICH listings a buyer
 * sees, and in what order. A new ranking module belongs on this list — the
 * floor below is what forces whoever moves one to look here.
 */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
  'db/catalog/listingRepository.ts',
  // The offer comparison (#74) — the surface that now decides which offers a
  // shopper sees and in what order. It joined this list with the domain that
  // created it, which is what these lists are for.
  'services/ranking/eligibility.ts',
  'services/ranking/ranking.ts',
  'services/ranking/labels.ts',
  'services/ranking/facts.ts',
  'services/ranking/comparison.service.ts',
  'controllers/offer-comparison.controller.ts',
  'routes/offer-comparison.ts',
  // #70's canonical discovery path. Added here as well as being covered by
  // `search-relevance-isolation.test.ts`, which gates all SEVEN prohibited
  // relevance inputs over the whole domain: this list is the one a reader looks
  // at to answer "what ranks listings", and a canonical search absent from it
  // would read as a surface nobody had considered.
  'services/search/canonical-search.service.ts',
  'services/search/relevance.ts',
  'services/search/offer-context.ts',
  'controllers/search.controller.ts',
];

/**
 * What reaching the fee domain looks like, from any direction: an import of a
 * fee module, a reference to a fee table object, or a raw-SQL mention of the
 * tables themselves.
 */
const FEE_REFERENCE = /fees\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee/;

describe('organic ranking cannot read fee data', () => {
  it('no feed, search or catalogue-read module references the fee domain', () => {
    let scanned = 0;
    for (const relative of RANKING_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scan by having nothing to match.
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        FEE_REFERENCE.test(source),
        `${relative} references the fee domain; ranking must not be able to read fee data`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
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
