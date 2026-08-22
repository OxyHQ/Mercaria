/**
 * Epic #367 line 143 — the population half.
 *
 * "Support category-specific overrides ONLY through explicit, versioned rules"
 * is a claim about completeness, and completeness is what nobody verifies by
 * reading a schema: finding fewer category-scoped tables looks exactly like
 * there BEING fewer, and the miss is silent — somebody adds a table that says
 * something about one category, nothing enforces a version on it, and the first
 * symptom is a published contract that quietly means something different than
 * it did when a seller authored against it.
 *
 * So the POPULATION is walked out of the drizzle schema and the DISPOSITION is
 * declared in `categoryScopeFreeze.ts`. This file asserts the declaration covers
 * EXACTLY the walk, both ways, with vacuity floors and mutation self-tests per
 * detector. `category-scope-freeze.realdb.test.ts` then EXECUTES every
 * `frozen_with_its_version` entry against a real server, because a trigger that
 * exists and permits everything reads identically to one that works.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index.js';
import {
  CATEGORY_SCOPE_DISPOSITIONS,
  deriveCategoryScopedDefinitionTables,
  deriveVersionedDefinitionTables,
  type CategoryScopeDisposition,
} from '../categoryScopeFreeze.js';

const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/**
 * The schema is this big.
 *
 * Not an exact count — this file has no opinion about how many tables Mercaria
 * has and pinning one would conflict on every unrelated branch. What it defends
 * against is a barrel that stopped exporting, at which point every derivation
 * below returns the empty set and the census passes by measuring nothing.
 */
const SCHEMA_TABLE_FLOOR = 300;

/** Measured at the time of writing: 5. A floor, for the reason above. */
const POPULATION_FLOOR = 5;

/**
 * And at least this many must actually be FROZEN.
 *
 * The floor that matters. A declaration where everything is `subject_not_a_rule`
 * would pass every coverage assertion in this file and drive an empty realdb
 * half — the shape of a gate that measures nothing. Measured: 2.
 */
const FROZEN_FLOOR = 2;

function dispositionsFor(entries: readonly CategoryScopeDisposition[]): Map<
  string,
  CategoryScopeDisposition
> {
  return new Map(entries.map((entry) => [entry.table, entry]));
}

/** The same comparison the census makes, factored out so a mutation can drive it. */
function coverageGaps(
  population: readonly { readonly table: string }[],
  declared: readonly CategoryScopeDisposition[],
): { readonly undeclared: readonly string[]; readonly extra: readonly string[] } {
  const declaredNames = new Set(declared.map((entry) => entry.table));
  const populationNames = new Set(population.map((entry) => entry.table));
  return {
    undeclared: [...populationNames].filter((table) => !declaredNames.has(table)).sort(),
    extra: [...declaredNames].filter((table) => !populationNames.has(table)).sort(),
  };
}

/** The shape rule: a RULE has one row per (version, category); a SUBJECT does not. */
function shapeGaps(
  population: readonly { readonly table: string; readonly hasScopeUnique: boolean }[],
  declared: readonly CategoryScopeDisposition[],
): readonly string[] {
  const byTable = dispositionsFor(declared);
  const wrong: string[] = [];
  for (const entry of population) {
    const disposition = byTable.get(entry.table);
    if (disposition === undefined) continue;
    const shouldHaveUnique = disposition.kind === 'frozen_with_its_version';
    if (entry.hasScopeUnique !== shouldHaveUnique) wrong.push(entry.table);
  }
  return wrong.sort();
}

describe('the category-override population is derived, not remembered', () => {
  it('walks a schema of a plausible size', () => {
    expect(tables.length).toBeGreaterThanOrEqual(SCHEMA_TABLE_FLOOR);
  });

  it('derives the versioned definitions from their (key, version) identity', () => {
    const versioned = deriveVersionedDefinitionTables(schema);

    // Positive controls, and the two that matter are the ones whose key column
    // is NOT literally `key`. A rule keyed on that spelling finds only the
    // first pair, which is exactly how this derivation would quietly stop
    // covering the first policy family to grow a category scope.
    expect(versioned.has('attribute_definitions')).toBe(true); // key + version
    expect(versioned.has('product_type_definitions')).toBe(true); // key + version
    expect(versioned.has('fee_schedules')).toBe(true); // scheduleKey + version
    expect(versioned.has('retail_eligibility_policies')).toBe(true); // policyKey + version
    // Measured at the time of writing: 14.
    expect(versioned.size).toBeGreaterThanOrEqual(10);

    // Negative controls at two distances. A derivation that collapsed into
    // "every table" would still satisfy every assertion above, and the
    // 300-table floor would not notice.
    expect(versioned.has('categories')).toBe(false);
    expect(versioned.has('listings')).toBe(false);
    expect(versioned.size).toBeLessThan(tables.length / 4);
  });

  /**
   * And widening that rule from 2 tables to 14 changes the population by
   * NOTHING, which is the fact worth pinning: no other versioned policy in the
   * repository has a child carrying a `categories.id` foreign key. If one ever
   * does, this assertion is not what fails — the coverage census above is,
   * naming the new table. This one just stops the two derivations silently
   * drifting apart.
   */
  it('answers the same population under the strict (key, version) reading', () => {
    const strict = new Set(['attribute_definitions', 'product_type_definitions']);
    const loose = deriveCategoryScopedDefinitionTables(schema).map((entry) => entry.table);
    const narrow = deriveCategoryScopedDefinitionTables(schema, strict).map(
      (entry) => entry.table,
    );
    expect(narrow).toEqual(loose);

    // And the injection is not inert: an EMPTY versioned set must empty the
    // population, or the parameter is being ignored and the comparison above is
    // one derivation compared with itself.
    expect(deriveCategoryScopedDefinitionTables(schema, new Set())).toEqual([]);
  });

  /**
   * The blind spot in the shipped rule, measured rather than argued.
   *
   * `identity` wants the key and the version to BE the unique, so it misses a
   * contract versioned per market and locale — `navigation_trees` is
   * `(key, market, locale, version)`. The wide reading finds 23 versioned
   * tables instead of 14 and adds exactly ONE table to the population,
   * `navigation_nodes`, which is a SUBJECT: a menu item POINTS at a category,
   * it does not say what applies under one.
   *
   * So the FROZEN set is the same under both readings today, and this is the
   * assertion that notices when it stops being — a wide-only contract growing a
   * (version, category) rule fails here, naming it, even though the shipped
   * derivation would never have seen it.
   */
  it('gains no RULE under the wider versioned reading', () => {
    const wide = deriveVersionedDefinitionTables(schema, { arity: 'any' });
    const narrow = deriveVersionedDefinitionTables(schema);
    expect(wide.size).toBeGreaterThan(narrow.size); // the readings really differ
    expect(wide.has('navigation_trees')).toBe(true);
    expect(narrow.has('navigation_trees')).toBe(false);

    const widePopulation = deriveCategoryScopedDefinitionTables(schema, wide);
    const wideRules = widePopulation
      .filter((entry) => entry.hasScopeUnique)
      .map((entry) => entry.table);
    const narrowRules = deriveCategoryScopedDefinitionTables(schema)
      .filter((entry) => entry.hasScopeUnique)
      .map((entry) => entry.table);

    expect(wideRules).toEqual(narrowRules);
    expect(wideRules).toEqual([
      'attribute_definition_categories',
      'product_type_category_scopes',
    ]);
    // And the wide reading really does reach further, or the equality above is
    // two identical populations agreeing about nothing.
    expect(widePopulation.map((entry) => entry.table)).toContain('navigation_nodes');
  });

  it('finds every table naming BOTH a category and a versioned definition', () => {
    const population = deriveCategoryScopedDefinitionTables(schema);
    expect(population.length).toBeGreaterThanOrEqual(POPULATION_FLOOR);

    const names = population.map((entry) => entry.table);
    // Positive controls: one from each side of the shape rule, so a walk that
    // found only junctions or only subjects fails here.
    expect(names).toContain('attribute_definition_categories');
    expect(names).toContain('product_type_category_scopes');
    expect(names).toContain('listings');

    // Negative controls. `category_localizations` names a category and no
    // definition; `product_type_fields` names a definition and no category;
    // `condition_category_policies` names a category and NO versioned parent at
    // all, which is why it is outside this population by the derivation rather
    // than by an exemption (see `categoryScopeFreeze.ts`).
    expect(names).not.toContain('category_localizations');
    expect(names).not.toContain('product_type_fields');
    expect(names).not.toContain('condition_category_policies');
  });

  it('is covered by the disposition ledger EXACTLY', () => {
    const gaps = coverageGaps(
      deriveCategoryScopedDefinitionTables(schema),
      CATEGORY_SCOPE_DISPOSITIONS,
    );

    expect(
      gaps.undeclared,
      'These tables name a category and a versioned catalog definition, and nothing says ' +
        'what happens to them once that version is frozen. Add an entry to ' +
        '`categoryScopeFreeze.ts`: either it is one row per (version, category) and a ' +
        'trigger freezes it with its version, or it is the authored subject and says why.',
    ).toEqual([]);

    expect(
      gaps.extra,
      'These tables are declared and no longer in the population. Remove them, or restore ' +
        'the foreign key that put them there.',
    ).toEqual([]);
  });

  it('declares each table once, with a reason', () => {
    const names = CATEGORY_SCOPE_DISPOSITIONS.map((entry) => entry.table);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of CATEGORY_SCOPE_DISPOSITIONS) {
      expect(entry.why.trim().length, `${entry.table} has no reason`).toBeGreaterThan(60);
    }
  });

  it('declares enough enforcement to be worth checking', () => {
    const frozen = CATEGORY_SCOPE_DISPOSITIONS.filter(
      (entry) => entry.kind === 'frozen_with_its_version',
    );
    expect(frozen.length).toBeGreaterThanOrEqual(FROZEN_FLOOR);
    for (const entry of frozen) {
      expect(entry.trigger.trim().length, `${entry.table} names no trigger`).toBeGreaterThan(0);
      expect(entry.parentTable.trim().length, `${entry.table} names no parent`).toBeGreaterThan(0);
    }
    // Distinct triggers: one function mounted on two tables under two names is
    // fine, but two entries naming ONE trigger would mean the realdb half tests
    // the same object twice and reports it as two.
    const triggers = frozen.map((entry) => entry.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('holds the shape rule in BOTH directions', () => {
    const wrong = shapeGaps(deriveCategoryScopedDefinitionTables(schema), CATEGORY_SCOPE_DISPOSITIONS);
    expect(
      wrong,
      'A `frozen_with_its_version` table must carry a UNIQUE over (definition, category) — ' +
        'that pair is what makes the row a rule about a category rather than a fact about ' +
        'one subject — and a `subject_not_a_rule` table must not.',
    ).toEqual([]);
  });
});

describe('the census itself goes red', () => {
  it('names a table the ledger forgot', () => {
    const population = deriveCategoryScopedDefinitionTables(schema);
    const without = CATEGORY_SCOPE_DISPOSITIONS.filter(
      (entry) => entry.table !== 'attribute_definition_categories',
    );
    expect(coverageGaps(population, without).undeclared).toEqual([
      'attribute_definition_categories',
    ]);
  });

  it('names a declaration the schema no longer supports', () => {
    const population = deriveCategoryScopedDefinitionTables(schema).filter(
      (entry) => entry.table !== 'product_type_category_scopes',
    );
    expect(coverageGaps(population, CATEGORY_SCOPE_DISPOSITIONS).extra).toEqual([
      'product_type_category_scopes',
    ]);
  });

  it('names a rule mislabelled as a subject', () => {
    const population = deriveCategoryScopedDefinitionTables(schema);
    const mislabelled: CategoryScopeDisposition[] = CATEGORY_SCOPE_DISPOSITIONS.map((entry) =>
      entry.table === 'attribute_definition_categories'
        ? { table: entry.table, kind: 'subject_not_a_rule', why: entry.why }
        : entry,
    );
    expect(shapeGaps(population, mislabelled)).toEqual(['attribute_definition_categories']);
  });

  it('names a subject mislabelled as a rule', () => {
    const population = deriveCategoryScopedDefinitionTables(schema);
    const mislabelled: CategoryScopeDisposition[] = CATEGORY_SCOPE_DISPOSITIONS.map((entry) =>
      entry.table === 'listings'
        ? {
            table: entry.table,
            kind: 'frozen_with_its_version',
            parentTable: 'product_type_definitions',
            trigger: 'listings_frozen',
            why: entry.why,
          }
        : entry,
    );
    expect(shapeGaps(population, mislabelled)).toEqual(['listings']);
  });

  /**
   * The detector that would go quietly wrong.
   *
   * `product_type_category_scopes` states its pair unique as a `uniqueIndex`
   * and drizzle files that under `indexes`, not `uniqueConstraints`. A walker
   * reading only the second would report it as having no scope unique — and the
   * shape rule would then mark the very table this gate exists to protect as a
   * subject, in green.
   */
  it('sees a pair unique stated as a uniqueIndex, not only as a unique constraint', () => {
    const population = deriveCategoryScopedDefinitionTables(schema);
    const scopes = population.find((entry) => entry.table === 'product_type_category_scopes');
    expect(scopes?.hasScopeUnique).toBe(true);

    // And the drizzle fact behind it, so this stays honest if drizzle moves it.
    const config = getTableConfig(schema.productTypeCategoryScopes);
    expect(config.uniqueConstraints).toHaveLength(0);
    expect(config.indexes.filter((index) => index.config.unique)).toHaveLength(1);
  });

  /**
   * And the derivation notices a NEW member.
   *
   * A synthetic table with both foreign keys and a pair unique — exactly the
   * shape of a future category override — must be found by the walk. Without
   * this the coverage assertion above is satisfied forever by a walk that only
   * ever returns the five tables that exist today.
   */
  it('finds a newly added category override', () => {
    const invented = pgTable(
      'zz_invented_category_overrides',
      {
        id: text().primaryKey(),
        attributeDefinitionId: text()
          .notNull()
          .references(() => schema.attributeDefinitions.id),
        categoryId: text()
          .notNull()
          .references(() => schema.categories.id),
      },
      (t) => [uniqueIndex('zz_invented_key').on(t.attributeDefinitionId, t.categoryId)],
    );
    const widened = { ...schema, zzInventedCategoryOverrides: invented };
    const population = deriveCategoryScopedDefinitionTables(widened);
    const found = population.find((entry) => entry.table === 'zz_invented_category_overrides');
    expect(found?.hasScopeUnique).toBe(true);
    expect(coverageGaps(population, CATEGORY_SCOPE_DISPOSITIONS).undeclared).toEqual([
      'zz_invented_category_overrides',
    ]);
  });
});
