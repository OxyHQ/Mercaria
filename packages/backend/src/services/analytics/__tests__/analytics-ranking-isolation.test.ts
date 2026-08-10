/**
 * #77 merchant rule 6 ("a merchant plan or fee schedule cannot buy
 * analytics-derived organic rank"), asserted STRUCTURALLY.
 *
 * `fee-ranking-isolation.test.ts` is the precedent and this is the same shape
 * pointed at a different pair of domains. What it adds is a second wall, because
 * this domain can be abused from two directions and only one of them looks like
 * the fee case:
 *
 *  1. **Ranking must not read analytics.** A feed, search or catalogue module
 *     may reach the EMITTER and the shared-types contract — instrumentation has
 *     to live somewhere — and nothing else in the domain. A ranking function
 *     that could read a rollup, an aggregate or a metric is one line from
 *     ordering by measured popularity, and measured popularity is one join from
 *     "merchants who pay rank higher" (a paying merchant gets more impressions,
 *     which produces more clicks, which the rollup would then feed back into
 *     the ordering).
 *
 *  2. **Analytics must not read commercial standing.** The rollup and the read
 *     surfaces never touch the fee domain, the referral domain or any plan, so a
 *     metric cannot be weighted by what a merchant pays even if somebody wanted
 *     to. The ONE payment import the domain may make is the verified-conversion
 *     seam, which reads `payments`/`orders` for the conversion numerator —
 *     identity rule 8 requires exactly that, and it is named explicitly here so
 *     the exception is a decision rather than a hole.
 *
 * Both scanners carry the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor and a mutation self-test.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The organic discovery surface — the same list `fee-ranking-isolation.test.ts`
 * scans, plus the offer comparison read, which decides what a shopper sees for
 * one product.
 */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'services/offers/offer.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'controllers/offers.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
  'routes/offers.ts',
  'db/catalog/listingRepository.ts',
  'db/offers/offerRepository.ts',
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
];

/**
 * The analytics modules a discovery surface may import — and ONLY these.
 *
 * The emitter and the search instrumentation are the instrumentation seam; the
 * shared-types contract is types. Everything else in the domain reads or
 * computes a measurement, and none of it may be reachable from a module that
 * decides an order.
 */
const ALLOWED_ANALYTICS_IMPORTS = ['analytics/emit', 'analytics/search-instrumentation'];

/** Any import from the analytics domain. */
const ANALYTICS_IMPORT = /from\s+'([^']*analytics\/[^']*)'/g;

/** Reaching commercial standing, from any direction. */
const COMMERCIAL_REFERENCE =
  /\/fees\/|\/referrals\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|referralProgram|referral_programs/;

describe('organic ranking cannot read analytics', () => {
  it('no ranking module imports an analytics module other than the emitter seam', () => {
    let scanned = 0;
    for (const relative of RANKING_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scan by having nothing to match.
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);

      for (const match of source.matchAll(ANALYTICS_IMPORT)) {
        const specifier = match[1] ?? '';
        const permitted = ALLOWED_ANALYTICS_IMPORTS.some((allowed) => specifier.includes(allowed));
        expect(
          permitted,
          `${relative} imports ${specifier}; a ranking module may reach only the analytics ` +
            'emitter seam, or measured popularity becomes an ordering input',
        ).toBe(true);
      }
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
  });

  it('the import detector actually detects — the mutation self-test', () => {
    const forbidden = "import { readRollups } from '../services/analytics/rollup.js';";
    const permitted = "import { emitAnalyticsEvent } from '../services/analytics/emit.js';";
    const irrelevant = "import { getCart } from './cart.service.js';";

    const specifiers = (source: string): string[] =>
      [...source.matchAll(ANALYTICS_IMPORT)].map((m) => m[1] ?? '');

    expect(specifiers(forbidden)).toHaveLength(1);
    expect(
      ALLOWED_ANALYTICS_IMPORTS.some((a) => (specifiers(forbidden)[0] ?? '').includes(a)),
    ).toBe(false);
    expect(
      ALLOWED_ANALYTICS_IMPORTS.some((a) => (specifiers(permitted)[0] ?? '').includes(a)),
    ).toBe(true);
    expect(specifiers(irrelevant)).toHaveLength(0);
  });
});

describe('analytics cannot read commercial standing', () => {
  /**
   * Every module in the domain that COMPUTES or SERVES a number. The emitter
   * and the schema are excluded deliberately — they carry no measurement.
   */
  const MEASUREMENT_PATHS = [
    'services/analytics/rollup.ts',
    'services/analytics/metrics.ts',
    'services/analytics/merchant-analytics.service.ts',
    'services/analytics/operator-analytics.service.ts',
    'services/analytics/experiments.ts',
    'db/analytics/rollupRepository.ts',
    'db/analytics/eventRepository.ts',
    'db/analytics/searchQueryRepository.ts',
  ];

  it('no measurement module references the fee or referral domain', () => {
    let scanned = 0;
    for (const relative of MEASUREMENT_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${relative} references commercial standing; a metric weighted by what a merchant pays ` +
          'is the sale of organic rank one join away',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(MEASUREMENT_PATHS.length);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test(
        "import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';",
      ),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('the ONE payment import is the verified-conversion seam, and it is named', () => {
    // Identity rule 8 REQUIRES this read: the conversion numerator comes from
    // `payments`/`orders` and never from telemetry. Naming the exception here
    // is what keeps it a decision — a second module quietly reaching into the
    // payment domain would fail the scan above without this being stated.
    const seam = readFileSync(
      join(SRC_ROOT, 'services/analytics/verified-conversion.ts'),
      'utf8',
    );
    expect(seam.length).toBeGreaterThan(200);
    expect(seam).toContain("from '../../db/schema/payments.js'");
    expect(seam).toContain("from '../../db/schema/orders.js'");
    // And it reads COUNTS, not money: recomputing an amount here would create a
    // second answer to a question the ledger already owns.
    expect(/amount|currency|minor/i.test(seam.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });
});
