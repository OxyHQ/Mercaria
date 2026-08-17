/**
 * The mapping matrix is a PARTITION of the legacy tables, checked against the
 * real drizzle schema (#367 workstream 13).
 *
 * ## What this protects, and why a runtime test cannot
 *
 * "Audit all current category, product type, vendor/brand, option and variant
 * fields" is a requirement whose failure is silent: a matrix somebody wrote once
 * covers the columns that existed the day they wrote it, and a hole in a map
 * reads exactly like flat ground. Nothing at runtime notices that a migration's
 * inventory stopped covering the catalogue — every job still runs, every report
 * still prints, and the column nobody decided about is simply never mentioned.
 *
 * So every column of `listings`, `listing_options` and
 * `product_variant_option_values` must be either MAPPED to a subject or
 * EXCLUDED with a stated reason, and the union must be the table's whole column
 * set. `merge-plan-census.test.ts`'s device, applied to a migration rather than
 * to a merge, and with the same intended consequence: **a column added to
 * `listings` fails this build until somebody decides what the migration does
 * with it.**
 *
 * The one that will fire first is known and welcome. ADR 0007 D13 assigns
 * `listings.product_type_definition_id` to the authoring workstream; when it
 * lands, this test goes red with a message saying the product-type classifier
 * has a column to write into at last.
 *
 * ## Why the reasons are a closed vocabulary rather than free text
 *
 * A one-word reason per column can be counted and read as a group, and it cannot
 * be left blank. Free text would let `'TODO'` and `''` both look like decisions.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { LEGACY_CATALOG_SUBJECT_KINDS } from '@mercaria/shared-types';
import {
  LEGACY_CATALOG_COLUMNS,
  LEGACY_CATALOG_TABLES,
  LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT,
  LEGACY_COLUMN_EXCLUSIONS,
  legacyCatalogColumnKeys,
} from '../mapping-matrix.js';

/** `<table>.<column>` for every column the matrix maps to a subject. */
function mappedKeys(): readonly string[] {
  return LEGACY_CATALOG_COLUMNS.map((entry) => `${entry.table}.${entry.column}`);
}

/**
 * The two directions the partition can be broken in, as a pure function so the
 * mutation self-test can feed it a doctored column set.
 *
 * `undecided` is a real column nobody classified — the failure this gate exists
 * for. `stale` is a matrix entry naming a column that no longer exists, which is
 * the quieter half: a stale entry decides nothing and reads exactly like a
 * correct one, and it is how a rename turns a covered column into an uncovered
 * one with the map still looking full.
 */
function partitionGaps(realColumnKeys: readonly string[]): {
  undecided: string[];
  stale: string[];
} {
  const real = new Set(realColumnKeys);
  const decided = new Set([...mappedKeys(), ...Object.keys(LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT)]);
  return {
    undecided: [...real].filter((key) => !decided.has(key)).sort(),
    stale: [...decided].filter((key) => !real.has(key)).sort(),
  };
}

describe('the legacy column partition', () => {
  it('reads a real, non-trivial column set off the drizzle tables', () => {
    // The vacuity floor. A broken walk, a renamed export or a drizzle version
    // that stopped answering `getTableColumns` all report an empty set, and
    // every assertion below would pass on it — an empty partition is trivially
    // complete. The floor is printed on SUCCESS by being the assertion itself.
    const keys = legacyCatalogColumnKeys();
    expect(keys.length, 'the column walk found almost nothing — did the schema move?')
      .toBeGreaterThan(40);
    expect(Object.keys(LEGACY_CATALOG_TABLES)).toEqual([
      'listings',
      'listing_options',
      'product_variant_option_values',
    ]);
    for (const [name, table] of Object.entries(LEGACY_CATALOG_TABLES)) {
      expect(Object.keys(getTableColumns(table)).length, `${name} has no columns`).toBeGreaterThan(
        4,
      );
    }
  });

  it('decides every column, and names no column that does not exist', () => {
    const gaps = partitionGaps(legacyCatalogColumnKeys());
    expect(
      gaps.undecided,
      'a legacy column carries no disposition, which means it is a decision nobody has made — ' +
        'and a column nobody decided about is indistinguishable, from every report this domain ' +
        'produces, from one the migration deliberately leaves alone. Either is fine; leaving it ' +
        'unstated is not. Add it to LEGACY_CATALOG_COLUMNS with its subject and target, or to ' +
        'LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT with a reason — `untouched` WITH A REASON is an ' +
        'acceptable disposition and silence is not (#367 workstream 13)',
    ).toEqual([]);
    expect(
      gaps.stale,
      'the matrix names a column that no longer exists. A stale entry decides nothing and reads ' +
        'exactly like a correct one',
    ).toEqual([]);
  });

  it('has a partition check that actually fires, in both directions', () => {
    // The mutation self-test. Both mutations are applied to the INPUT of the
    // real function rather than to a copy of its logic, so a `partitionGaps`
    // that had stopped comparing would fail here rather than going on reporting
    // a tidy empty pair.
    const real = legacyCatalogColumnKeys();

    const withNewColumn = [...real, 'listings.productTypeDefinitionId'];
    expect(withNewColumn.length, 'the mutation did not land').toBe(real.length + 1);
    expect(partitionGaps(withNewColumn).undecided).toEqual(['listings.productTypeDefinitionId']);

    const withoutVendor = real.filter((key) => key !== 'listings.vendor');
    expect(withoutVendor.length, 'the mutation did not land').toBe(real.length - 1);
    expect(partitionGaps(withoutVendor).stale).toEqual(['listings.vendor']);
  });

  it('holds the mapped and excluded counts exactly', () => {
    // Exact counts beside the partition, because a partition can stay complete
    // while a column MOVES from mapped to excluded — which is the one edit that
    // would quietly take a catalog concept out of the migration's scope.
    expect(LEGACY_CATALOG_COLUMNS).toHaveLength(10);
    expect(Object.keys(LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT)).toHaveLength(46);
    expect(mappedKeys().length, 'a column is mapped twice').toBe(new Set(mappedKeys()).size);
  });

  it('names every subject at least once, and every exclusion reason is a legal one', () => {
    const subjectsInMatrix = new Set(LEGACY_CATALOG_COLUMNS.map((entry) => entry.subject));
    for (const subject of LEGACY_CATALOG_SUBJECT_KINDS) {
      expect(
        subjectsInMatrix.has(subject),
        `${subject} is a legacy subject with no column behind it — the inventory has a hole`,
      ).toBe(true);
    }
    const legal = new Set<string>(LEGACY_COLUMN_EXCLUSIONS);
    for (const [key, reason] of Object.entries(LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT)) {
      expect(legal.has(reason), `${key} carries an unknown exclusion reason`).toBe(true);
    }
  });

  it('gives every mapped column a non-empty target and note', () => {
    // A matrix entry with an empty target decides nothing while occupying the
    // slot of a decision, which is the free-text failure the closed exclusion
    // vocabulary avoids on the other side of the partition.
    for (const entry of LEGACY_CATALOG_COLUMNS) {
      expect(entry.target.trim().length, `${entry.table}.${entry.column} has no target`)
        .toBeGreaterThan(10);
      expect(entry.note.trim().length, `${entry.table}.${entry.column} has no note`)
        .toBeGreaterThan(30);
    }
  });
});
