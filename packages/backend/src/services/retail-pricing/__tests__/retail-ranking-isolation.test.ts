/**
 * #120's ranking boundary and referral boundary, asserted STRUCTURALLY — the
 * `fee-ranking-isolation.test.ts` gate, applied to retail cost.
 *
 * "Neither lower direct cost nor absorbed Mercaria variance may be manipulated
 * to buy ranking." A ranking function that cannot REACH retail cost data cannot
 * rank by it, which is a stronger statement than any behavioural fixture could
 * make. The same wall runs in the other direction for referrals: the retail
 * pricing engine cannot reach the referral domain, so a referral expense has no
 * import path into a customer amount.
 *
 * Built with the AGENTS.md gate defences: a vacuity floor (every scanned file
 * must exist and be non-trivial, so a moved file fails the gate instead of
 * silently shrinking it) and a mutation self-test (the detector is run against a
 * seeded positive, so a broken regex cannot pass by matching nothing).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RETAIL_DIR = join(SRC_ROOT, 'services', 'retail-pricing');


/**
 * What reaching retail cost data looks like, from any direction: an import of a
 * retail-pricing module, a reference to one of its table objects or DTOs, or a
 * raw-SQL mention of the tables themselves.
 */
const RETAIL_COST_REFERENCE =
  /retail-pricing\/|retailPricing|RetailCostQuote|retailCostQuote|retail_cost_quote|retail_pricing_policies|absorbedVariance|absorption_cap/;

/** Every non-test `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('organic ranking cannot read retail cost data', () => {
  it('no feed, search or catalogue-read module references the retail pricing domain', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relativePath of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relativePath);
      expect(
        RETAIL_COST_REFERENCE.test(source),
        `${relativePath} references retail cost data; ranking must not be able to read it`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });

  it('the detector actually detects — the mutation self-test', () => {
    const seeded =
      "import { composeRetailCostQuote } from '../retail-pricing/retail-cost-quote.service.js';";
    expect(RETAIL_COST_REFERENCE.test(seeded)).toBe(true);
    expect(RETAIL_COST_REFERENCE.test('select * from retail_cost_quotes')).toBe(true);
    expect(RETAIL_COST_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);
  });

  it('a retail pricing policy cannot scope on anything a ranking function reads', () => {
    // The reverse direction of the same wall. A policy version approves
    // COMPONENT KINDS and bounds Mercaria's own absorption; it has no field for
    // sales volume, plan tier, placement or any figure ranking also consumes —
    // so "cost less, rank higher" has nowhere to live.
    const source = readFileSync(join(SRC_ROOT, 'db', 'schema', 'retailPricing.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(1_000);
    for (const shape of ['salesVolume', 'placement', 'boost', 'rankingWeight', 'planTier']) {
      expect(source.includes(shape), `retailPricing.ts declares ${shape}`).toBe(false);
    }
  });
});

describe('the retail price cannot contain referral or affiliate economics', () => {
  it('nothing in services/retail-pricing imports the referral domain', () => {
    const files = sourceFiles(RETAIL_DIR);
    // Vacuity floor: the retail-pricing domain has real files to scan.
    expect(files.length).toBeGreaterThanOrEqual(6);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (/referral/i.test(specifier)) {
          offenders.push(`${relative(RETAIL_DIR, file)} imports '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing in services/referrals imports the retail pricing domain', () => {
    const files = sourceFiles(join(SRC_ROOT, 'services', 'referrals'));
    expect(files.length).toBeGreaterThanOrEqual(3);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (/retail-pricing|retailPricing/.test(specifier)) {
          offenders.push(`${relative(SRC_ROOT, file)} imports '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no retail-pricing module names FairCoin or OxyPay — no conversion bridge exists', () => {
    // #120 currency rule 4 and ADR 0004 D11.3: nothing here anticipates them,
    // and no conversion is routed through a pivot this domain names. The FX
    // service's own pivot is its private business and is never asked for here.
    const files = sourceFiles(RETAIL_DIR);
    expect(files.length).toBeGreaterThanOrEqual(6);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // The docblocks legitimately say "names FAIR" while explaining the rule,
      // so match a CODE-shaped occurrence: a quoted literal or a member access.
      if (/'FAIR'|"FAIR"|OxyPay|oxy_pay|FairCoin/.test(source)) {
        offenders.push(relative(RETAIL_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
