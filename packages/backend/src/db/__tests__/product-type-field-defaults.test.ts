/**
 * A product-type field may not carry a DEFAULT ANSWER (#367, ADR 0007 D5).
 *
 * ## What this protects, and what was protecting it before
 *
 * The epic's product-type requirements ask for defaults "only when semantically
 * safe; never invent unknown facts", and the second clause is the one with teeth:
 * a default answer is a fact about a product that nobody asserted. Prefill a
 * smartphone form's `water_resistance` with `none` and every listing authored
 * through it claims something its seller never said — indistinguishable, in the
 * stored row, from a seller who checked the box.
 *
 * `product_type_fields` carries no such column today. **Nothing was stopping one
 * from being added.** `product-type-schema.test.ts`'s "names them exactly" asserts
 * TABLE names, not column sets; its jsonb census counts jsonb columns, so it would
 * catch `default_value jsonb` and miss `default_value text`. Measured before
 * writing this file: adding `defaultValue: text()` to `product_type_fields` left
 * the entire backend suite green.
 *
 * `services/catalog-authoring/schema.service.ts` records the same principle for
 * the two fields next door — "`placeholder` and `example` are modelled … and are
 * ABSENT because no table in this repository carries one. An invented example is
 * a claim about a product nobody made" — and that record has no gate either. This
 * is the gate, for the stronger case: a placeholder is help text a form shows, and
 * a default is a value a form SUBMITS.
 *
 * ## What it does NOT claim
 *
 * It does not claim a default mechanism would be wrong in every case. The epic
 * permits one "when semantically safe", and if a requirement ever names such a
 * field the answer is a column plus a decision recorded beside it plus this list
 * narrowed in the same change — which is exactly the conversation a build failure
 * here starts. What it refuses is a default arriving without that conversation.
 *
 * ## Scope, stated rather than assumed
 *
 * Every table `schema/productTypes.ts` declares, DERIVED from the module rather
 * than hand-listed, and no others. `attribute_definitions` is #94's
 * and legitimately carries `assumed_unit` on a sibling table — a recorded fact
 * about a FEED's convention, not a value handed to an author — so a scan wide
 * enough to include the registry would need an exemption on its first run, and an
 * exemption is what this kind of gate dies of. The registry's own half is stated
 * in the report that came with this file rather than enforced here.
 *
 * Built with the house gate defences: the forbidden list is a VALUE with its
 * length asserted, the walk's population size is asserted and PRINTED on success,
 * the detector is exercised against a NEGATIVE control (the real columns, which
 * must not fire) and a POSITIVE one (a synthetic table carrying the column)
 * through the SAME function the real scan calls.
 */

import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import * as productTypeSchema from '../schema/productTypes.js';

/**
 * The spellings a default answer would arrive under, as SQL column names.
 *
 * Full names rather than fragments, deliberately. A fragment scan (`default`,
 * `assumed`) reads as a stronger gate and is a worse one: it fires on legitimate
 * neighbours — `assumed_unit` one domain over is a recorded feed convention — and
 * the fix somebody reaches for is an exemption list, which is where a gate stops
 * measuring. Every entry here is a name that could only ever mean "the value to
 * put in the form before the author types anything".
 */
const DEFAULT_ANSWER_COLUMNS = [
  'default_value',
  'default_answer',
  'default_text',
  'default_number',
  'default_enum_value_id',
  'prefill',
  'prefill_value',
  'prefilled_value',
  'suggested_value',
  'initial_value',
  'preset_value',
  'seed_value',
  'implied_value',
  'assumed_value',
  'fallback_value',
  'placeholder_value',
] as const;

/**
 * Every table the product-type module declares, DERIVED from the module.
 *
 * This was a hand list of the four tables ADR 0007 D5 names, and a hand list is
 * the wrong shape here for a reason that has nothing to do with tidiness: the
 * module GROWS. `product_type_aliases` landed later, and against the hand list
 * it was simply not scanned — a `default_value` on it would have been invisible
 * and this gate would have stayed green while covering less of the schema than
 * it did the day it was written. Nothing fails in that story; the population
 * quietly stops keeping up, which is the one failure a green suite cannot
 * report.
 *
 * Derived, a table added to `schema/productTypes.ts` tomorrow is in scope
 * tomorrow. The count assertion below is what makes the derivation itself
 * falsifiable — an import that resolved to nothing would otherwise walk an
 * empty population and pass every assertion in the file.
 */
const PRODUCT_TYPE_TABLES = Object.values(productTypeSchema).flatMap((value) =>
  is(value, PgTable) ? [value] : [],
);

/**
 * Every forbidden column one table declares.
 *
 * The ONE detector. The self-tests below drive this exact function rather than a
 * copy fed literals, because a control on a different instrument is a control on
 * nothing.
 *
 * **`sqlColumnName(column)` and never `column.name`.** A drizzle column reports
 * its TypeScript PROPERTY name — `valuePolicy`, not `value_policy` — so a scan
 * comparing that against snake_case spellings can never fire, on any input, and
 * reports a clean zero forever. Measured: the first version of this file did
 * exactly that, and both self-tests below are what caught it. `@oxyhq/db`'s helper
 * applies `DATABASE_CASING`, the same setting `drizzle.config.ts` reads, so the
 * string compared here is the string the migration writes.
 */
function defaultAnswerColumnsOf(table: Parameters<typeof getTableConfig>[0]): string[] {
  const config = getTableConfig(table);
  const forbidden: string[] = [];
  for (const column of config.columns) {
    const sqlName = sqlColumnName(column);
    if ((DEFAULT_ANSWER_COLUMNS as readonly string[]).includes(sqlName)) {
      forbidden.push(`${config.name}.${sqlName}`);
    }
  }
  return forbidden;
}

describe('the forbidden list and the walked population are both real', () => {
  it('names a bounded set of spellings, and the count is asserted', () => {
    // A list a gate reads has to be pinned, or a later edit that empties it
    // leaves every assertion below trivially true.
    expect(DEFAULT_ANSWER_COLUMNS).toHaveLength(16);
    expect(new Set(DEFAULT_ANSWER_COLUMNS).size).toBe(DEFAULT_ANSWER_COLUMNS.length);
  });

  it('walks every table the module declares, and a non-trivial number of columns', () => {
    const names = PRODUCT_TYPE_TABLES.map((table) => getTableConfig(table).name).sort();

    // A CONTAINMENT assertion plus a count, not an exact list. The exact list is
    // what made the old hand-rolled population silently stop covering the module
    // when it grew — and re-stating the derived set here would reintroduce
    // exactly that, one indirection further along.
    //
    // These five must be present because each is named by ADR 0007 D5 or landed
    // with a decision recorded beside it; the count is what fails when a SIXTH
    // arrives, which is the conversation this gate exists to start.
    for (const required of [
      'product_type_definitions',
      'product_type_category_scopes',
      'product_type_field_groups',
      'product_type_fields',
      'product_type_aliases',
    ]) {
      expect(names, `${required} is not in the derived population`).toContain(required);
    }
    expect(names).toHaveLength(5);

    process.stdout.write(
      `\n  [product-type defaults census] ${names.length} tables derived from the module: ` +
        `${names.join(', ')}\n`,
    );

    const columnCount = PRODUCT_TYPE_TABLES.reduce(
      (total, table) => total + getTableConfig(table).columns.length,
      0,
    );
    // The vacuity floor. Four tables that resolved to zero columns would make the
    // assertion below pass while measuring nothing at all — which is exactly how
    // a schema census reports clean against the wrong artefact.
    //
    // 36 against a measured 40, deliberately loose by four: a floor pinned at the
    // exact population turns any legitimate column removal in another lane into a
    // red in THIS file, naming a rule that has nothing to do with the change.
    // Loose enough to tolerate that, tight enough that a walk resolving a handful
    // of columns — the failure it exists for — still fails.
    expect(columnCount).toBeGreaterThanOrEqual(36);
    console.log(
      `[product-type defaults gate] scanned ${names.length} tables, ${columnCount} columns, against ${DEFAULT_ANSWER_COLUMNS.length} forbidden spellings`,
    );
  });
});

describe('no product-type table can hand an author a value nobody asserted', () => {
  it('declares no default-answer column', () => {
    const found = PRODUCT_TYPE_TABLES.flatMap(defaultAnswerColumnsOf);
    expect(found).toEqual([]);
  });
});

describe('the detector actually detects — the mutation self-test', () => {
  it('fires on a table that declares one, through the SAME function', () => {
    // A name of its own, NOT `product_type_fields`. Drizzle's `CasingCache` keys
    // its derivations on the table name, so a probe impersonating the real table
    // reads its cached column map, finds no `defaultValue` in it, falls back to
    // the property name and the probe silently measures nothing — which is what
    // this test did on its first run and why the name is deliberate.
    const mutated = pgTable('product_type_fields_default_probe', {
      attributeKey: text(),
      defaultValue: text(),
    });

    expect(defaultAnswerColumnsOf(mutated)).toEqual([
      'product_type_fields_default_probe.default_value',
    ]);
  });

  it('does NOT fire on the real columns — the negative control', () => {
    // Without this the test above passes for a detector that fires on
    // everything, and the gate would be red on the day it was written.
    //
    // It also pins the CASING, which is the half that actually went wrong here:
    // asserting `value_policy` is present is what fails if somebody replaces
    // `sqlColumnName` with `column.name` and turns the whole gate vacuous.
    const real = getTableConfig(productTypeSchema.productTypeFields).columns.map((column) => sqlColumnName(column));
    expect(real).toContain('value_policy');
    expect(real).toContain('requirement');
    expect(real).toContain('position');
    expect(defaultAnswerColumnsOf(productTypeSchema.productTypeFields)).toEqual([]);
  });
});
