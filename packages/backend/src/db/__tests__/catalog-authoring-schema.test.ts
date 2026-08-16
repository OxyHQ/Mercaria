/**
 * What the catalog authoring schema DECLARES (#367 step 5, ADR 0007 D10/D14).
 *
 * Drizzle reflection, no server: this asserts the shape drizzle-kit will emit
 * DDL from, which is the half a realdb suite cannot check until the migration
 * exists. `catalog-authoring.realdb.test.ts` covers the half that needs a real
 * PostgreSQL — the CHECKs actually refusing rows, the partial uniques actually
 * converging, and the triggers actually raising.
 *
 * Two of the assertions here are census-shaped and each carries a vacuity floor,
 * because "I found no jsonb column" and "the traversal returned nothing" produce
 * the same clean output.
 */

import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { DATABASE_CASING, sqlColumnName } from '@oxyhq/db';
import { MERGEABLE_ENTITY_TYPES } from '@mercaria/shared-types';
import {
  catalogAuthoringDraftValues,
  catalogAuthoringDraftVariants,
  catalogAuthoringDrafts,
  catalogAuthoringSchemaInvalidations,
} from '../schema/catalogAuthoring.js';
import { ID_COLUMNS_WITHOUT_FOREIGN_KEY } from '../deferredForeignKeys.js';
import { EXPIRY_TARGETS } from '../expiryTargets.js';

const TABLES = [
  catalogAuthoringDrafts,
  catalogAuthoringDraftVariants,
  catalogAuthoringDraftValues,
  catalogAuthoringSchemaInvalidations,
];

/**
 * The dialect is constructed with `DATABASE_CASING`, and that is not cosmetic: a
 * bare `new PgDialect()` renders the TypeScript property names, so an assertion
 * would be checking `schemaSnapshot` against a schema that creates
 * `schema_snapshot` — and the ones that happened to match would pass while
 * measuring the wrong string. The same setting `drizzle.config.ts` passes, from
 * the same constant.
 */
const dialect = new PgDialect({ casing: DATABASE_CASING });

/** Every CHECK the domain declares, by constraint name. */
function checkNames(): Set<string> {
  const names = new Set<string>();
  for (const table of TABLES) {
    for (const check of getTableConfig(table).checks) names.add(check.name);
  }
  return names;
}

/** Every rendered CHECK body, by constraint name. */
function checkBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const table of TABLES) {
    for (const check of getTableConfig(table).checks) {
      bodies.set(check.name, dialect.sqlToQuery(check.value).sql);
    }
  }
  return bodies;
}

describe('the four tables and their names', () => {
  it('declares exactly four tables, named as the domain documents them', () => {
    expect(TABLES.map(getTableName)).toEqual([
      'catalog_authoring_drafts',
      'catalog_authoring_draft_variants',
      'catalog_authoring_draft_values',
      'catalog_authoring_schema_invalidations',
    ]);
  });
});

describe('ADR 0007 D14 — exactly ONE jsonb column, and it is the audit snapshot', () => {
  it('has one jsonb column across the four tables', () => {
    const jsonbColumns: string[] = [];
    for (const table of TABLES) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (column.getSQLType().startsWith('jsonb')) {
          jsonbColumns.push(`${config.name}.${sqlColumnName(column)}`);
        }
      }
    }
    // EXACTLY, not at most: a count-based floor a later addition erodes ends at
    // ">= 0", and the point of D14's register is that a new jsonb column fails
    // the build until somebody justifies it. The `product_type_fields` device.
    expect(jsonbColumns).toEqual(['catalog_authoring_drafts.schema_snapshot']);
  });

  it('the snapshot carries a BYTE bound, so an oversized one is refused rather than stored', () => {
    const body = checkBodies().get('catalog_authoring_drafts_snapshot_bounded_check');
    expect(body).toBeDefined();
    expect(body).toContain('octet_length');
    // `pg_column_size` is STABLE — PostgreSQL refuses it in a CHECK — and it
    // measures the COMPRESSED size rather than what a reader has to parse.
    expect(body).not.toContain('pg_column_size');
  });
});

describe('no column here references a MERGEABLE entity, and that is the decision', () => {
  it('declares no foreign key onto any mergeable catalogue entity', () => {
    // The merge census (`merge-plan-census.test.ts`) fails the build on a new FK
    // targeting one until somebody decides what a merge does with it. This
    // domain's answer is to carry no FK at all and resolve through
    // `merged_into_id` at publish time, so the census has nothing to find —
    // which is what makes "this issue adds no `merge-plan.ts` entry" a fact
    // rather than an omission.
    const mergeableTables = new Set<string>(
      MERGEABLE_ENTITY_TYPES.map((type) =>
        // `family` → `families`; every other member pluralizes with an `s`. The
        // map is derived from the tuple rather than written out, so a seventh
        // mergeable entity is covered by this gate the day it is added.
        type === 'canonical_product_family' ? 'canonical_product_families' : `${type}s`,
      ),
    );
    const offenders: string[] = [];
    for (const table of TABLES) {
      const config = getTableConfig(table);
      for (const fk of config.foreignKeys) {
        const target = getTableName(fk.reference().foreignTable);
        if (mergeableTables.has(target)) offenders.push(`${config.name} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity floor: the walk found foreign keys at all, so an empty offender
    // list is a real absence rather than a traversal that returned nothing.
    const totalForeignKeys = TABLES.reduce(
      (count, table) => count + getTableConfig(table).foreignKeys.length,
      0,
    );
    expect(totalForeignKeys).toBeGreaterThanOrEqual(6);
    expect(mergeableTables.size).toBeGreaterThanOrEqual(5);
  });

  it('every unconstrained id column is LEDGERED with a reason', () => {
    const ledgered = new Set(ID_COLUMNS_WITHOUT_FOREIGN_KEY.map((entry) => entry.column));
    const constrained = new Set<string>();
    for (const table of TABLES) {
      const config = getTableConfig(table);
      for (const fk of config.foreignKeys) {
        for (const column of fk.reference().columns) {
          constrained.add(`${config.name}.${sqlColumnName(column)}`);
        }
      }
    }

    const unclassified: string[] = [];
    for (const table of TABLES) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const name = sqlColumnName(column);
        if (!name.endsWith('_id')) continue;
        const qualified = `${config.name}.${name}`;
        if (column.primary || constrained.has(qualified) || ledgered.has(qualified)) continue;
        unclassified.push(qualified);
      }
    }
    expect(unclassified).toEqual([]);
  });
});

describe('the biconditionals that carry the published state', () => {
  const names = checkNames();

  it('states the published listing, the published instant and the expiry SEPARATELY', () => {
    // THREE biconditionals rather than one over their conjunction. The single
    // spelling is SATISFIED by an `open` row carrying a listing id and no
    // timestamp, because both sides evaluate false — which is exactly the row
    // the discriminant exists to forbid. Measured twice already in this schema.
    expect(names).toContain('catalog_authoring_drafts_published_listing_check');
    expect(names).toContain('catalog_authoring_drafts_published_at_check');
    expect(names).toContain('catalog_authoring_drafts_expiry_check');
  });

  it('counts the value columns rather than pairing them', () => {
    const body = checkBodies().get('catalog_authoring_draft_values_exactly_one_value_check');
    expect(body).toBeDefined();
    // `num_nonnulls(...) = 1`. A per-kind biconditional set is satisfied by a row
    // populating a column no kind claims, because every individual biconditional
    // reads false on both sides; counting is the only form that refuses that.
    expect(body).toContain('num_nonnulls');
  });

  it('states each kind BESIDE the count, so the wrong column is refused too', () => {
    for (const kind of ['text', 'number', 'boolean', 'controlled', 'canonical']) {
      expect(names).toContain(`catalog_authoring_draft_values_${kind}_kind_check`);
    }
  });

  it('ties a variant answer to a variant, both ways', () => {
    const body = checkBodies().get('catalog_authoring_draft_values_variant_scope_check');
    expect(body).toBeDefined();
    expect(body).toContain('variant');
  });
});

describe('the uniques that make convergence real', () => {
  function indexNames(table: PgTable): { name: string; unique: boolean; partial: boolean }[] {
    return getTableConfig(table).indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique === true,
      partial: index.config.where !== undefined,
    }));
  }

  it('the publish idempotency key is unique per STORE and PARTIAL', () => {
    const found = indexNames(catalogAuthoringDrafts).find(
      (index) => index.name === 'catalog_authoring_drafts_idempotency_key',
    );
    expect(found?.unique).toBe(true);
    // Partial, because Postgres treats NULLs as DISTINCT and most drafts carry
    // none — and scoped to the store, so two merchants generating the same
    // client-side key do not collide on each other's listing.
    expect(found?.partial).toBe(true);
  });

  it('the axis signature is unique per DRAFT and PARTIAL', () => {
    const found = indexNames(catalogAuthoringDraftVariants).find(
      (index) => index.name === 'catalog_authoring_draft_variants_signature_key',
    );
    expect(found?.unique).toBe(true);
    expect(found?.partial).toBe(true);
  });

  it('an answer is unique across FOUR partial indexes, not one', () => {
    // Postgres treats NULLs as DISTINCT, so a single index over the five columns
    // would admit any number of rows for the ordinary product-scope,
    // non-structured answer — which is nearly every row in the table.
    const value = indexNames(catalogAuthoringDraftValues).filter(
      (index) => index.unique && index.partial,
    );
    expect(value.map((index) => index.name).sort()).toEqual([
      'catalog_authoring_draft_values_product_component_key',
      'catalog_authoring_draft_values_product_key',
      'catalog_authoring_draft_values_variant_component_key',
      'catalog_authoring_draft_values_variant_key',
    ]);
  });

  it('the cache register converges on one row per subject', () => {
    const found = indexNames(catalogAuthoringSchemaInvalidations).find(
      (index) => index.name === 'catalog_authoring_schema_invalidations_key',
    );
    expect(found?.unique).toBe(true);
    expect(found?.partial).toBe(false);
  });
});

describe('the expiry sweep can reach an abandoned draft and cannot reach a published one', () => {
  it('the draft table is registered, on its own deadline column', () => {
    const entry = EXPIRY_TARGETS.find(
      (target) => getTableName(target.table) === 'catalog_authoring_drafts',
    );
    expect(entry).toBeDefined();
    expect(entry === undefined ? '' : sqlColumnName(entry.column)).toBe('expires_at');
    // The column IS the deadline, so the retention is 0 — the `notifications`
    // shape. A non-zero value here would measure a second window on top of the
    // one the writer already stamped.
    expect(entry?.retentionSeconds).toBe(0);
  });

  it('the two child tables are deliberately NOT registered', () => {
    // They CASCADE from the draft, so a swept draft leaves no answer pointing at
    // a form that is gone. A second entry would be a second sweep of rows the
    // first already removed.
    const registered = EXPIRY_TARGETS.map((target) => getTableName(target.table));
    expect(registered).not.toContain('catalog_authoring_draft_variants');
    expect(registered).not.toContain('catalog_authoring_draft_values');
    // Vacuity floor on the registry read itself.
    expect(registered.length).toBeGreaterThanOrEqual(20);
  });
});

describe('the domain declares no table drizzle would emit outside it', () => {
  it('every exported PgTable in the module is one of the four', () => {
    // A census over the MODULE rather than over the list above, so a fifth table
    // added without a decision fails here rather than being invisible to every
    // assertion in this file.
    return import('../schema/catalogAuthoring.js').then((module) => {
      const exported = Object.values(module).filter((value) => is(value, PgTable));
      expect(exported.length).toBe(4);
    });
  });
});
