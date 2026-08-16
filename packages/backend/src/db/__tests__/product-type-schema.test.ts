/**
 * The product-type schema's load-bearing constraints, asserted against the
 * RENDERED SQL rather than against the TypeScript that was meant to produce it
 * (#367, ADR 0007 D5/D6/D8/D14).
 *
 * Every check here exists because the same property, stated only in a service,
 * would be one forgotten call site from being no property at all — and because
 * `text({ enum })` emits no DDL, so a closed value set with no `checkOneOf`
 * beside it looks constrained in the editor and accepts anything in the
 * database (`CONVENTIONS.md`).
 *
 * The one thing this file cannot do is prove the constraints REJECT anything:
 * that needs a real server, and it belongs in the realdb suite that lands with
 * the migration. What it does prove is that the expressions name the columns and
 * the values they claim to — which is exactly the half a mocked insert can never
 * see either.
 */

import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { DATABASE_CASING, sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_TYPE_AUTHORING_FLOWS,
  PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS,
  PRODUCT_TYPE_FIELD_REQUIREMENTS,
  PRODUCT_TYPE_FIELD_SCOPES,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
  PRODUCT_TYPE_LIFECYCLES,
  PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES,
  PRODUCT_TYPE_VALUE_POLICIES,
  RESERVED_OFFER_FACT_KEYS,
} from '@mercaria/shared-types';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
  productTypeFieldGroups,
  productTypeFields,
} from '../schema/productTypes.js';

/**
 * The dialect is constructed with `DATABASE_CASING`, and that is not cosmetic:
 * a bare `new PgDialect()` renders the TypeScript property names, so every
 * assertion below would be checking `publishedAt` against a schema that creates
 * `published_at` — and the ones that happened to match would pass while
 * measuring the wrong string. It is the same setting `drizzle.config.ts` passes,
 * read from the same constant.
 */
const dialect = new PgDialect({ casing: DATABASE_CASING });

/** Every CHECK on a table, as `{ name, sql }` with the SQL fully rendered. */
function checksOf(table: Parameters<typeof getTableConfig>[0]): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const entry of getTableConfig(table).checks) {
    rendered.set(entry.name, dialect.sqlToQuery(entry.value).sql);
  }
  return rendered;
}

/** Every index on a table, by name. */
function indexNames(table: Parameters<typeof getTableConfig>[0]): Set<string> {
  const config = getTableConfig(table);
  return new Set([
    ...config.indexes.map((entry) => entry.config.name),
    ...config.uniqueConstraints.map((entry) => entry.name),
  ]);
}

describe('the four tables are shaped the way ADR 0007 D5 states', () => {
  it('names them exactly', () => {
    expect(getTableConfig(productTypeDefinitions).name).toBe('product_type_definitions');
    expect(getTableConfig(productTypeCategoryScopes).name).toBe('product_type_category_scopes');
    expect(getTableConfig(productTypeFieldGroups).name).toBe('product_type_field_groups');
    expect(getTableConfig(productTypeFields).name).toBe('product_type_fields');
  });

  it('holds "one current published version per key" with a PARTIAL unique index', () => {
    const config = getTableConfig(productTypeDefinitions);
    const partial = config.indexes.find(
      (entry) => entry.config.name === 'product_type_definitions_one_published_per_key',
    );
    expect(partial).toBeDefined();
    expect(partial?.config.unique).toBe(true);
    // `.name` and not `sqlColumnName(...)`: the handles drizzle hands an
    // extra-config callback are `ExtraConfigColumn`s with no table back-pointer,
    // so the casing cache cannot resolve them. The property name is what an
    // index config carries, and `DATABASE_CASING` turns it into the SQL name at
    // generate time — which is why the FK assertion below, whose columns ARE
    // real ones, checks the snake_case spelling instead.
    expect(
      partial?.config.columns.map((column) => ('name' in column ? column.name : '<expression>')),
    ).toEqual(['key']);
    // The predicate is what makes it "one PUBLISHED", rather than "one version".
    expect(partial?.config.where).toBeDefined();
    expect(dialect.sqlToQuery(partial?.config.where).sql).toContain("'published'");
    // And the exact-version identity every authored record cites.
    expect(indexNames(productTypeDefinitions)).toContain('product_type_definitions_key_version_key');
  });

  it('gives the group a CONSTRAINT the field composite foreign key can target', () => {
    // `unique()` and not `uniqueIndex()`: a foreign key must reference a
    // constraint, and this is the target of `product_type_fields_group_fk`. The
    // whole reason a field cannot sit in another product type's group.
    const config = getTableConfig(productTypeFieldGroups);
    const identity = config.uniqueConstraints.find(
      (entry) => entry.name === 'product_type_field_groups_identity_key',
    );
    expect(identity).toBeDefined();
    expect(identity?.columns.map((column) => column.name).sort()).toEqual(
      ['id', 'productTypeDefinitionId'].sort(),
    );

    const fk = getTableConfig(productTypeFields).foreignKeys.find(
      (entry) => entry.getName() === 'product_type_fields_group_fk',
    );
    expect(fk).toBeDefined();
    expect(fk?.reference().columns.map((column) => sqlColumnName(column))).toEqual([
      'group_id',
      'product_type_definition_id',
    ]);
    // `no action`, and this is a GATE rather than a preference. `restrict` is
    // the spelling every other foreign key in this repository uses and is what
    // somebody tidying this line would reach for — and it is checked
    // IMMEDIATELY, so deleting a definition (which cascades to its groups AND
    // its fields in one statement) would raise on whichever cascade ran first.
    // `no action` is checked at the end of the statement, by which point both
    // are gone. A comment alone is what the next person overrides.
    expect(fk?.onDelete).toBe('no action');
  });
});

describe('the variant-axis prohibition is a CHECK, and it names what it refuses', () => {
  const checks = checksOf(productTypeFields);
  const axisCheck = checks.get('product_type_fields_variant_axis_check');

  it('exists and is rendered from the shared-types tuple', () => {
    expect(axisCheck).toBeDefined();
    // Conjunct 1: an axis is a variant-scope field, so a compatibility target
    // can never be one — ADR 0007 D8's acceptance scenario.
    expect(axisCheck).toContain("'variant'");
    // Conjunct 2: and its attribute is outside the forbidden set. EVERY key is
    // named in the rendered expression — a CHECK that listed half of them would
    // pass a `toContain('price')` and admit every compatibility key.
    for (const key of PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS) {
      expect(axisCheck, `the CHECK does not name ${key}`).toContain(`'${key}'`);
    }
  });

  it('covers both halves of the forbidden set, and they are disjoint', () => {
    // The offer facts come from #94 and the compatibility targets from this
    // domain. Merging the two lists by hand is how one of them silently stops
    // being rendered into the constraint.
    for (const key of RESERVED_OFFER_FACT_KEYS) {
      expect(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS).toContain(key);
    }
    for (const key of PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS) {
      expect(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS).toContain(key);
      expect(RESERVED_OFFER_FACT_KEYS).not.toContain(key);
    }
    expect(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS.length).toBe(
      RESERVED_OFFER_FACT_KEYS.length + PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS.length,
    );
    // The vacuity floor: a rendered list of nothing would satisfy the loop above
    // by iterating zero times.
    expect(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS.length).toBeGreaterThanOrEqual(30);
  });

  it('the detector is not vacuous — a key NOT on the list is absent from the CHECK', () => {
    // The mutation self-test for the assertion above: `color` is the archetypal
    // legitimate axis, so if it appeared in the rendered CHECK the loop would be
    // matching something other than the forbidden list.
    expect(axisCheck).not.toContain("'color'");
    expect(axisCheck).not.toContain("'storage_capacity'");
  });
});

describe('every closed value set carries its CHECK, and the JSONB carries its bound', () => {
  const fieldChecks = checksOf(productTypeFields);
  const definitionChecks = checksOf(productTypeDefinitions);

  it('constrains scope, flow, requirement, value policy and lifecycle', () => {
    const cases: ReadonlyArray<readonly [Map<string, string>, string, readonly string[]]> = [
      [fieldChecks, 'product_type_fields_scope_check', PRODUCT_TYPE_FIELD_SCOPES],
      [fieldChecks, 'product_type_fields_flow_check', PRODUCT_TYPE_AUTHORING_FLOWS],
      [fieldChecks, 'product_type_fields_requirement_check', PRODUCT_TYPE_FIELD_REQUIREMENTS],
      [fieldChecks, 'product_type_fields_value_policy_check', PRODUCT_TYPE_VALUE_POLICIES],
      [definitionChecks, 'product_type_definitions_lifecycle_check', PRODUCT_TYPE_LIFECYCLES],
    ];
    for (const [checks, name, values] of cases) {
      const rendered = checks.get(name);
      expect(rendered, `${name} is missing`).toBeDefined();
      for (const value of values) {
        expect(rendered, `${name} does not name ${value}`).toContain(`'${value}'`);
      }
    }
  });

  it('bounds the visibility rule in BYTES, with an immutable expression', () => {
    const rendered = fieldChecks.get('product_type_fields_visibility_rule_bounded_check');
    expect(rendered).toBeDefined();
    expect(rendered).toContain(String(PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES));
    expect(rendered).toContain('jsonb_typeof');
    // `octet_length(<col>::text)` and NOT `pg_column_size`, which is STABLE —
    // PostgreSQL refuses a CHECK containing a function that is not IMMUTABLE, so
    // the wrong spelling fails at APPLY time rather than at generate time.
    expect(rendered).toContain('octet_length');
    expect(rendered).not.toContain('pg_column_size');
  });

  it('refuses a rule and a variant axis on a FORBIDDEN field', () => {
    const rendered = fieldChecks.get('product_type_fields_forbidden_shape_check');
    expect(rendered).toBeDefined();
    expect(rendered).toContain("'forbidden'");
    expect(rendered).toContain('visibility_rule');
    expect(rendered).toContain('variant_capable');
  });

  it('makes a published version state who published it and when', () => {
    const rendered = definitionChecks.get('product_type_definitions_published_audit_check');
    expect(rendered).toBeDefined();
    // The biconditional, not a one-way requirement: a draft carrying a
    // publication audit is as wrong as a published version without one.
    expect(rendered).toContain("'draft'");
    expect(rendered).toContain("'review'");
    expect(rendered).toContain('published_at');
    expect(rendered).toContain('published_by_oxy_user_id');
  });
});

describe('the schema declares no jsonb beyond the one ADR 0007 D14 permits', () => {
  it('has exactly one jsonb column across the four tables', () => {
    const jsonbColumns: string[] = [];
    for (const table of [
      productTypeDefinitions,
      productTypeCategoryScopes,
      productTypeFieldGroups,
      productTypeFields,
    ]) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (column.getSQLType().startsWith('jsonb')) {
          jsonbColumns.push(`${config.name}.${sqlColumnName(column)}`);
        }
      }
    }
    // EXACTLY, not at most: a count-based floor a later addition erodes ends at
    // ">= 0", and the point of D14's register is that a new jsonb column fails
    // the build until somebody justifies it.
    expect(jsonbColumns).toEqual(['product_type_fields.visibility_rule']);
  });
});
