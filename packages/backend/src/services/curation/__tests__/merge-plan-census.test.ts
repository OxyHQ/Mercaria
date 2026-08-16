/**
 * THE CENSUS — the gate that makes #59 merge invariant 2 checkable.
 *
 * "Source mappings, offers, relationships, price history, reviews, product
 * saves, alerts and watchlists are rehomed idempotently" is a claim about
 * COMPLETENESS, and completeness is exactly what nobody can verify by reading a
 * merge implementation. Finding fewer referencing tables looks identical to
 * there BEING fewer (`~/Oxy/AGENTS.md`, the git-pathspec and Mongo-reader
 * findings), and the miss is silent: the orphaned rows keep pointing at a
 * tombstone nobody reads, and a seller discovers it months later.
 *
 * So this walks the DRIZZLE SCHEMA — the same objects drizzle-kit generates DDL
 * from — for every foreign key targeting a mergeable entity, and asserts the
 * rehoming plan covers exactly that set. A new table referencing
 * `canonical_products` fails the build until somebody decides what a merge does
 * with it, which forces the decision at the moment the reference is added, by
 * the person adding it.
 *
 * The defences `~/Oxy/AGENTS.md` prescribes for a scan that answers "is anything
 * still using this?" are all here:
 *
 *  - a VACUITY FLOOR on the schema size and on the census size, so a broken
 *    traversal fails instead of reporting a clean plan;
 *  - a POSITIVE CONTROL that the census finds a known-nested reference AND a
 *    known reference from a table declared in a different module;
 *  - a MUTATION SELF-TEST: removing an entry from a copy of the plan must make
 *    the comparison fail, and naming a column that does not exist must too.
 */

import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { MERGEABLE_ENTITY_TYPES, type MergeableEntityType } from '@mercaria/shared-types';
import * as schema from '../../../db/schema/index.js';
import { MERGE_REHOMING_PLAN, rehomeTargetKey } from '../merge-plan.js';
import { CURATED_ENTITIES } from '../entity-registry.js';

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/** The Postgres table name of each mergeable entity, by type. */
const TARGET_TABLE: Readonly<Record<MergeableEntityType, string>> = Object.fromEntries(
  MERGEABLE_ENTITY_TYPES.map((type) => [type, getTableName(CURATED_ENTITIES[type].table)]),
) as Record<MergeableEntityType, string>;

/**
 * Walk every foreign key in the schema and group the referencing columns by the
 * mergeable entity they point at.
 *
 * `getTableConfig(...).foreignKeys` is drizzle's own reflection of what it will
 * emit, so this cannot disagree with the DDL the way a grep over source could.
 */
function censusReferences(): Map<MergeableEntityType, Set<string>> {
  const byEntity = new Map<MergeableEntityType, Set<string>>();
  for (const type of MERGEABLE_ENTITY_TYPES) byEntity.set(type, new Set());
  const targetToType = new Map<string, MergeableEntityType>(
    MERGEABLE_ENTITY_TYPES.map((type) => [TARGET_TABLE[type], type]),
  );

  for (const table of tables) {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const type = targetToType.get(getTableName(reference.foreignTable));
      if (!type) continue;
      for (const column of reference.columns) {
        // `sqlColumnName`, not `column.name`: the casing is set on the drizzle
        // INSTANCE, so `column.name` is the TypeScript key. Using it would still
        // compare consistently and would name columns nobody can grep for.
        byEntity.get(type)?.add(`${config.name}.${sqlColumnName(column)}`);
      }
    }
  }
  return byEntity;
}

/** The plan's own coverage, as the same `table.column` keys. */
function planKeys(type: MergeableEntityType): Set<string> {
  return new Set(MERGE_REHOMING_PLAN[type].map((target) => rehomeTargetKey(target.column)));
}

describe('the rehoming plan covers every reference to a mergeable entity', () => {
  const census = censusReferences();

  it('is not vacuous: the schema and the census are both large', () => {
    // The schema floor catches a broken barrel import; the census floor catches
    // a traversal that found no foreign keys at all, which would make every
    // per-entity comparison below pass against two empty sets.
    expect(tables.length).toBeGreaterThanOrEqual(170);
    const total = [...census.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBeGreaterThanOrEqual(70);
  });

  it('finds references declared in OTHER schema modules, not only the entity own file', () => {
    // The positive control. `canonical_products` is declared in
    // `canonicalCatalog.ts`; these two references are declared in `reviews.ts`
    // and `matching.ts`, so a census that only walked one module would miss
    // them — and would then agree with a plan that also only covered one.
    const products = census.get('canonical_product');
    expect(products).toBeDefined();
    expect(products?.has('reviews.canonical_product_id')).toBe(true);
    expect(products?.has('match_decisions.matched_canonical_product_id')).toBe(true);
    // And the self-reference, which is the one a naive walk most often drops.
    expect(products?.has('canonical_products.merged_into_id')).toBe(true);
  });

  for (const type of MERGEABLE_ENTITY_TYPES) {
    it(`covers every ${type} reference, and names no column that does not reference one`, () => {
      const referenced = census.get(type) ?? new Set<string>();
      const planned = planKeys(type);

      const missing = [...referenced].filter((key) => !planned.has(key)).sort();
      const extra = [...planned].filter((key) => !referenced.has(key)).sort();

      expect(
        missing,
        `these columns reference a ${type} and the merge plan does not say what happens to them. ` +
          'Add an entry to MERGE_REHOMING_PLAN — including `untouched` with a reason, which is a ' +
          'decision the census accepts and silence is not.',
      ).toEqual([]);
      expect(
        extra,
        `the merge plan names these columns for ${type} and no foreign key of theirs points at ` +
          'one. Either the reference was removed (delete the plan entry) or the entry names the ' +
          'wrong column, in which case the merge has been moving nothing.',
      ).toEqual([]);
      expect(referenced.size).toBeGreaterThan(0);
    });
  }

  it('gives every conflict-gated entry a conflict kind, and every guarded entry its unique', () => {
    for (const type of MERGEABLE_ENTITY_TYPES) {
      for (const target of MERGE_REHOMING_PLAN[type]) {
        const key = rehomeTargetKey(target.column);
        if (target.disposition === 'conflict_gated') {
          expect(target.conflictKind, `${key} is conflict-gated with no conflict kind`).toBeDefined();
        }
        if (target.disposition === 'repoint_if_absent' || target.disposition === 'repoint_or_supersede') {
          expect(
            target.uniqueWith?.length ?? 0,
            `${key} guards against a unique it does not name; the guard would then be a no-op`,
          ).toBeGreaterThan(0);
        }
        if (target.disposition === 'repoint_or_supersede') {
          expect(target.statusColumn, `${key} supersedes with no status column`).toBeDefined();
          expect(target.supersededStatus, `${key} supersedes with no superseded value`).toBeDefined();
        }
        expect(target.note.length, `${key} has no reason recorded`).toBeGreaterThan(20);
      }
    }
  });

  /**
   * #333, as a rule rather than as two fixed entries.
   *
   * `reviews_author_scope_target_key` is `(author_oxy_user_id, scope,
   * target_key)` where `target_key` is GENERATED over every target column — so
   * ANY `reviews` column a merge repoints can collide when one buyer reviewed
   * both sides, whatever entity is being merged. Two of them exist today
   * (`canonical_product_id`, `merchant_id`) and a realdb case drives the first;
   * this is what makes the second, and a third nobody has written, fail the
   * build instead of raising 23505 in front of an operator.
   *
   * The guard columns are asserted by NAME because they are what makes the
   * absence guard exact: guarding on the author alone would refuse to move a
   * review of a different scope, and on the scope alone would refuse to move
   * every other buyer's.
   */
  it('#333: no `reviews` column is repointed unguarded, and every guard names author and scope', () => {
    let checked = 0;
    for (const type of MERGEABLE_ENTITY_TYPES) {
      for (const target of MERGE_REHOMING_PLAN[type]) {
        if (getTableName(target.column.table) !== 'reviews') continue;
        checked += 1;
        const key = `${type}: ${rehomeTargetKey(target.column)}`;
        expect(
          target.disposition,
          `${key} moves a component of \`reviews_author_scope_target_key\`. An unguarded move ` +
            'raises 23505 the moment one buyer reviewed both sides of the merge (#333).',
        ).toBe('repoint_if_absent');
        const guarded = (target.uniqueWith ?? []).map((column) => sqlColumnName(column)).sort();
        expect(guarded, `${key} guards on the wrong columns`).toEqual(['author_oxy_user_id', 'scope']);
      }
    }
    // The vacuity floor: "every reviews column is guarded" is also what a loop
    // that found none reports.
    expect(checked, 'the plan names no `reviews` column at all — did the table move?').toBe(2);
  });

  it('MUTATION SELF-TEST: a dropped plan entry is caught, and so is an invented one', () => {
    // A census that compared nothing would pass every assertion above. These two
    // mutations are what prove it does not.
    const referenced = census.get('canonical_product') ?? new Set<string>();
    const planned = planKeys('canonical_product');

    const withOneDropped = new Set(planned);
    withOneDropped.delete('reviews.canonical_product_id');
    expect([...referenced].filter((key) => !withOneDropped.has(key))).toEqual([
      'reviews.canonical_product_id',
    ]);

    const withOneInvented = new Set(planned);
    withOneInvented.add('orders.canonical_product_id');
    expect([...withOneInvented].filter((key) => !referenced.has(key))).toEqual([
      'orders.canonical_product_id',
    ]);
  });

  it('MERGE INVARIANT 3: no plan entry names an order or a listing table', () => {
    // "Native listing and placed-order ids do not change" is structural rather
    // than promised: a merge only ever writes columns the plan names, and no
    // plan names one of these. The census above is what stops a future
    // reference to `orders` being added to a plan quietly, and this is what
    // stops it being added deliberately.
    const forbidden = ['orders', 'order_items', 'listings', 'product_variants', 'payments', 'refunds'];
    for (const type of MERGEABLE_ENTITY_TYPES) {
      for (const target of MERGE_REHOMING_PLAN[type]) {
        const table = getTableName(target.column.table);
        expect(
          forbidden.includes(table),
          `the ${type} merge plan names ${rehomeTargetKey(target.column)}; a canonical merge must ` +
            'never touch the native catalogue or a placed order (#59 merge invariant 3).',
        ).toBe(false);
      }
    }
  });
});
