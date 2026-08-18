/**
 * The impact plan is checked against the SCHEMA, not read out of the code
 * (#367 Workstream 12).
 *
 * `impact-plan.ts` declares every foreign key pointing at a governed
 * definition. This walks the drizzle barrel for the same four targets and
 * asserts the plan covers EXACTLY that set — the `merge-plan-census.test.ts`
 * device, which fired on its first rebase when #60 and #121 added eight
 * references between them.
 *
 * **A new table referencing a category, a product-type version, an attribute
 * definition or a navigation tree fails the build here until somebody decides
 * what a governance change does with it.** That is the point. Finding fewer
 * referencing tables looks identical to there BEING fewer, and the number an
 * operator reads before merging two categories is the one that decides whether
 * they press the button.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableName, is } from 'drizzle-orm';
import { PgTable as PgTableClass } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema/index.js';
import {
  GOVERNED_REFERENCE_PLAN,
  GOVERNED_SUBJECT_TABLES,
  referenceKey,
} from '../impact-plan.js';
import { CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS } from '@mercaria/shared-types';

/** Every table the barrel exports. */
function allTables(): PgTable[] {
  return Object.values(schema).flatMap((value) => (is(value, PgTableClass) ? [value as PgTable] : []));
}

/**
 * `table.column` for every foreign key in the schema whose TARGET is
 * `targetTable`.
 *
 * Read off the real drizzle metadata rather than off a hand-maintained list: a
 * gate that skips what a hand-maintained map omits is not a gate, and this is
 * the one place the two could quietly disagree.
 */
function inboundReferences(targetTable: PgTable): string[] {
  const targetName = getTableName(targetTable);
  const found: string[] = [];

  for (const table of allTables()) {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const referencedTable = reference.foreignTable as PgTable;
      if (getTableName(referencedTable) !== targetName) continue;
      for (const column of reference.columns) {
        found.push(`${getTableName(table)}.${column.name}`);
      }
    }
  }

  return [...new Set(found)].sort();
}

describe('the governed-reference census', () => {
  it('walks a schema barrel that is actually populated', () => {
    const tables = allTables();
    // The vacuity floor. A broken import, a moved barrel or an `is` check that
    // stopped matching all report the same clean zero as a correct walk, and
    // every assertion below would then pass by comparing two empty lists.
    // Printed on SUCCESS, not only on failure: a count in a passing run is what
    // makes an unrelated red legible.
    expect(tables.length, `the barrel walk found ${String(tables.length)} tables`).toBeGreaterThan(
      400,
    );
  });

  it('finds real inbound references for every governed subject', () => {
    for (const kind of CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS) {
      const found = inboundReferences(GOVERNED_SUBJECT_TABLES[kind]);
      // The census's own positive control. A `getTableConfig` shape change, a
      // drizzle upgrade that renamed `foreignKeys`, or a target-name comparison
      // that stopped matching would all make `found` empty — and an empty
      // `found` compared against an empty plan would pass.
      expect(
        found.length,
        `${kind}: the census found ${String(found.length)} inbound foreign keys`,
      ).toBeGreaterThan(0);
    }
  });

  it('covers exactly the foreign keys the schema declares, per subject kind', () => {
    for (const kind of CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS) {
      const declared = GOVERNED_REFERENCE_PLAN[kind].map(referenceKey).sort();
      const actual = inboundReferences(GOVERNED_SUBJECT_TABLES[kind]);

      // Exact identity, never containment. A plan that may only grow is the
      // gate switching itself off one defensible entry at a time; a plan that
      // may only shrink stops measuring a real reference silently.
      expect(
        declared,
        `The governance impact plan for ${kind} disagrees with the schema. ` +
          `A new table referencing it needs an entry in services/catalog-governance/impact-plan.ts ` +
          `stating what a governance change does with those rows — blocks, cascades, ` +
          `rewired_by_domain (naming the function) or rewire_path_missing (naming the gap).`,
      ).toEqual(actual);
    }
  });

  it('states a non-empty reason on every declared reference', () => {
    let checked = 0;
    for (const kind of CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS) {
      for (const reference of GOVERNED_REFERENCE_PLAN[kind]) {
        // A disposition with no reason is a decision nobody can check. The
        // `rewired_by_domain` ones in particular claim a function exists.
        expect(reference.note.trim().length, `${referenceKey(reference)} has no reason`).toBeGreaterThan(
          20,
        );
        checked += 1;
      }
    }
    expect(checked, `${String(checked)} declared references carry a reason`).toBeGreaterThan(30);
  });

  it('names the EXACT set of relations nothing rewires', () => {
    // The exact-identity device the reference census uses, pointed at the
    // DISPOSITIONS — because until #587 nothing pinned them, and the two
    // directions this can go wrong are both silent and both bad.
    //
    // Relabelling a real gap as `rewired_by_domain` tells an operator that
    // 1,240 rows will be fixed by something that does not exist, which is the
    // exact reading `unrewiredRowCount` was built to prevent. And leaving a
    // CLOSED gap labelled `rewire_path_missing` is the opposite failure: an
    // operator reading "nothing will rewire these" declines a change that is
    // safe, and a list that only ever grows is a warning about problems
    // somebody solved.
    //
    // So the set is stated, and moving an entry means editing this line with
    // the reason in the diff beside it.
    const missing = CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS.flatMap((kind) =>
      GOVERNED_REFERENCE_PLAN[kind]
        .filter((reference) => reference.disposition === 'rewire_path_missing')
        .map(referenceKey),
    ).sort();

    expect(
      missing,
      'A disposition moved. `rewire_path_missing` names a MEASURED hole: adding one means ' +
        'nothing in this repository fixes those rows after a governance change, and removing ' +
        'one means naming the entry point that now does, in the note.',
    ).toEqual(
      [
        // #91's seller draft pins a category and this domain has no re-pin
        // entry point.
        'seller_listing_drafts.categoryId',
        // #367 workstream 2 owes a copy-forward in `publishProductTypeVersion`;
        // until then a new version leaves every alias on the old one. This
        // entry ARRIVED while #587 was in review, and this assertion is what
        // reported it — which is the case it was written for.
        'product_type_aliases.productTypeDefinitionId',
        // #367 step 4 exposes no re-normalization entry point for assignments
        // already written.
        'native_variant_axis_assignments.attributeDefinitionId',
      ].sort(),
    );

    // `listings.productTypeDefinitionId` was the third until #587, and it is
    // the reason this case exists: closing a gap has to be as visible as
    // opening one. It is now `rewired_by_domain`, and the assertion below is
    // what stops it drifting back to a gap without anybody deciding to.
    const listingPin = GOVERNED_REFERENCE_PLAN.product_type_definition.find(
      (reference) => referenceKey(reference) === 'listings.productTypeDefinitionId',
    );
    expect(listingPin?.disposition, 'the listing product-type pin lost its rewire path').toBe(
      'rewired_by_domain',
    );
    expect(listingPin?.note ?? '').toMatch(/applyListingProductTypeUpgrade/u);
  });

  it('declares no duplicate reference within one subject kind', () => {
    for (const kind of CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS) {
      const keys = GOVERNED_REFERENCE_PLAN[kind].map(referenceKey);
      // A duplicate would double a relation into `impactTotal` and make
      // `relations_counted` a number that agrees with nothing.
      expect(new Set(keys).size, `${kind} declares a relation twice`).toBe(keys.length);
    }
  });

  it('is mutation-tested: a reference removed from the plan fails the comparison', () => {
    // The self-test. Without it, a census whose walk silently returned the plan
    // itself — or one comparing two derived-from-the-same-place lists — would
    // pass on every input.
    const kind = 'category' as const;
    const actual = inboundReferences(GOVERNED_SUBJECT_TABLES[kind]);
    const mutated = GOVERNED_REFERENCE_PLAN[kind].slice(1).map(referenceKey).sort();
    expect(mutated).not.toEqual(actual);
  });
});
