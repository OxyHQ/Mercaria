/**
 * THE POLYMORPHIC CENSUS — the half of #59 merge invariant 2 that has no
 * foreign key to walk (#654).
 *
 * `merge-plan-census.test.ts` derives its population from drizzle FOREIGN KEYS
 * and asserts the rehoming plan covers exactly that set. A polymorphic
 * reference — an id column whose target TABLE is decided by a sibling
 * discriminator — carries no foreign key, because there is nothing for one to
 * point at. So that census cannot see it, and neither can its gate: for a
 * polymorphic reference the "a new table fails the build until somebody
 * decides" property CANNOT FIRE. That is the blind spot, and it is the same
 * silent miss the FK census exists to prevent, arriving through the one door it
 * does not watch.
 *
 * ## The population is DERIVED and deliberately over-wide
 *
 * A column's drizzle `enumValues` is the tuple that renders its `checkOneOf`
 * CHECK, so a discriminator is findable structurally — without reading a NAME,
 * which `~/Oxy/AGENTS.md` forbids deriving a map from. What is NOT available is
 * a clean rule for which enums count, and both candidates were measured:
 *
 *  - **subset** (every value is a mergeable entity type) finds 6 tables and
 *    MISSES `catalog_review_items`, whose `subject_type` is the wider
 *    `CURATION_SUBJECT_TYPES` — dropping every mixed vocabulary, which is where
 *    the review family lives.
 *  - **shares a value** finds 38, of which roughly a dozen hold a real bare
 *    reference.
 *
 * Narrow fails by omitting silently, which is the failure under repair, so this
 * takes the wide rule and requires a DISPOSITION for every member. A table
 * whose enum merely shares a word (`orders.source_channel`,
 * `product_type_fields.flow`) is ticked off once as
 * `not_an_entity_reference` — that is not noise, it is what makes the
 * thirty-ninth impossible to miss.
 *
 * The defences `~/Oxy/AGENTS.md` prescribes are all here: a VACUITY FLOOR on
 * the schema and on the derived set, a POSITIVE CONTROL that the derivation
 * finds each of #654's three named tables, reconciliation in BOTH directions,
 * and a MUTATION SELF-TEST that plants a new matching table and confirms the
 * comparison refuses it BY NAME.
 */

import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable, pgTable, text } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { MERGEABLE_ENTITY_TYPES } from '@mercaria/shared-types';
import * as schema from '../../../db/schema/index.js';
import {
  POLYMORPHIC_ENTITY_REFERENCES,
  type PolymorphicEntityReference,
} from '../merge-plan.js';

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

const MERGEABLE = new Set<string>(MERGEABLE_ENTITY_TYPES as readonly string[]);

/**
 * The tables carrying a column whose closed value set shares at least one value
 * with `MERGEABLE_ENTITY_TYPES`, with the columns that do.
 *
 * `enumValues` is drizzle's own reflection of the tuple it renders the CHECK
 * from, so this cannot disagree with the DDL the way a grep over source could —
 * and it is a property of the SHAPE rather than of a name.
 */
function deriveDiscriminators(pool: readonly PgTable[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const table of pool) {
    const config = getTableConfig(table);
    const hits: string[] = [];
    for (const column of config.columns) {
      const values: readonly string[] | undefined = (column as { enumValues?: readonly string[] })
        .enumValues;
      if (!values || values.length === 0) continue;
      if (values.some((value) => MERGEABLE.has(value))) hits.push(sqlColumnName(column));
    }
    if (hits.length > 0) found.set(getTableName(table), hits);
  }
  return found;
}

/** The comparison both directions run against. */
function reconcile(
  derived: Map<string, string[]>,
  declared: readonly PolymorphicEntityReference[],
): { readonly undeclared: string[]; readonly stale: string[] } {
  const declaredNames = new Set(declared.map((entry) => entry.table));
  return {
    undeclared: [...derived.keys()].filter((name) => !declaredNames.has(name)).sort(),
    stale: declared.map((entry) => entry.table).filter((name) => !derived.has(name)).sort(),
  };
}

describe('every polymorphic reference to a mergeable entity has a decision (#654)', () => {
  const derived = deriveDiscriminators(tables);

  it('is not vacuous: the schema and the derived set are both large', () => {
    // The schema floor catches a broken barrel import — the derived set would
    // then be empty and BOTH reconciliation directions would pass against
    // nothing. The derived floor catches a traversal that stopped reading
    // `enumValues`, which looks identical to a schema with no discriminators.
    expect(tables.length).toBeGreaterThanOrEqual(170);
    expect(derived.size).toBeGreaterThanOrEqual(30);
  });

  it('finds each of the three tables #654 named — the positive control', () => {
    // These are the known answers. A derivation that missed one would agree
    // with a register that also missed it, and the pair would look correct.
    // `catalog_review_items` is the load-bearing one: its discriminator is the
    // WIDER `CURATION_SUBJECT_TYPES`, so it is exactly what a subset rule drops.
    expect(derived.get('catalog_merge_jobs')).toContain('entity_type');
    expect(derived.get('catalog_split_jobs')).toContain('entity_type');
    expect(derived.get('catalog_review_items')).toContain('subject_type');
    expect(derived.get('catalog_review_items')).toContain('counterpart_type');
  });

  it('keeps the derivation over-wide, so a coincidence of vocabulary is ticked off rather than filtered', () => {
    // Deliberate, and asserted so nobody "fixes" it into a subset rule: these
    // two share a word and reference nothing. Their presence is what makes the
    // population complete; their DISPOSITION is what makes them harmless.
    expect(derived.has('orders')).toBe(true);
    expect(derived.has('product_type_fields')).toBe(true);
    const byTable = new Map(POLYMORPHIC_ENTITY_REFERENCES.map((entry) => [entry.table, entry]));
    expect(byTable.get('orders')?.disposition).toBe('not_an_entity_reference');
    expect(byTable.get('product_type_fields')?.disposition).toBe('not_an_entity_reference');
  });

  it('declares every derived table, and declares no table that is no longer derived', () => {
    const { undeclared, stale } = reconcile(derived, POLYMORPHIC_ENTITY_REFERENCES);

    expect(
      undeclared,
      'these tables carry a column whose value set overlaps MERGEABLE_ENTITY_TYPES and ' +
        'POLYMORPHIC_ENTITY_REFERENCES does not say what a merge does with them. Add an entry to ' +
        '`merge-plan.ts`: `not_an_entity_reference` if the enum merely shares a word, ' +
        '`discriminates_foreign_keys` if the real reference is FK\'d and the FK census owns it, ' +
        'or `untouched`/`rehomed` with the id columns named.',
    ).toEqual([]);

    expect(
      stale,
      'these tables are declared here and the derivation no longer finds them. A stale ' +
        'declaration is an exemption that can never fire — the shape this domain has already ' +
        'paid for once — so remove the entry rather than leaving it to look like coverage.',
    ).toEqual([]);
  });

  it('names the id columns exactly when the disposition is about a real reference', () => {
    const wrong = POLYMORPHIC_ENTITY_REFERENCES.filter((entry) => {
      const needsColumns = entry.disposition === 'untouched' || entry.disposition === 'rehomed';
      const hasColumns = (entry.idColumns?.length ?? 0) > 0;
      return needsColumns !== hasColumns;
    }).map((entry) => `${entry.table} (${entry.disposition})`);

    // An entry claiming a merge leaves a reference alone has to say WHICH
    // reference, or it is a sentence rather than a decision; and one claiming
    // there is no reference must not name columns, or the two dispositions stop
    // meaning different things.
    expect(wrong).toEqual([]);
  });

  it('gives every entry a real reason', () => {
    const thin = POLYMORPHIC_ENTITY_REFERENCES.filter((entry) => entry.reason.trim().length < 40)
      .map((entry) => entry.table);
    expect(thin).toEqual([]);
  });

  it('declares each table exactly once', () => {
    const names = POLYMORPHIC_ENTITY_REFERENCES.map((entry) => entry.table);
    expect(names.length).toBe(new Set(names).size);
  });

  describe('the self-tests — each detector is shown to fail', () => {
    /** A table nobody has declared, carrying a discriminator over a mergeable type. */
    const planted = pgTable('mercaria_planted_polymorphic_table', {
      id: text().primaryKey(),
      subjectKind: text({ enum: ['canonical_product', 'something_else'] }).notNull(),
      subjectRef: text().notNull(),
    });

    it('refuses a NEW polymorphic table BY NAME', () => {
      // The mutation the whole file exists for. It runs against the real
      // derivation over the real schema plus one planted table, so what is
      // measured is the code that runs in CI rather than a reimplementation.
      const withPlanted = deriveDiscriminators([...tables, planted]);
      expect(withPlanted.get('mercaria_planted_polymorphic_table')).toEqual(['subject_kind']);

      const { undeclared, stale } = reconcile(withPlanted, POLYMORPHIC_ENTITY_REFERENCES);
      expect(undeclared).toEqual(['mercaria_planted_polymorphic_table']);
      expect(stale).toEqual([]);
    });

    it('refuses a STALE declaration BY NAME', () => {
      const withGhost = [
        ...POLYMORPHIC_ENTITY_REFERENCES,
        {
          table: 'mercaria_table_that_no_longer_exists',
          disposition: 'not_an_entity_reference',
          reason: 'a declaration whose table the derivation no longer finds, planted by this test',
        } satisfies PolymorphicEntityReference,
      ];
      const { undeclared, stale } = reconcile(derived, withGhost);
      expect(stale).toEqual(['mercaria_table_that_no_longer_exists']);
      expect(undeclared).toEqual([]);
    });

    it('would NOT find a table whose enum shares nothing — the negative control', () => {
      // Without this, "the derivation found my planted table" would also be
      // satisfied by a derivation that returns every table it is handed.
      const unrelated = pgTable('mercaria_planted_unrelated_table', {
        id: text().primaryKey(),
        kind: text({ enum: ['alpha', 'beta'] }).notNull(),
      });
      const withUnrelated = deriveDiscriminators([...tables, unrelated]);
      expect(withUnrelated.has('mercaria_planted_unrelated_table')).toBe(false);
      expect(reconcile(withUnrelated, POLYMORPHIC_ENTITY_REFERENCES).undeclared).toEqual([]);
    });
  });
});
