/**
 * The apparel axis widening, against a REAL Postgres server
 * (#367 workstream 4, "support … inseam and compound dimensions").
 *
 * ## What only a real server can settle here
 *
 * Four CHECKs are rendered from ONE tuple, `ATTRIBUTE_COMPONENT_AXES`, and the
 * migration that widens them is a `DROP CONSTRAINT` / `ADD CONSTRAINT` pair per
 * table. Three things about that are invisible to `tsc`, to a mocked
 * repository, and to reading the diff:
 *
 * 1. **Whether the constraint was VALIDATED.** A constraint added `NOT VALID`
 *    governs new writes only and leaves every pre-existing violator in place and
 *    invisible — the table reports a constraint, `\d` shows it, and the rows it
 *    exists to forbid are already there. `convalidated` is the only thing that
 *    tells the two apart, and it is asserted per constraint below.
 * 2. **Whether the widening actually reached the server.** A tuple widened in
 *    TypeScript with no migration is a green build whose first apparel write
 *    fails in production. The census reads the live `pg_constraint` definition
 *    rather than the schema module, so it can only pass if the migration ran.
 * 3. **Whether the CHECK still REFUSES.** A widening that accidentally became
 *    `CHECK (true)` admits everything and every functional test stays green. So
 *    every acceptance below is paired with a refusal on the same column.
 *
 * ## The census is derived, never listed
 *
 * The four tables are found by WALKING the schema barrel for a column named
 * `component_axis`/`component_axes`, so a fifth table growing one and not being
 * widened fails here rather than being discovered by a merchant. That is the
 * `merge-plan-census` device: finding fewer tables and there BEING fewer look
 * identical, so the count is floored.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { isCheckViolation, uuidv7 } from '@oxyhq/db';
import {
  ATTRIBUTE_COMPONENT_AXES,
  GARMENT_COMPONENT_AXES,
  type AttributeComponentAxis,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import * as schema from '../schema/index.js';
import { attributeDefinitions } from '../schema/attributeRegistry.js';

let db: Database;

const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const createdKeys: string[] = [];

/**
 * Every table carrying a component-axis column, DERIVED from the barrel.
 *
 * Singular AND plural, because `attribute_definitions` holds an ARRAY of axes
 * (containment CHECK) while the other three hold a single value (membership
 * CHECK) — and a census that knew only one shape would silently cover three of
 * the four.
 *
 * ## Two ways this walk returns NOTHING while looking healthy
 *
 * Both were hit while writing it, and a walk that finds nothing produces zero
 * findings, which is what a clean run also produces:
 *
 * 1. **`instanceof PgTable` answers false for every table** when the barrel and
 *    this file resolve two copies of drizzle's class. `is()` is drizzle's own
 *    answer to that and is what the sibling realdb suites use.
 * 2. **Drizzle reports the column by its JS name, not its SQL name.** The TABLE
 *    name is snake_case because `pgTable('attribute_definitions', …)` spells it
 *    out; the COLUMN name is `componentAxes`, because `DATABASE_CASING` is
 *    applied by the DIALECT when SQL is generated and never written onto the
 *    column. Matching `component_axis` therefore finds zero columns on a
 *    perfectly healthy schema. The pattern below accepts either, and the
 *    population floor is what turned this from a green vacuous census into a
 *    failure.
 */
const AXIS_COLUMN = /^component_?[Aa]x[ei]s$/u;

function axisCarryingTables(): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = [];
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const config = getTableConfig(exported);
    for (const column of config.columns) {
      if (AXIS_COLUMN.test(column.name)) found.push({ table: config.name, column: column.name });
    }
  }
  return found.sort((left, right) => left.table.localeCompare(right.table));
}

/**
 * A `type` and not an `interface`, deliberately.
 *
 * `db.execute<T>` constrains `T` to `Record<string, unknown>`, and a declared
 * `interface` gets no implicit index signature while a type alias over an
 * object literal does — so the interface spelling is a `tsc` error and the
 * alias is not. It compiled and RAN under vitest either way, because esbuild
 * strips types without checking them; only the typecheck job sees it, which is
 * the repository's own reason for typechecking rather than trusting a build.
 */
type ConstraintRow = {
  conname: string;
  convalidated: boolean;
  definition: string;
};

/**
 * Every CHECK on one table that mentions an axis column.
 *
 * The pattern is `component_ax%` and not `component_axis%`: the SQL column is
 * `component_axes` on `attribute_definitions` and `component_axis` on the other
 * three, so the singular pattern silently matched three of the four. The same
 * trap as the JS-name one above, one layer down, and caught by the same
 * population floor rather than by reading.
 *
 * The explanation lives HERE rather than as an SQL comment inside the template,
 * because a backtick in a tagged template closes it — which is a build error
 * rather than a wrong query, but only after it has cost a run.
 */
async function axisConstraints(table: string): Promise<ConstraintRow[]> {
  const rows = await db.execute<ConstraintRow>(sql`
    select c.conname,
           c.convalidated,
           pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = ${table}
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%component_ax%'
  `);
  return [...rows];
}

/** The quoted values a CHECK definition permits. */
function permitted(definition: string): Set<string> {
  return new Set([...definition.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1] as string));
}

/**
 * Of the CHECKs that MENTION an axis column, the ones that constrain its DOMAIN.
 *
 * Widening the SQL pattern turned up a fifth constraint this file did not know
 * existed: `attribute_definitions_component_axes_check`, the biconditional
 * tying `value_type = 'structured'` to the array being non-empty. It names the
 * column and constrains nothing about WHICH axes are legal — its only quoted
 * literal is `structured` — so comparing it against the axis tuple reports
 * every axis missing and one stranger present, which is a true statement about
 * the wrong constraint.
 *
 * The partition is DERIVED rather than a list of the four names: a domain check
 * is one that permits at least one member of the vocabulary. That keeps a
 * NARROWED domain check in scope (it still names some axes, so it is compared
 * and fails), and a domain check degraded to `CHECK (true)` drops out of the
 * partition — where the population FLOOR catches it, which is why the floor and
 * the partition are both load-bearing and neither covers the other.
 */
function isDomainCheck(definition: string): boolean {
  const values = permitted(definition);
  return ATTRIBUTE_COMPONENT_AXES.some((axis) => values.has(axis));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // `inArray` and not a bare array in a `sql` template: drizzle renders a bare
  // JS array as a ROW CONSTRUCTOR, so `any(${keys}::text[])` reaches the server
  // as `any(($1, $2, …)::text[])` and fails 42846 — a house trap this teardown
  // walked straight into. Scoped to the keys THIS run minted, because the test
  // database is shared with every parallel file.
  if (createdKeys.length > 0) {
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.key, createdKeys));
  }
  await closePostgres();
});

describe('the axis vocabulary the SERVER enforces', () => {
  it('finds every axis-carrying table by walking the schema, not a list', () => {
    const tables = axisCarryingTables();
    // Floored: finding fewer tables and there BEING fewer look identical.
    expect(
      tables.length,
      `axis-carrying tables: ${tables.map((entry) => `${entry.table}.${entry.column}`).join(', ')}`,
    ).toBeGreaterThanOrEqual(4);
    const names = tables.map((entry) => entry.table);
    expect(names).toContain('attribute_definitions');
    expect(names).toContain('attribute_source_mappings');
    expect(names).toContain('canonical_attribute_values');
    expect(names).toContain('catalog_authoring_draft_values');
    // Both SHAPES really occur — an array column and a scalar one — or the
    // census is covering one of the two CHECK forms only.
    const columns = new Set(tables.map((entry) => entry.column));
    expect([...columns].sort()).toEqual(['componentAxes', 'componentAxis']);
  });

  it('carries a VALIDATED CHECK on every one of them', async () => {
    const tables = axisCarryingTables();
    const findings: string[] = [];
    let checked = 0;

    for (const { table } of tables) {
      const constraints = await axisConstraints(table);
      if (constraints.length === 0) {
        findings.push(`${table} has NO axis CHECK at all`);
        continue;
      }
      for (const row of constraints) {
        checked += 1;
        // The whole point of this file. `NOT VALID` governs new writes only and
        // leaves every pre-existing violator in place and invisible.
        if (!row.convalidated) findings.push(`${table}.${row.conname} is NOT VALID`);
      }
    }

    expect(checked, `${checked} axis CHECKs read from pg_constraint`).toBeGreaterThanOrEqual(4);
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('permits exactly the tuple, on every table, live', async () => {
    const expected = new Set<string>(ATTRIBUTE_COMPONENT_AXES);
    const findings: string[] = [];
    let compared = 0;

    for (const { table } of axisCarryingTables()) {
      for (const row of await axisConstraints(table)) {
        if (!isDomainCheck(row.definition)) continue;
        compared += 1;
        const live = permitted(row.definition);
        const missing = [...expected].filter((axis) => !live.has(axis));
        const extra = [...live].filter((axis) => !expected.has(axis));
        if (missing.length > 0 || extra.length > 0) {
          findings.push(
            `${table}.${row.conname}: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`,
          );
        }
      }
    }

    // Floored at the four DOMAIN checks. A domain check degraded to
    // `CHECK (true)` leaves the partition and lands here.
    expect(compared, `${compared} axis DOMAIN checks compared against the tuple`).toBeGreaterThanOrEqual(4);
    // The migration reached the server AND did not narrow anything. A tuple
    // widened in TypeScript with no migration fails exactly here.
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('names the garment axes as a real subset of the tuple', () => {
    expect(GARMENT_COMPONENT_AXES.length).toBe(5);
    for (const axis of GARMENT_COMPONENT_AXES) {
      expect(ATTRIBUTE_COMPONENT_AXES, `${axis} is not in the tuple`).toContain(axis);
    }
    // Ten total, and the two groups are disjoint — a garment axis that was also
    // a geometric one would make the split decorative.
    expect(ATTRIBUTE_COMPONENT_AXES.length).toBe(10);
    const geometric = ATTRIBUTE_COMPONENT_AXES.filter(
      (axis) => !(GARMENT_COMPONENT_AXES as readonly string[]).includes(axis),
    );
    expect(geometric.sort()).toEqual(['circumference', 'depth', 'diagonal', 'height', 'width']);
  });
});

describe('the widened CHECK admits a garment axis and still refuses a stranger', () => {
  async function insertDefinition(axes: readonly string[]): Promise<void> {
    const key = `axis_probe_${axes.join('_')}_${RUN}`.toLowerCase().slice(0, 60);
    createdKeys.push(key);
    await db.insert(attributeDefinitions).values({
      key,
      label: 'Axis probe',
      valueType: 'structured',
      unitFamily: 'length',
      baseUnit: 'mm',
      componentAxes: [...axes],
    });
  }

  it('accepts a waist × inseam declaration — the compound size this issue is for', async () => {
    await expect(insertDefinition(['waist', 'inseam'])).resolves.toBeUndefined();
    await expect(insertDefinition(['neck', 'sleeve'])).resolves.toBeUndefined();
    // …and the geometric axes still work, so the widening added rather than
    // replaced.
    await expect(insertDefinition(['width', 'height', 'depth'])).resolves.toBeUndefined();
  });

  it('still REFUSES an axis nobody declared', async () => {
    // The arm that fails if the widening became `CHECK (true)`. `hip` is the
    // sharpest probe available: it is a real garment measurement that was
    // deliberately left out, so admitting it means the CHECK stopped deciding
    // rather than that somebody widened the tuple on purpose.
    for (const stranger of ['hip', 'shoulder', 'rise', 'outseam', 'length']) {
      let refused = false;
      try {
        await insertDefinition([stranger]);
      } catch (error) {
        refused = isCheckViolation(error);
      }
      expect(refused, `'${stranger}' was admitted by the axis CHECK`).toBe(true);
    }
  });

  it('refuses a stranger sitting BESIDE two legitimate axes', async () => {
    // Containment, not membership: `attribute_definitions.component_axes` is an
    // array, and the failure a per-element check would have is admitting a bad
    // member as long as a good one is present.
    let refused = false;
    try {
      await insertDefinition(['waist', 'hip']);
    } catch (error) {
      refused = isCheckViolation(error);
    }
    expect(refused, 'an array carrying one bad axis was admitted').toBe(true);
  });

  it('refuses a stranger on the single-value column too', async () => {
    // `canonical_attribute_values.component_axis` is the membership shape, and
    // it is a different constraint from the array one above. Asserted straight
    // through SQL because a row there needs a product and a source record; the
    // CHECK is evaluated before any of that matters.
    let refused = false;
    try {
      await db.execute(sql`
        insert into canonical_attribute_values
          (id, attribute_key, source_display_value, normalization_state,
           source_record_id, component_axis)
        values (${uuidv7()}, 'axis_probe', 'x', 'unparsed', ${uuidv7()}, 'hip')
      `);
    } catch (error) {
      refused = isCheckViolation(error);
    }
    expect(refused, "'hip' was admitted on canonical_attribute_values").toBe(true);
  });
});
