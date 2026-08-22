/**
 * THE CENSUS — the gate that makes epic #367's "No historical commerce snapshot
 * is rewritten" checkable in the ADD direction.
 *
 * The claim is about COMPLETENESS. Nobody verifies it by reading the schema:
 * finding fewer order-referencing tables looks identical to there BEING fewer,
 * and the miss is silent. So the population is DERIVED here — the transitive
 * foreign-key closure of `orders`, walked over the same drizzle objects
 * drizzle-kit emits DDL from — and `commerceHistoryDispositions.ts` must cover
 * exactly it. A new table naming an order fails the build until somebody says
 * what a migration may rewrite in it, which forces the decision at the moment
 * the reference is added, by the person adding it.
 *
 * This file reads no database on purpose: the drizzle schema is what GENERATES
 * the migrations, so a table added to the barrel is caught on the push that adds
 * it rather than on the next run that happens to have Postgres available.
 * `order-history-immutability.realdb.test.ts` is the other half — it EXECUTES
 * every disposition against a real server, and it cross-checks this closure
 * against `pg_constraint`, so the two derivations cannot drift apart silently.
 *
 * The defences `~/Oxy/AGENTS.md` prescribes for a census are all here: a VACUITY
 * FLOOR on the schema size and on the closure size, a POSITIVE CONTROL that the
 * walk reaches a known depth-2 and a known depth-3 table (a traversal that
 * stopped at depth 1 would otherwise report a tidy, wrong, smaller population),
 * and MUTATION SELF-TESTS in both directions.
 */

import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index.js';
import {
  COMMERCE_HISTORY_DISPOSITIONS,
  COMMERCE_HISTORY_ROOT_TABLES,
  type CommerceHistoryDisposition,
} from '../commerceHistoryDispositions.js';

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/**
 * The schema is this big.
 *
 * Not an exact count: this file has no opinion about how many tables Mercaria
 * has, and pinning one would conflict on every unrelated branch. What it defends
 * against is a barrel that stopped exporting — at which point the closure below
 * would be `{orders}` and the census would pass by measuring nothing.
 */
const SCHEMA_TABLE_FLOOR = 300;

/**
 * The closure is this big.
 *
 * A floor rather than the exact number for the same reason, and it is the
 * measurement that matters: at the time of writing the walk finds 57 tables, so
 * a traversal that broke and returned only the root, or only its direct
 * children, fails here instead of reporting a complete-looking plan.
 */
const CLOSURE_FLOOR = 62;

/** At least this many of them must actually be enforced, or the gate proves nothing. */
const ENFORCED_FLOOR = 30;

/**
 * And this many columns must be declared frozen.
 *
 * Measured at the time of writing: 112, of which 67 are the payment and refund
 * snapshots #367 line 75 added. A floor rather than the exact number so an
 * unrelated branch adding one does not conflict here — but a HIGH floor,
 * because the failure this defends against is a ledger that quietly lost its
 * column declarations and still passed every "the database agrees" assertion in
 * the realdb half, which is driven entirely from these lists.
 */
const FROZEN_COLUMN_FLOOR = 95;

/**
 * Walk every foreign key in the schema and return the transitive closure of
 * tables reachable from the root.
 *
 * `getTableConfig(...).foreignKeys` is drizzle's own reflection of what it will
 * emit, so this cannot disagree with the DDL the way a grep over source could.
 *
 * Direction: CHILD → PARENT edges are followed backwards, because the question
 * is "what names an order", not "what does an order name".
 */
function closureFrom(roots: readonly string[]): ReadonlySet<string> {
  const childrenOf = new Map<string, Set<string>>();
  for (const table of tables) {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const parent = getTableName(foreignKey.reference().foreignTable);
      if (parent === config.name) continue;
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.add(config.name);
      else childrenOf.set(parent, new Set([config.name]));
    }
  }

  const reached = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const child of childrenOf.get(next) ?? []) {
      if (reached.has(child)) continue;
      reached.add(child);
      queue.push(child);
    }
  }
  return reached;
}

/** The same comparison the census makes, factored out so a mutation can drive it. */
function coverageGaps(
  population: ReadonlySet<string>,
  declared: readonly CommerceHistoryDisposition[],
): { readonly undeclared: readonly string[]; readonly extra: readonly string[] } {
  const declaredNames = new Set(declared.map((entry) => entry.table));
  return {
    undeclared: [...population].filter((table) => !declaredNames.has(table)).sort(),
    extra: [...declaredNames].filter((table) => !population.has(table)).sort(),
  };
}

describe('the order-history population is derived, not remembered', () => {
  it('walks a schema of a plausible size', () => {
    expect(tables.length).toBeGreaterThanOrEqual(SCHEMA_TABLE_FLOOR);
  });

  it('reaches past the root and past its direct children', () => {
    const population = closureFrom(COMMERCE_HISTORY_ROOT_TABLES);
    expect(population.size).toBeGreaterThanOrEqual(CLOSURE_FLOOR);

    // Positive controls at three depths. A walk that stopped early would still
    // return a tidy set, and `orders` alone would satisfy any test that only
    // asked whether the closure was non-empty.
    expect(population.has('orders')).toBe(true); // depth 0, the root
    expect(population.has('order_items')).toBe(true); // depth 1
    expect(population.has('order_item_option_values')).toBe(true); // depth 2, via order_items
    expect(population.has('draft_order_line_item_option_values')).toBe(true); // depth 3

    // The payment half, which the `orders` walk provably cannot reach: the
    // domain holds no foreign key to `orders` on purpose, so these arrive only
    // because the payment schema module contributes its own roots. If that
    // derivation broke, the population would silently shrink back to 57 and
    // every payment disposition below would report as `extra` rather than as
    // missing enforcement — which is why they are asserted by name here.
    expect(population.has('payments')).toBe(true); // a root, from payments.ts
    expect(population.has('transfers')).toBe(true); // depth 1 from payments
    expect(population.has('ledger_entries')).toBe(true); // depth 2, via ledger_transactions

    // And a negative control: a table with no path to an order or a payment
    // must NOT be in it, or the walk has collapsed into "every table in the
    // schema" — which the 454-table floor above would not notice.
    expect(population.has('brands')).toBe(false);
    expect(population.has('categories')).toBe(false);
  });

  it('is covered by the disposition ledger EXACTLY', () => {
    const population = closureFrom(COMMERCE_HISTORY_ROOT_TABLES);
    const gaps = coverageGaps(population, COMMERCE_HISTORY_DISPOSITIONS);

    expect(
      gaps.undeclared,
      'These tables hold a fact about a placed order and no disposition says what a ' +
        'migration may rewrite in them. Add an entry to `commerceHistoryDispositions.ts` ' +
        'saying what the database does to an UPDATE and a DELETE, and why.',
    ).toEqual([]);

    expect(
      gaps.extra,
      'These tables are declared but no longer reachable from `orders`. Remove them, ' +
        'or restore the foreign key that made them commerce history.',
    ).toEqual([]);
  });

  it('declares each table exactly once', () => {
    const names = COMMERCE_HISTORY_DISPOSITIONS.map((entry) => entry.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every entry a reason, and every reason a sentence', () => {
    for (const entry of COMMERCE_HISTORY_DISPOSITIONS) {
      expect(entry.reason.trim().length, `${entry.table} has no reason`).toBeGreaterThan(20);
    }
  });

  it('declares enough enforcement to be worth checking', () => {
    // The vacuity floor that matters most. Every assertion in the realdb half is
    // driven from these declarations, so a ledger that declared everything
    // `allowed` would execute a probe over 57 tables and assert nothing.
    const enforced = COMMERCE_HISTORY_DISPOSITIONS.filter(
      (entry) =>
        entry.rowUpdate === 'refused' ||
        entry.rowDelete === 'refused' ||
        entry.frozenColumns.length > 0,
    );
    expect(enforced.length).toBeGreaterThanOrEqual(ENFORCED_FLOOR);

    const frozen = COMMERCE_HISTORY_DISPOSITIONS.flatMap((entry) => entry.frozenColumns);
    expect(frozen.length).toBeGreaterThanOrEqual(FROZEN_COLUMN_FLOOR);

    // A frozen column must be named ONCE per table. A duplicate is how a list
    // that looks longer than it is passes the floor above while covering less.
    for (const entry of COMMERCE_HISTORY_DISPOSITIONS) {
      expect(
        new Set(entry.frozenColumns).size,
        `${entry.table} names a frozen column twice`,
      ).toBe(entry.frozenColumns.length);
    }

    // The payment and refund half specifically, so a regression that dropped
    // exactly those declarations cannot hide inside a total the order tables
    // alone very nearly satisfy.
    const payAndRefund = COMMERCE_HISTORY_DISPOSITIONS.filter((entry) =>
      ['payments', 'refunds', 'transfers', 'payouts', 'provider_accounts'].includes(entry.table),
    );
    expect(payAndRefund).toHaveLength(5);
    // Measured: 51 across those five.
    expect(payAndRefund.flatMap((entry) => entry.frozenColumns).length).toBeGreaterThanOrEqual(48);
  });
});

describe('the census itself goes red', () => {
  it('names a table the ledger forgot', () => {
    const population = closureFrom(COMMERCE_HISTORY_ROOT_TABLES);
    const withoutOrderItems = COMMERCE_HISTORY_DISPOSITIONS.filter(
      (entry) => entry.table !== 'order_items',
    );
    const gaps = coverageGaps(population, withoutOrderItems);
    expect(gaps.undeclared).toEqual(['order_items']);
    expect(gaps.extra).toEqual([]);
  });

  it('names a table the ledger invented', () => {
    const population = closureFrom(COMMERCE_HISTORY_ROOT_TABLES);
    const invented: CommerceHistoryDisposition = {
      table: 'a_table_that_does_not_exist',
      rowUpdate: 'allowed',
      rowDelete: 'allowed',
      frozenColumns: [],
      reason: 'a mutation, present only inside this test',
    };
    const gaps = coverageGaps(population, [...COMMERCE_HISTORY_DISPOSITIONS, invented]);
    expect(gaps.undeclared).toEqual([]);
    expect(gaps.extra).toEqual(['a_table_that_does_not_exist']);
  });

  it('would report a SMALLER population if the walk stopped at depth 1', () => {
    // The self-test for the traversal rather than for the comparison: a
    // one-level walk is what a broken closure degrades into, and it must not
    // still satisfy the floor. Measured: 27 direct children against 57 reachable.
    const directChildren = new Set<string>(COMMERCE_HISTORY_ROOT_TABLES);
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const foreignKey of config.foreignKeys) {
        if (
          COMMERCE_HISTORY_ROOT_TABLES.includes(
            getTableName(foreignKey.reference().foreignTable),
          )
        ) {
          directChildren.add(config.name);
        }
      }
    }
    const full = closureFrom(COMMERCE_HISTORY_ROOT_TABLES);
    expect(directChildren.size).toBeLessThan(full.size);
    expect(directChildren.size).toBeLessThan(CLOSURE_FLOOR);
  });
});
