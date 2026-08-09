/**
 * The canonical graph's critical reads still use the indexes #61 measured them
 * on — asserted against a REAL PostgreSQL server, on every push.
 *
 * #61's decision rule 8 asks that query plans stay "deterministic enough to
 * regression-test the important shapes", and this is that test. The benchmark
 * script (`scripts/graph-query-benchmark.ts`) produces the numbers; nothing
 * about producing them stops somebody deleting an index, adding a column to an
 * ORDER BY, or respelling a predicate so the index can no longer serve it. Each
 * of those leaves a build that is green, a suite that passes and a page that got
 * fifty times slower — which is the shape of every performance regression that
 * ever reached production.
 *
 * ## It drives the SAME workload table the report does
 *
 * `WORKLOAD_SHAPES` is imported, not re-listed. A shape added to the benchmark
 * is therefore gated here automatically, and a shape whose `requireIndexes` was
 * quietly relaxed fails `workload.test.ts` instead. There is no second list to
 * drift.
 *
 * ## Its own database, because the generator TRUNCATES
 *
 * Every other realdb test shares the one throwaway database `globalSetup`
 * creates. This file must not: it seeds a whole graph and truncates first, which
 * would delete every other file's fixtures — and vitest runs files in parallel,
 * so it would do so mid-assertion. So it creates and drops its own throwaway,
 * whose `oxydb_test_<hex>` name is the second pattern `seedGraph` will truncate.
 *
 * ## Why the seed is not tiny
 *
 * The `ci` scale is four thousand products and sixteen thousand offers, which
 * takes seconds. It is not smaller because the property under test is a PLANNER
 * DECISION: below some size Postgres correctly prefers a heap scan to an index,
 * and a gate that fires at that size is failing for a reason that has nothing to
 * do with the schema. A gate that cries wolf is a gate whoever hits it next
 * disables.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { createDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from '../schema/index.js';
import type { Database } from '../postgres.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../testDatabase.js';
import {
  BENCHMARK_SCALES,
  countSeededRows,
  rowCountFloors,
  seedGraph,
  type SeededGraph,
} from '../../services/graph-benchmark/dataset.js';
import {
  findRowCountViolations,
  findVacuityViolations,
  parsePlanJson,
} from '../../services/graph-benchmark/measure.js';
import { WORKLOAD_SHAPES } from '../../services/graph-benchmark/workload.js';

const SCALE = BENCHMARK_SCALES['ci'];
if (!SCALE) throw new Error('The `ci` benchmark scale is missing.');

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;
let graph: SeededGraph;

/**
 * Statements the driver issues for itself. Same list as the runner's, and it is
 * a COPY on purpose: exporting the runner's would make a benchmark internal
 * part of this file's contract for no gain, and the two are three words long.
 */
const DRIVER_NOISE = /^\s*(begin|commit|rollback|discard|set|show|select\s+1\s*$)/i;

interface Captured {
  readonly text: string;
  readonly parameters: readonly postgres.ParameterOrJSON<never>[];
}

let recording = false;
let captured: Captured[] = [];

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: {
      max: 4,
      onnotice: () => undefined,
      debug: (
        _connection: number,
        query: string,
        parameters: readonly postgres.ParameterOrJSON<never>[],
      ): void => {
        if (!recording || DRIVER_NOISE.test(query)) return;
        captured.push({ text: query, parameters: [...parameters] });
      },
    },
  });
  client = instance.client;
  db = instance.db;
  graph = await seedGraph(db, SCALE);
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

interface ExplainRow {
  readonly 'QUERY PLAN': unknown;
}

type PlanFacts = ReturnType<typeof parsePlanJson>;

/**
 * Carries a plan out of a transaction that has to be rolled back.
 *
 * postgres.js rolls back only on a throw, so a value produced inside one cannot
 * be returned. A named class rather than a property bolted onto an `Error`, so
 * the catch below narrows on `instanceof` and a genuine failure inside the
 * transaction still propagates instead of being mistaken for a carrier.
 */
class PlanCarrier extends Error {
  constructor(readonly plan: PlanFacts) {
    super('benchmark rollback');
    this.name = 'PlanCarrier';
  }
}

/** EXPLAIN one captured statement on the pool. */
async function explainOnPool(statement: Captured): Promise<PlanFacts> {
  const rows = await client.unsafe<ExplainRow[]>(
    `explain (analyze, buffers, format json) ${statement.text}`,
    [...statement.parameters],
  );
  return parsePlanJson(rows[0]?.['QUERY PLAN']);
}

/**
 * EXPLAIN one captured statement inside a transaction that is rolled back,
 * optionally after running some DDL first.
 *
 * The DDL hook is what makes the mutation self-test possible: an index can be
 * dropped, the plan re-taken without it, and the drop undone, without the
 * suite's own database ever losing the index.
 */
async function explainInRollback(statement: Captured, before?: string): Promise<PlanFacts> {
  try {
    await client.begin(async (tx) => {
      if (before !== undefined) await tx.unsafe(before);
      const rows = await tx.unsafe<ExplainRow[]>(
        `explain (analyze, buffers, format json) ${statement.text}`,
        [...statement.parameters],
      );
      throw new PlanCarrier(parsePlanJson(rows[0]?.['QUERY PLAN']));
    });
  } catch (error) {
    if (error instanceof PlanCarrier) return error.plan;
    throw error;
  }
  throw new Error('The measuring transaction produced no plan.');
}

/** Run one shape against the recording handle and return what it sent. */
async function captureShapeStatement(shapeId: string): Promise<Captured> {
  const shape = WORKLOAD_SHAPES.find((candidate) => candidate.id === shapeId);
  if (!shape) throw new Error(`${shapeId} is missing from the workload.`);
  recording = true;
  captured = [];
  try {
    if (shape.mutates) {
      await db
        .transaction(async (tx) => {
          await shape.run(tx, graph);
          tx.rollback();
        })
        // `instanceof`, never a `.name` check: drizzle's rollback signal
        // reports its name as `DrizzleError`, so matching on the string lets a
        // deliberate rollback escape as a test failure. Measured here.
        .catch((error: unknown) => {
          if (error instanceof TransactionRollbackError) return;
          throw error;
        });
    } else {
      await shape.run(db, graph);
    }
  } finally {
    recording = false;
  }
  const first = captured[0];
  if (!first) throw new Error(`${shapeId} issued no statement.`);
  return first;
}

describe('canonical graph query plans', () => {
  it('seeds a dataset that clears every row floor', async () => {
    // The vacuity floor for the gate itself. A generator that wrote nothing
    // produces plans that are trivially correct and prove nothing, and an
    // all-green run over an empty database is exactly what a broken seed looks
    // like from outside.
    const violations = findRowCountViolations(await countSeededRows(db), rowCountFloors(SCALE));
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every shipped read still uses the index it was measured on', async () => {
    const failures: string[] = [];
    let checked = 0;

    for (const shape of WORKLOAD_SHAPES) {
      const statement = await captureShapeStatement(shape.id);
      // A mutating shape is EXPLAINed inside a rolled-back transaction for the
      // reason the runner documents: `EXPLAIN ANALYZE` really executes, and the
      // freshness sweep would otherwise retire the rows later shapes measure.
      const analysis = shape.mutates
        ? await explainInRollback(statement)
        : await explainOnPool(statement);
      failures.push(...findVacuityViolations(shape.id, analysis, shape.expectation));
      checked += 1;
    }

    // A traversal that ran zero shapes would report zero failures.
    expect(checked).toBe(WORKLOAD_SHAPES.length);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 300_000);

  it('the three indexes #61 adopted exist and are the ones the plans name', async () => {
    // Named explicitly as well as exercised above, because a missing index and
    // a planner that stopped choosing one are different faults with different
    // fixes, and the message a red build carries should say which.
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where indexname in (
        'canonical_products_brand_page_idx',
        'canonical_products_normalized_name_gist_trgm_idx',
        'offers_variant_price_sort_idx'
      )`);
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      'canonical_products_brand_page_idx',
      'canonical_products_normalized_name_gist_trgm_idx',
      'offers_variant_price_sort_idx',
    ]);
  });

  it('the offer comparison sort is served by the index, with no Sort node', async () => {
    // The specific property `offers_variant_price_sort_idx` was added for, and
    // the one a reader could silently lose by changing the ORDER BY expression:
    // the index stores `coalesce(price_amount, <MAX_MONEY_MINOR_UNITS>)`, so a
    // reader that coalesces to a different sentinel gets a plan that no longer
    // uses it. Asserted on the PLAN rather than on the latency, because a
    // latency assertion on shared CI hardware is a flake generator.
    const analysis = await explainOnPool(await captureShapeStatement('Q05'));
    expect(analysis.indexNames).toContain('offers_variant_price_sort_idx');
    expect(analysis.nodeTypes).not.toContain('Sort');
    // And it reads about what it returns rather than the whole variant: the
    // amplification IS the regression this index removed.
    expect(analysis.rowsScanned).toBeLessThan(analysis.rowsReturned * 3);
  });

  it('the trigram search orders through the GiST index rather than sorting', async () => {
    // `ORDER BY similarity(...) DESC` and `ORDER BY name <-> $1` return the same
    // rows in the same order; only the second can be served by an index. A
    // future reader "tidying" the distance operator back into a `similarity`
    // call is the regression, and it is invisible to every other check.
    const statement = await captureShapeStatement('Q10');
    expect(statement.text, 'the reader stopped spelling its ordering as a distance').toContain(
      '<->',
    );
    const analysis = await explainOnPool(statement);
    expect(analysis.indexNames).toContain('canonical_products_normalized_name_gist_trgm_idx');
    expect(analysis.nodeTypes).not.toContain('Sort');
  });

  it('the plan assertions actually detect — the mutation self-test', async () => {
    // Break the thing the gate guards and confirm the gate sees it: drop the
    // brand-page index inside a transaction, re-plan the brand page without it,
    // and check that the SAME expectation the loop above applies now fails and
    // names the shape. Without this, a `requireIndexes` list that had stopped
    // being applied would satisfy every assertion above by matching nothing.
    const shape = WORKLOAD_SHAPES.find((candidate) => candidate.id === 'Q07');
    expect(shape, 'Q07 is missing from the workload').toBeDefined();
    if (!shape) return;

    const statement = await captureShapeStatement('Q07');
    const healthy = await explainOnPool(statement);
    expect(findVacuityViolations('Q07', healthy, shape.expectation)).toEqual([]);

    const mutated = await explainInRollback(
      statement,
      'drop index canonical_products_brand_page_idx',
    );
    expect(mutated.indexNames).not.toContain('canonical_products_brand_page_idx');
    // Without the index the whole brand is sorted, so the amplification the
    // index removed comes straight back.
    expect(mutated.rowsScanned).toBeGreaterThan(healthy.rowsScanned * 10);

    const violations = findVacuityViolations('Q07', mutated, {
      ...shape.expectation,
      requireIndexes: ['canonical_products_brand_page_idx'],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/Q07/);
    expect(violations[0]).toMatch(/canonical_products_brand_page_idx/);

    // And the index really is back — the rollback undid the drop.
    const restored = await explainOnPool(statement);
    expect(restored.indexNames).toContain('canonical_products_brand_page_idx');
  }, 120_000);
});
