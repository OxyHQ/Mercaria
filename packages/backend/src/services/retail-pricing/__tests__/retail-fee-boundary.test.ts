/**
 * #120 test case 15 and acceptance criterion 9: the marketplace fee (#88) is
 * NOT applied to `mercaria_retail`.
 *
 * Asserted from three directions, because the interesting failure is not "the
 * fee was calculated wrong" — it is "somebody wired the fee domain into retail
 * pricing later and nothing noticed".
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { RETAIL_ACCOUNTING_OUTPUTS } from '@mercaria/shared-types';
import { notApplicableFeeSnapshot } from '../../fees/order-fees.service.js';
import { retailCostQuotes } from '../../../db/schema/retailPricing.js';

const RETAIL_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');

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

describe('the marketplace fee is structurally not applicable to mercaria_retail', () => {
  it('a mercaria_retail fee snapshot carries NO fee — a NULL, never a zero', () => {
    const snapshot = notApplicableFeeSnapshot('mercaria_retail');
    expect(snapshot.commercialMode).toBe('mercaria_retail');
    expect(snapshot.result).toBe('not_applicable');
    // Absent, not zero: a zero would read as a schedule that calculated one.
    expect(snapshot.fee).toBeUndefined();
    expect(snapshot.basisAmount).toBeUndefined();
    expect(snapshot.scheduleKey).toBeUndefined();
  });

  it('the retail pricing engine cannot REACH the fee domain', () => {
    // The stronger statement: a marketplace fee cannot appear in a retail cost
    // quote because no module in this directory can import the code that would
    // compute one — the `role-separation` gate's shape, one domain over.
    const files = sourceFiles(RETAIL_DIR);
    expect(files.length, 'the retail-pricing directory scanned no files').toBeGreaterThanOrEqual(6);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (/\/fees\/|fee-calculation|order-fees|feeSchedule/.test(specifier)) {
          offenders.push(`${relative(RETAIL_DIR, file)} imports '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a retail cost quote has no column a marketplace fee could be stored in', () => {
    const columns = Object.keys(getTableColumns(retailCostQuotes));
    expect(columns.length).toBeGreaterThan(20);
    for (const column of columns) {
      expect(/fee|commission|schedule/i.test(column), `${column} smells like a fee`).toBe(false);
    }
    // And no accounting output is a marketplace commission either.
    expect(RETAIL_ACCOUNTING_OUTPUTS).not.toContain('commission_revenue');
  });

  it('the detector actually detects — the mutation self-test', () => {
    // A rotted specifier regex would pass the scan above by matching nothing.
    const seeded = "import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';";
    expect(/\/fees\/|fee-calculation|order-fees|feeSchedule/.test(seeded)).toBe(true);
    expect(
      /\/fees\/|fee-calculation|order-fees|feeSchedule/.test(
        "import { convert } from '../fx.service.js';",
      ),
    ).toBe(false);
  });
});
