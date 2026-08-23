import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index.js';

/**
 * The `jsonb` register, DERIVED over every table (#367 relational boundaries).
 *
 * `CONVENTIONS.md` states the policy — *"`jsonb` is for genuinely shape-less
 * data only"*, with the moderation payload as the legitimate case because a
 * published CrowdSource decision is deliberately loose and projecting it into
 * columns would silently drop whatever a newer version added. Several schema
 * layers then state *"Zero new `jsonb`. Nothing in this layer earned a register
 * row."*
 *
 * That is the policy. What was missing is the register itself: the enforcement
 * was per-MODULE exact-count censuses in a handful of files, so the population
 * was the modules somebody remembered. A new `jsonb` column in any of the
 * others passed every gate. **The population is every table, and the default
 * for a table nobody has thought about is ZERO** — which is the only shape that
 * makes a register mean anything.
 *
 * ## Derive the exclusion, never the inclusion
 *
 * {@link JSONB_REGISTER} lists only the tables that HAVE one. Every other table
 * is asserted to have none, so a new table starts at the strict value and a new
 * `jsonb` column anywhere fails the build until somebody adds a line here. That
 * line is the register row `CONVENTIONS.md` describes, and adding it is the
 * deliberate act it was always supposed to be.
 *
 * ## Read from the SCHEMA, not from the source text
 *
 * The counts come from `getTableColumns` and `columnType === 'PgJsonb'`, so a
 * `jsonb(` inside a comment, a docblock example or a string cannot move them,
 * and neither can a column declared through a helper. A text census over
 * `db/schema/*.ts` returns the same 22 today; it would stop agreeing the moment
 * anybody wrapped the builder.
 */

/** Every table with at least one `jsonb` column, and how many it has. */
const JSONB_REGISTER: Readonly<Record<string, number>> = {
  catalog_authoring_drafts: 1,
  catalog_governance_audit_events: 2,
  catalog_governance_change_requests: 1,
  catalog_governance_definition_snapshots: 1,
  catalog_revisions: 2,
  connections: 1,
  moderation_outboxes: 1,
  notifications: 2,
  payment_discrepancies: 1,
  payment_outboxes: 1,
  payment_provider_events: 2,
  payment_repairs: 1,
  procurement_outboxes: 1,
  product_type_fields: 1,
  shopping_agent_findings: 1,
  shopping_agents: 1,
  source_records: 1,
  supplier_provider_events: 1,
};

/**
 * The anti-vacuity floor.
 *
 * A `>=` rather than an exact count, deliberately: `schema-conventions.test.ts`
 * owns the EXACT population pin (`SCHEMA_TABLE_COUNT`), and two files carrying
 * the same number is two places to update and one of them to forget. What this
 * file needs is only the guarantee that it traversed a real schema — because
 * "every table outside the register has zero jsonb columns" is satisfied
 * perfectly by traversing no tables at all.
 */
const MINIMUM_TABLES = 400;

const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/** How many `jsonb` columns one table declares. */
function jsonbColumnCount(table: PgTable): number {
  let count = 0;
  for (const column of Object.values(getTableColumns(table))) {
    if ((column as { columnType?: string }).columnType === 'PgJsonb') count += 1;
  }
  return count;
}

describe('the jsonb register covers every table', () => {
  it('traversed a real schema', () => {
    expect(
      tables.length,
      'the barrel exported almost nothing — a broken import makes every assertion below vacuous',
    ).toBeGreaterThanOrEqual(MINIMUM_TABLES);
  });

  it('every register entry names a real table', () => {
    // An entry that matches nothing excuses nothing while looking like care —
    // the rule `ID_COLUMNS_WITHOUT_FOREIGN_KEY` and every isolation gate here
    // states about its own exemptions.
    const names = new Set(tables.map((table) => getTableName(table)));
    for (const name of Object.keys(JSONB_REGISTER)) {
      expect(names.has(name), `the register names "${name}", which is not a table`).toBe(true);
    }
  });

  it('no table outside the register declares a jsonb column', () => {
    const unregistered = tables
      .filter((table) => jsonbColumnCount(table) > 0)
      .map((table) => getTableName(table))
      .filter((name) => !(name in JSONB_REGISTER))
      .sort();
    expect(
      unregistered,
      'a jsonb column landed on a table with no register row. `CONVENTIONS.md` says jsonb is for '
        + 'genuinely shape-less data only — a price, an address or a set of totals is not. If this '
        + 'one earned it, add the table and its count above; that line IS the register row.',
    ).toEqual([]);
  });

  it('every registered table declares exactly the stated number', () => {
    // Exact, not a floor: a SECOND jsonb column on a table that already earned
    // one is the likeliest way this policy erodes, and a `>= 1` would never see
    // it.
    for (const [name, expected] of Object.entries(JSONB_REGISTER)) {
      const table = tables.find((candidate) => getTableName(candidate) === name);
      expect(table, `${name} disappeared from the barrel`).toBeDefined();
      if (table === undefined) continue;
      expect(jsonbColumnCount(table), `${name} no longer declares ${String(expected)}`).toBe(
        expected,
      );
    }
  });

  it('the detector can see a jsonb column at all — the mutation self-test', () => {
    // Every assertion above is an absence over unregistered tables, and an
    // absence check whose detector cannot match reports the same clean pass
    // forever. This proves `jsonbColumnCount` returns a non-zero for a table
    // that genuinely has one.
    const registered = tables.find(
      (table) => getTableName(table) === 'moderation_outboxes',
    );
    expect(registered, 'the control table is gone; pick another register entry').toBeDefined();
    if (registered !== undefined) expect(jsonbColumnCount(registered)).toBeGreaterThan(0);
    // And that it returns ZERO for one that does not, so the count is reading
    // the column type rather than answering non-zero for everything.
    const plain = tables.find((table) => jsonbColumnCount(table) === 0);
    expect(plain, 'every table has a jsonb column, which cannot be right').toBeDefined();
  });
});
