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
  type LegacyTargetRef,
  legacyCatalogColumnKeys,
  renderTargetRef,
  targetColumn,
} from '../mapping-matrix.js';
import {
  nativeListingVariantAxes,
  nativeVariantAxisAssignments,
} from '../../../db/schema/variantAxes.js';

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

    // The probe names a column that CANNOT exist, and that is not fussiness.
    // It used to be `listings.productTypeDefinitionId`, chosen because no such
    // column existed — and #367 box 11 then added it for real and gave it a
    // disposition, at which point the probe stopped being undecided and this
    // self-test silently measured nothing. A synthetic probe that names a
    // plausible future column is a control with an expiry date on it.
    const PROBE = 'listings.__columnThatCannotExist';
    const withNewColumn = [...real, PROBE];
    expect(withNewColumn.length, 'the mutation did not land').toBe(real.length + 1);
    expect(partitionGaps(withNewColumn).undecided).toEqual([PROBE]);

    const withoutVendor = real.filter((key) => key !== 'listings.vendor');
    expect(withoutVendor.length, 'the mutation did not land').toBe(real.length - 1);
    expect(partitionGaps(withoutVendor).stale).toEqual(['listings.vendor']);
  });

  it('holds the mapped and excluded counts exactly', () => {
    // Exact counts beside the partition, because a partition can stay complete
    // while a column MOVES from mapped to excluded — which is the one edit that
    // would quietly take a catalog concept out of the migration's scope.
    expect(LEGACY_CATALOG_COLUMNS).toHaveLength(10);
    expect(Object.keys(LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT)).toHaveLength(47);
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

  it('gives every mapped column a resolvable target and a note', () => {
    // Until #551 this asserted `entry.target.trim().length > 10` — the FORM of
    // the target rather than its EXISTENCE. It passed on
    // `native_variant_axis_assignments.position`, a column that does not exist
    // and that no migration ever added, and would have gone on passing forever.
    //
    // Existence is now the TYPE's job: `targetColumn` derives its column
    // parameter from the table's own column map, so a column that does not
    // exist is a compile error. What is left for runtime is the part a cast
    // could still get past, plus the emptiness the type cannot express.
    let carriedRefs = 0;
    for (const entry of LEGACY_CATALOG_COLUMNS) {
      const where = `${entry.table}.${entry.column}`;
      expect(entry.note.trim().length, `${where} has no note`).toBeGreaterThan(30);

      if (entry.target.kind === 'not_carried') {
        expect(entry.target.because.trim().length, `${where} says why it is not carried`)
          .toBeGreaterThan(20);
        continue;
      }

      expect(entry.target.refs.length, `${where} is carried nowhere in particular`)
        .toBeGreaterThan(0);
      for (const ref of entry.target.refs) {
        // `renderTargetRef` throws on a column the table does not have, which is
        // what a `as never` cast past the type gate would leave behind.
        const rendered = renderTargetRef(ref);
        expect(rendered, `${where} has an unrenderable target`).toMatch(
          /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/u,
        );
        if (ref.column !== undefined) {
          expect(
            Object.keys(getTableColumns(ref.table)),
            `${where} names a column its table does not have`,
          ).toContain(ref.column);
        }
        carriedRefs += 1;
      }
    }
    // The vacuity floor. Every branch above is inside a loop, so a matrix that
    // stopped carrying anything anywhere would satisfy all of them silently.
    expect(carriedRefs, 'no mapped column names a target at all').toBeGreaterThan(9);
  });

  it('holds the carried / not-carried split exactly', () => {
    // Beside the partition, for the `LEGACY_CATALOG_COLUMNS` count's reason: an
    // entry can flip from `carried` to `not_carried` without changing any count
    // above, and that flip takes a concept out of the migration's scope.
    const notCarried = LEGACY_CATALOG_COLUMNS.filter((e) => e.target.kind === 'not_carried');
    expect(notCarried.map((e) => `${e.table}.${e.column}`)).toEqual([
      'product_variant_option_values.position',
    ]);
  });

  it('the target gate fires on a column the table does not have', () => {
    // The mutation self-test for the runtime half. The type gate is proven
    // separately and cannot be proven from inside vitest — a column that does
    // not exist is a COMPILE error, so the adverse input has to be cast past it,
    // which is exactly the case this assertion is here to catch.
    const bogus = { table: nativeVariantAxisAssignments, column: 'position' } as LegacyTargetRef;
    expect(() => renderTargetRef(bogus)).toThrow(/has no column position/u);

    // The control: the sibling that DOES exist renders, so the assertion above
    // is about this column rather than about `renderTargetRef` always throwing.
    expect(renderTargetRef(targetColumn(nativeListingVariantAxes, 'position'))).toBe(
      'native_listing_variant_axes.position',
    );
  });
});
