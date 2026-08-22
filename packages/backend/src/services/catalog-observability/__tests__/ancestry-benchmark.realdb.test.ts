/**
 * ADR 0007 D2's taxonomy hierarchy benchmark, RUN — against a real PostgreSQL
 * server, on a tree this file seeds itself.
 *
 * D2 adopted the materialized path of ids provisionally and said the ADR is
 * amended if a benchmark disagrees. This file is where that benchmark actually
 * executes, where its floors are checked, and where the numbers are printed so
 * a run is legible rather than merely green.
 *
 * ## Its own database, for two independent reasons
 *
 * The shared throwaway `globalSetup` creates carries every other file's
 * fixtures, and vitest runs files in parallel. Seeding five thousand categories
 * and six thousand canonical products into it would make every sibling's
 * category, matcher and catalogue read measure a tree it knows nothing about —
 * and would make THIS file's plans depend on whatever a sibling happened to have
 * inserted a moment earlier, which is a benchmark whose result changes with the
 * test ordering. `graph-plan-regression.realdb.test.ts` reaches the same
 * conclusion one directory over, for the same reason.
 *
 * The second reason is narrower and decides it on its own: this file runs
 * `ANALYZE` and asserts which INDEX the planner chooses. Planner choices are a
 * function of table statistics, so a sibling writing categories concurrently
 * would move the thing under measurement while it was being measured.
 *
 * ## Why no gate here asserts a PLANNER CHOICE
 *
 * The obvious gate — "the descendants read is served by
 * `categories_ancestor_ids_idx` and contains no `Seq Scan`" — is not reliably
 * true or reliably false at ADR 0007 D2's own stated scale, and finding that out
 * is most of what this file is for. On 5,010 categories the choice is
 * SELECTIVITY-driven and sits near the planner's own cost boundary: the
 * mid-depth shape (30 of 5,010 rows) gets a Bitmap Index Scan and the root shape
 * (500 of 5,010) gets a sequential scan, correctly, and the category-scoped read
 * has been observed BOTH ways on the same schema and seed. Two successive
 * readings of this file's own measurements reached opposite confident conclusions
 * before that was understood — see the module docblock of
 * `ancestry-benchmark.ts`, which records both and why each was wrong.
 *
 * So the property asserted is the one that cannot flip on statistics: the index
 * CAN serve `ancestor_ids @> array[$1]`, shown by taking the choice away from the
 * planner. That separates an unusable index (a schema defect: the wrong operator
 * class, a dropped index, a predicate respelt so no index can serve it) from a
 * planner preference on a small table (correct, and a fact about size and
 * selectivity). The node type the planner actually picks is deliberately NOT
 * asserted anywhere, and neither is the benchmark's VERDICT — a gate that fails
 * on a healthy change is a gate whoever hits it next deletes.
 *
 * ## What the mutation self-test is for
 *
 * "The plan uses `categories_ancestor_ids_idx`" passes trivially if the check
 * has stopped checking — a `requireIndexes` list no longer applied, a plan
 * parser returning an empty index set, an expectation composed from an undefined
 * field. So the index is dropped inside a transaction that is rolled back, the
 * same statement is re-planned, and the SAME gate is asserted to go red and to
 * NAME the index. Then the index is shown to be back, because a mutation
 * self-test whose rollback silently failed would leave every later measurement
 * taken against a different schema.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import {
  createMercariaTestDatabase,
  dropMercariaTestDatabase,
} from '../../../db/testDatabase.js';
import {
  findRowCountViolations,
  findVacuityViolations,
  type PlanAnalysis,
  type ShapeExpectation,
} from '../../graph-benchmark/measure.js';
import { createCapturingDatabase, type CapturingDatabase } from '../../graph-benchmark/runner.js';
import {
  ANCESTRY_SHAPES,
  ANCESTRY_TIE_BAND,
  ANCESTRY_TIE_FLOOR_MS,
  DEFAULT_ANCESTRY_LATENCY_RUNS,
  aggregatePlanFacts,
  deriveAncestryVerdict,
  explainStatement,
  renderAncestryReport,
  runAncestryBenchmark,
  SHAPE_OF_THE_TREE,
  type AncestryBenchmarkResult,
  type MeasuredStatement,
  type ShapeComparison,
  type StrategyMeasurement,
} from '../ancestry-benchmark.js';
import {
  CATEGORY_READ_SHAPES,
  categoryRegistryFloors,
  countSeededRegistry,
  seedCategorySchemaRegistry,
  type CategorySchemaFixture,
} from '../category-index-coverage.js';

/** The server to create the throwaway on — the variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

/**
 * Whether this is a full benchmark run.
 *
 * **#61's split, applied to this harness: the BENCHMARK is opt-in and the GATES
 * run in CI.** `graph-query-benchmark.ts` is gated behind `GRAPH_BENCHMARK=1`
 * while `graph-plan-regression.realdb.test.ts` runs on every push, and the
 * reasoning carries over exactly — but it was measured here rather than assumed.
 * This file creates its OWN throwaway database (the seeder truncates) and seeds
 * 5,010 categories and 5,760 products; with the full latency measurement on top,
 * running under the whole parallel realdb suite it became one of the heavy
 * own-database files that fail on connection pressure. Measured: two consecutive
 * full `-- realdb` runs failed six and four files respectively with almost no
 * overlap between the sets — the contention signature — and this file was in one
 * of them while passing alone and passing in its own directory.
 *
 * So by default CI measures the PLANS, which is the part that can regress and is
 * deterministic, and takes a cheap latency sample it does not draw conclusions
 * from. `ANCESTRY_BENCHMARK=1` runs the full measurement.
 */
const FULL_BENCHMARK = process.env['ANCESTRY_BENCHMARK'] === '1';

/**
 * Uninstrumented executions per strategy per shape.
 *
 * Two hundred for a full run, and the number is not arbitrary: at thirty samples
 * the p50 of the half-millisecond breadcrumb shape moved enough between
 * consecutive runs to flip which strategy it reported as faster. Which is exactly
 * why the CI value is LOW and the verdict it produces is reported rather than
 * asserted — a cheap sample is honest about being a sample, whereas a cheap
 * sample presented as a finding is the vacuity this whole domain is about.
 */
const LATENCY_RUNS = FULL_BENCHMARK ? DEFAULT_ANCESTRY_LATENCY_RUNS : 20;

/**
 * Filler rows for the scale probe, which runs only on a full benchmark.
 *
 * Thirty thousand is a size well above the seeded tree, and NOT a crossover
 * point. An earlier version of this comment said the crossover sits between
 * 20,000 and 30,000 categories; that did not reproduce — a later probe at 35,010
 * rows still showed no index use, while the mid-depth shape uses the index at
 * 5,010 — so there is no crossover figure worth quoting and the probe asserts no
 * planner choice. See the module docblock of `ancestry-benchmark.ts`.
 */
const SCALE_PROBE_FILLER_ROWS = 30_000;

let databaseUrl: string;
let capturing: CapturingDatabase;
let result: AncestryBenchmarkResult;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  capturing = createCapturingDatabase(databaseUrl);
  result = await runAncestryBenchmark(capturing, { latencyRuns: LATENCY_RUNS });
}, 600_000);

afterAll(async () => {
  if (capturing) await capturing.close();
  if (databaseUrl) await dropMercariaTestDatabase(databaseUrl);
});

/**
 * Carries a plan out of a transaction that has to be rolled back.
 *
 * postgres.js rolls back only on a throw, so a value produced inside one cannot
 * be returned. A named class rather than a property on a bare `Error`, so the
 * catch narrows on `instanceof` and a genuine failure inside the transaction
 * still propagates instead of being mistaken for a carrier.
 */
class PlanCarrier extends Error {
  constructor(readonly plan: PlanAnalysis) {
    super('ancestry benchmark rollback');
    this.name = 'PlanCarrier';
  }
}

/**
 * EXPLAIN one recorded statement after some setup, inside a rolled-back
 * transaction.
 *
 * `before` is a LIST because all three uses need more than one statement — a
 * planner setting plus a `DROP INDEX`, or a bulk insert plus an `ANALYZE` — and
 * a single-statement version would have been widened by the second caller
 * anyway.
 */
async function explainInRollback(
  statement: MeasuredStatement,
  before: readonly string[],
  /**
   * Observe the table AS PREPARED, inside the same transaction.
   *
   * Needed because a probe that grows a table and reports a plan cannot otherwise
   * prove it grew anything — the preparation and the assertion would be on
   * opposite sides of the rollback, so a `before` statement that silently did
   * nothing would produce exactly the reading the probe is looking for.
   */
  inspect?: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<PlanAnalysis> {
  try {
    await capturing.client.begin(async (tx: postgres.TransactionSql) => {
      for (const preparation of before) await tx.unsafe(preparation);
      if (inspect) await inspect(tx);
      throw new PlanCarrier(await explainStatement(tx, statement));
    });
  } catch (error) {
    if (error instanceof PlanCarrier) return error.plan;
    throw error;
  }
  throw new Error('The measuring transaction produced no plan.');
}

/**
 * `set local enable_seqscan = off` — how the index's USABILITY is separated from
 * the planner's PREFERENCE.
 *
 * At ADR 0007 D2's own stated scale the planner does not choose
 * `categories_ancestor_ids_idx` at all, and two very different facts produce
 * that same plan: an index that cannot serve `ancestor_ids @> array[$1]` (a
 * schema defect, and a serious one) and an index that can but is not worth it on
 * a table this small (a fact about the scale, and the correct decision). Only
 * taking the choice away from the planner tells them apart.
 *
 * `local`, so it dies with the transaction whether or not the rollback lands.
 */
const FORCE_INDEX = 'set local enable_seqscan = off';

/**
 * How much of `categories` a plan may look at and still be NARROW — a TENTH.
 *
 * The number is this file's own rather than a fresh one: the case that reports
 * the chosen plan already records that T1 reads 500 of 5,010 rows — a tenth —
 * and gets a sequential scan, "and correctly so. An index is the wrong tool for
 * a tenth of a small table." So a tenth is exactly the size at which this file
 * already says an index stops paying, and a forced plan that reads less than
 * that is doing the work the index exists for.
 */
const NARROW_FRACTION_OF_TABLE = 10;

/**
 * The most rows a plan may scan and still be narrow, given the table AS COUNTED
 * IN THE MEASURING TRANSACTION.
 *
 * A FRACTION OF THE LIVE TABLE, and never `rowsProduced`. What stood here was
 * `expect(forced.rowsScanned).toBe(comparison.materializedPath.rowsProduced)`,
 * which failed in CI as `expected 48 to be 30` (#810) on a diff that touched one
 * markdown file. The comment above it said the property is narrowness — "thirty
 * rows rather than the whole table" — and an equality does not test narrowness.
 * It equates two numbers of DIFFERENT KINDS, taken at two different moments:
 * `rowsProduced` is a logical result-set size and is a function of the seeded
 * tree, while `rowsScanned` is how many index entries the executor had to look
 * at, which includes entries for heap tuples the scan cannot see. Measured on
 * this schema: eighteen rows inserted in a transaction that is ROLLED BACK leave
 * eighteen entries behind and turn the identical statement's `rowsScanned` from
 * 30 into 48 while `rowsProduced` stays 30 — the reported failure exactly — and
 * a `VACUUM` puts it back to 30. None of that is a fact about the index.
 *
 * ONE definition, used by the case that asserts the bound holds and by the
 * mutation self-test that asserts it can be broken. Two spellings of one bound
 * is how the two come to disagree about what narrow means.
 *
 * A count that came back WRONG can only tighten this — zero rows makes it
 * unsatisfiable — so the direction it fails in is the safe one, and a second
 * assertion on the count would be a floor that cannot catch anything the bound
 * does not already catch louder.
 */
function narrowRowCeiling(tableRows: number): number {
  return tableRows / NARROW_FRACTION_OF_TABLE;
}

/** `select count(*) from categories`, for an {@link explainInRollback} `inspect`. */
async function countCategories(tx: postgres.TransactionSql): Promise<number> {
  const rows = await tx<{ rows: string }[]>`select count(*)::bigint as rows from categories`;
  // postgres.js decodes `bigint` as a STRING, so a bare value would divide as one.
  return Number(rows[0]?.rows ?? 0);
}

/** One shape's comparison, or a loud failure naming the shape that went missing. */
function comparisonFor(shapeId: string): ShapeComparison {
  const comparison = result.comparisons.find((candidate) => candidate.shapeId === shapeId);
  if (!comparison) throw new Error(`${shapeId} is missing from the measured comparisons.`);
  return comparison;
}

/** A synthetic side, for the pure-verdict cases no hardware would produce on demand. */
function fakeSide(rowsProduced: number, p50Ms: number, rowsScanned: number): StrategyMeasurement {
  return {
    strategy: 'materialized_path',
    statements: [],
    analyses: [],
    plan: {
      statementCount: 1,
      rowsReturned: rowsProduced,
      rowsScanned,
      executionTimeMs: p50Ms,
      planningTimeMs: 0,
      sharedHitBlocks: 0,
      sharedReadBlocks: 0,
      nodeTypes: [],
      indexNames: [],
    },
    latency: { runs: 1, p50Ms, p95Ms: p50Ms, p99Ms: p50Ms, minMs: p50Ms, maxMs: p50Ms },
    rowsProduced,
  };
}

describe('the taxonomy ancestry benchmark (ADR 0007 D2)', () => {
  it('seeded a real TREE, not a flat list', async () => {
    // The floor on the seed, which is the floor under every number below it. A
    // generator that wrote a tenth of what it announced produces plans that are
    // correct and latencies that are meaningless, and nothing downstream can
    // tell that apart from a fast database.
    expect(result.seedFloorViolations, result.seedFloorViolations.join('\n')).toEqual([]);

    // The positive control for the whole exercise, and the reason #61's dataset
    // could not be reused: `ancestor_ids` defaults to `'{}'` and stays that way
    // unless somebody builds a hierarchy, so a flat seed reads as a fast
    // benchmark rather than as a broken one. Assert the ancestry is POPULATED
    // and as deep as the tree claims.
    const ancestry = await capturing.db.execute<{
      populated: string | number;
      deepest: string | number;
      roots: string | number;
    }>(sql`
      select
        count(*) filter (where cardinality(ancestor_ids) > 0)::bigint as populated,
        max(cardinality(ancestor_ids))::bigint as deepest,
        count(*) filter (where parent_id is null)::bigint as roots
      from categories`);
    const row = ancestry[0];
    expect(row, 'the ancestry census returned no row').toBeDefined();
    expect(Number(row?.roots)).toBe(SHAPE_OF_THE_TREE.roots);
    expect(Number(row?.deepest)).toBe(result.seed.depth - 1);
    expect(Number(row?.populated)).toBe(result.seed.categoryCount - SHAPE_OF_THE_TREE.roots);

    process.stdout.write(
      `\n[ancestry] ${String(result.seed.categoryCount)} categories over ` +
        `${String(result.seed.depth)} levels, ${String(result.seed.productCount)} canonical ` +
        `products; root subtree ${String(result.seed.rootDescendants)} descendants / ` +
        `${String(result.seed.rootSubtreeProducts)} products, mid-depth subtree ` +
        `${String(result.seed.midDescendants)}, leaf ancestry ` +
        `${String(result.seed.leafAncestors)}\n`,
    );
  });

  it('measured every shape both ways, with the two sides agreeing on the answer', () => {
    // A traversal that ran zero shapes would report zero disagreements.
    expect(result.comparisons).toHaveLength(ANCESTRY_SHAPES.length);
    expect(result.comparisons.length).toBeGreaterThan(3);

    for (const comparison of result.comparisons) {
      // The two strategies are two spellings of ONE question. If they return
      // different row counts they are not comparable at all, and the timing
      // difference would be a fact about the mistake rather than about either
      // strategy.
      expect(
        comparison.materializedPath.rowsProduced,
        `${comparison.shapeId}: the strategies disagree about the answer`,
      ).toBe(comparison.recursiveCte.rowsProduced);
      expect(
        comparison.materializedPath.rowsProduced,
        `${comparison.shapeId}: below its floor — the measurement is vacuous`,
      ).toBeGreaterThanOrEqual(comparison.minRowsProduced);
    }

    // And the verdict was allowed to be reached at all.
    expect(result.verdict.adrD2, result.verdict.summary.join('\n')).not.toBe('inconclusive');
  });

  it('reports which plan the materialized path got at D2’s stated scale', () => {
    // The finding, recorded rather than asserted as a gate — and the TITLE says
    // "reports" for a measured reason. An earlier title claimed the index is NOT
    // used at this scale. That was wrong, and the way it was wrong is worth
    // keeping: the first measurements were taken before `analyze` had settled
    // statistics on the freshly seeded tree, and on that basis the sequential scan
    // costed 421 against the GIN bitmap scan's 947 and the conclusion drafted was
    // that ADR 0007 D2's "already in the schema and already indexed" does no work
    // at thousands of nodes. Repeated runs on settled statistics say the opposite.
    //
    // What is actually measured, stably, is the planner behaving correctly and
    // SELECTIVITY deciding — which is the textbook answer and vindicates D2's
    // index rather than questioning it:
    //
    //   T2 (mid-depth subtree, 30 of 5,010 rows — 0.6%): Bitmap Index Scan on
    //       `categories_ancestor_ids_idx`, 30 rows scanned rather than 5,010.
    //   T4 (category-scoped products): uses the index on SOME runs and not others,
    //       and that is the one shape whose RESULT turns on it — 2.32x for the
    //       materialized path with the index, a tie or a 1.18x recursive-CTE win
    //       without. It is why two of seven runs came out `disagrees`.
    //   T1 (root subtree, 500 of 5,010 — 10%): Seq Scan, and correctly so. An
    //       index is the wrong tool for a tenth of a small table.
    //
    // So the index does real work where it pays. What must NOT be read into that
    // is that the strategy wins everywhere regardless: T1 and T2 do win on every
    // run, and T4's win is CONDITIONAL on a plan choice this file has watched
    // change. An earlier version of this comment said "the strategy wins on every
    // shape either way", which cannot be true alongside two `disagrees` runs, and
    // read as reassurance rather than as a result.
    //
    // Which node type the planner picks is nonetheless deliberately NOT asserted,
    // here or in the scale probe below: it is a cost-model decision that moves
    // with statistics and with concurrent load, and this file has now watched it
    // move. What IS asserted is the pair that cannot flip on statistics — the
    // index CAN serve the predicate when the scan is taken away, and dropping the
    // index turns that red naming it.
    const comparison = comparisonFor('T2');
    expect(comparison.materializedPath.statements).toHaveLength(1);
    process.stdout.write(
      `\n[ancestry] T2 materialized path at ${String(result.seed.categoryCount)} categories: ` +
        `${comparison.materializedPath.plan.nodeTypes.join(' / ')}; indexes used: ` +
        `${comparison.materializedPath.plan.indexNames.join(', ') || 'NONE'}; ` +
        `${String(comparison.materializedPath.rowsProduced)} rows returned, ` +
        `${String(comparison.materializedPath.plan.rowsScanned)} scanned\n`,
    );
  });

  it('CAN serve the descendants predicate from categories_ancestor_ids_idx when the scan is taken away', async () => {
    const shape = ANCESTRY_SHAPES.find((candidate) => candidate.id === 'T2');
    expect(shape, 'T2 is missing from the shape table').toBeDefined();
    if (!shape?.materializedPathPlan) throw new Error('T2 declares no plan expectation.');

    const comparison = comparisonFor('T2');
    const statement = comparison.materializedPath.statements[0];
    if (!statement) throw new Error('T2 recorded no materialized-path statement.');

    // The floor comes from the seeded tree, never from a constant beside the
    // index list: two floors for one property is how the weaker one ends up
    // deciding.
    const expectation: ShapeExpectation = {
      minRowsReturned: comparison.minRowsProduced,
      ...shape.materializedPathPlan,
    };

    // The table is counted INSIDE the measuring transaction, which is what the
    // `inspect` hook is for. A bound taken anywhere else — a constant, or the
    // `beforeAll` measurement the old equality reached for — is a second clock,
    // and a second clock is what made this case flaky.
    let tableRows = 0;
    const forced = await explainInRollback(statement, [FORCE_INDEX], async (tx) => {
      tableRows = await countCategories(tx);
    });
    expect(
      findVacuityViolations('T2', forced, expectation),
      'the GIN index cannot serve `ancestor_ids @> array[$1]` at all — that is a schema defect, ' +
        'not a scale fact',
    ).toEqual([]);
    expect(forced.indexNames).toContain('categories_ancestor_ids_idx');
    expect(forced.nodeTypes).not.toContain('Seq Scan');
    // And it is genuinely NARROW when it is used — under a tenth of the table
    // rather than the whole of it. The two assertions above say the index is IN
    // the plan; this is the only one that says it bought anything, which is what
    // separates a GIN index doing its job from one dragged into a plan that
    // reads the table anyway.
    expect(
      forced.rowsScanned,
      'the index is in the plan and bought no narrowness: it made the executor look at ' +
        'a tenth of `categories` or more',
    ).toBeLessThan(narrowRowCeiling(tableRows));

    process.stdout.write(
      `\n[ancestry] T2 with enable_seqscan off: ${forced.nodeTypes.join(' / ')} using ` +
        `${forced.indexNames.join(', ')}; ${String(forced.rowsScanned)} rows scanned of ` +
        `${String(tableRows)} in the table (ceiling ${String(narrowRowCeiling(tableRows))}), ` +
        `against ${String(comparison.materializedPath.plan.rowsScanned)} on the chosen plan\n`,
    );
  }, 120_000);

  it('detects a dropped categories_ancestor_ids_idx — the mutation self-test', async () => {
    const shape = ANCESTRY_SHAPES.find((candidate) => candidate.id === 'T2');
    if (!shape?.materializedPathPlan) throw new Error('T2 declares no plan expectation.');
    const comparison = comparisonFor('T2');
    const statement = comparison.materializedPath.statements[0];
    if (!statement) throw new Error('T2 recorded no materialized-path statement.');
    const expectation: ShapeExpectation = {
      minRowsReturned: comparison.minRowsProduced,
      ...shape.materializedPathPlan,
    };

    const forced = await explainInRollback(statement, [FORCE_INDEX]);
    let mutatedTableRows = 0;
    const mutated = await explainInRollback(
      statement,
      [FORCE_INDEX, 'drop index categories_ancestor_ids_idx'],
      async (tx) => {
        mutatedTableRows = await countCategories(tx);
      },
    );
    expect(mutated.indexNames).not.toContain('categories_ancestor_ids_idx');

    const violations = findVacuityViolations('T2', mutated, expectation);
    expect(
      violations.length,
      'the gate stayed green with the index dropped — it is checking nothing',
    ).toBeGreaterThan(0);
    expect(violations.join('\n')).toMatch(/T2/);
    expect(violations.join('\n')).toMatch(/categories_ancestor_ids_idx/);

    // Without the index the whole table is read to answer a question about
    // thirty rows — the amplification the index removes, as a number rather
    // than as an assumption.
    expect(mutated.rowsScanned).toBeGreaterThan(forced.rowsScanned * 10);

    // And the NARROWNESS bound the case above asserts is RED here, stated
    // against the same {@link narrowRowCeiling} that case uses. Without this the
    // bound would only ever be asserted where it holds, which is a bound nobody
    // has shown can fail — and a bound that cannot fail is worse than the flaky
    // equality it replaced, because a flake gets investigated and a vacuous
    // green does not.
    expect(
      mutated.rowsScanned,
      'the narrowness bound stayed green with the index dropped — it is checking nothing',
    ).toBeGreaterThanOrEqual(narrowRowCeiling(mutatedTableRows));

    // And the index really is back: a rollback that silently failed would leave
    // every measurement after this one taken against a different schema.
    const restored = await explainInRollback(statement, [FORCE_INDEX]);
    expect(findVacuityViolations('T2', restored, expectation)).toEqual([]);

    process.stdout.write(
      `\n[ancestry] T2 forced, index dropped: ${mutated.nodeTypes.join(' / ')}; ` +
        `${String(mutated.rowsScanned)} rows scanned against ${String(forced.rowsScanned)} ` +
        `with the index\n`,
    );
  }, 120_000);

  /**
   * A PROBE, not a gate — and the distinction is the point.
   *
   * There is no crossover figure. An earlier version of this docblock said one was
   * measured between roughly 20,000 and 30,000 categories; it did not reproduce —
   * a later probe at 35,010 rows still reported no index use, while the mid-depth
   * shape uses the index at 5,010 — so the 30,000 here is a size well above the
   * seeded tree and NOT a threshold.
   *
   * Asserting that the planner SWITCHES at any row count makes a build failure out
   * of a cost-model decision that moves with `analyze`'s sampling, with autovacuum
   * and with concurrent load. It did exactly that — green alone, red twice in a
   * parallel full-directory run — which is the shape of a gate whoever hits it next
   * disables.
   *
   * So what is asserted here is only what is deterministic: that the filler was
   * really inserted (the positive control — without it this would report the
   * planner's choice at 5,010 rows while claiming 35,010), and that the rollback
   * really restored the table. WHICH plan the planner picked is REPORTED and not
   * asserted.
   *
   * The schema property worth gating is a different one and is gated, twice,
   * deterministically: the index CAN serve the predicate when the sequential scan
   * is taken away, and dropping it turns that red naming the index. Those cannot
   * flip on statistics, because they do not ask the planner to prefer anything.
   */
  it.runIf(FULL_BENCHMARK)(
    'probes what the planner chooses once the taxonomy outgrows D2’s stated scale',
    async () => {
    // What turns "the index is not chosen" from a claim into a measurement with
    // a boundary: grow the table inside a transaction that is rolled back,
    // re-ANALYZE so the planner is deciding on real statistics rather than on
    // the ones it had before, and re-plan the SAME recorded statement.
    //
    // The filler rows carry a five-deep ancestry over a wide id space, so the
    // index's element cardinality is not an artefact of the filler; and the
    // subject id is a REAL one, absent from the filler entirely, so the row
    // estimate stays at thirty and the comparison is genuinely
    // "sequential-scan cost against GIN startup cost" rather than a selectivity
    // difference wearing that name.
    const comparison = comparisonFor('T2');
    const statement = comparison.materializedPath.statements[0];
    if (!statement) throw new Error('T2 recorded no materialized-path statement.');

    // The insert is COUNTED inside the same rolled-back transaction, so the probe
    // can prove it measured a grown table. Reporting a plan without this is how a
    // probe announces the planner's choice at 5,010 rows while naming 35,010.
    let grownRowCount = 0;
    const grown = await explainInRollback(
      statement,
      [
        `insert into categories (id, key, name, slug, ancestor_ids, ancestor_slugs, position)
       select 'fill-' || g::text, 'fill.' || g::text, 'filler ' || g::text, 'fill-' || g::text,
              array['fa-' || (g / 10000)::text, 'fb-' || (g / 1000)::text,
                    'fc-' || (g / 100)::text, 'fd-' || (g / 10)::text, 'fe-' || g::text],
              array['fa-' || (g / 10000)::text],
              0
       from generate_series(1, ${String(SCALE_PROBE_FILLER_ROWS)}) g`,
        'analyze categories',
      ],
      async (tx) => {
        const rows = await tx<{ rows: string }[]>`select count(*)::bigint as rows from categories`;
        grownRowCount = Number(rows[0]?.rows ?? 0);
      },
    );

    // The positive control. Deterministic — an INSERT either happened or it did
    // not, and no statistic can move this number.
    expect(
      grownRowCount,
      'the probe did not actually grow the table, so its plan says nothing about scale',
    ).toBe(result.seed.categoryCount + SCALE_PROBE_FILLER_ROWS);

    // The rollback really rolled back. Without this the crossover would have been
    // demonstrated by permanently changing the database it was demonstrated on.
    const after = await capturing.db.execute<{ rows: string | number }>(
      sql`select count(*)::bigint as rows from categories`,
    );
    expect(Number(after[0]?.rows)).toBe(result.seed.categoryCount);

    // REPORTED, not asserted. See the docblock: at the crossover boundary this is
    // a cost-model preference, and the deterministic index properties are gated
    // by the two cases above this one.
    const chose = grown.indexNames.includes('categories_ancestor_ids_idx');
    process.stdout.write(
      `\n[ancestry] scale probe at ${String(grownRowCount)} categories `
        + `(${String(result.seed.categoryCount)} real + ${String(SCALE_PROBE_FILLER_ROWS)} filler): `
        + `${grown.nodeTypes.join(' / ')} using `
        + `${grown.indexNames.length === 0 ? 'no index' : grown.indexNames.join(', ')}, `
        + `${String(grown.rowsScanned)} rows scanned — GIN index `
        + `${chose ? 'CHOSEN' : 'not chosen'} at this scale\n`,
    );
    },
    180_000,
  );

  it('reports the measurement', () => {
    // Printed on SUCCESS, not only on failure: a benchmark whose numbers appear
    // only when it breaks is a benchmark nobody reads.
    process.stdout.write(`\n${renderAncestryReport(result)}\n\n`);
    expect(result.verdict.summary.length).toBeGreaterThan(0);
  });
});

describe('the ancestry verdict rule', () => {
  // Pure cases, no database. Every branch that matters here is one the hardware
  // may never produce on the day somebody runs the suite — a tie, a refusal, a
  // recursive-CTE win — and a decision rule whose branches are exercised only by
  // luck is a decision rule asserted by nothing.
  const comparison = (
    id: string,
    path: StrategyMeasurement,
    cte: StrategyMeasurement,
    floor: number,
  ): ShapeComparison => ({
    shapeId: id,
    title: id,
    reader: 'synthetic',
    subjectDepth: 0,
    minRowsProduced: floor,
    materializedPath: path,
    recursiveCte: { ...cte, strategy: 'recursive_cte' },
  });

  it('refuses a comparison where either side produced nothing', () => {
    const verdict = deriveAncestryVerdict([
      comparison('X1', fakeSide(0, 0.1, 0), fakeSide(0, 0.2, 0), 0),
    ]);
    expect(verdict.adrD2).toBe('inconclusive');
    expect(verdict.summary.join('\n')).toMatch(/ZERO rows/);
  });

  it('refuses a comparison whose two sides answer differently', () => {
    const verdict = deriveAncestryVerdict([
      comparison('X2', fakeSide(30, 0.1, 40), fakeSide(29, 0.2, 5_000), 10),
    ]);
    expect(verdict.adrD2).toBe('inconclusive');
    expect(verdict.summary.join('\n')).toMatch(/disagree/);
  });

  it('refuses a comparison that came in under its floor', () => {
    const verdict = deriveAncestryVerdict([
      comparison('X3', fakeSide(3, 0.1, 40), fakeSide(3, 0.2, 5_000), 30),
    ]);
    expect(verdict.adrD2).toBe('inconclusive');
    expect(verdict.summary.join('\n')).toMatch(/flatter than it claims/);
  });

  it('calls a difference inside the relative tie band a TIE, and still agrees with D2', () => {
    const verdict = deriveAncestryVerdict([
      comparison('X4', fakeSide(30, 1.000, 40), fakeSide(30, 1.050, 5_000), 30),
    ]);
    expect(verdict.adrD2).toBe('agrees');
    const [shape] = verdict.shapes;
    expect(shape?.outcome).toBe('measured');
    if (shape?.outcome !== 'measured') throw new Error('expected a measured verdict');
    expect(shape.winner).toBe('tie');
    expect(shape.latencyRatio).toBeLessThan(ANCESTRY_TIE_BAND);
  });

  it('calls a LARGE ratio over a tiny absolute difference a TIE too', () => {
    // The branch the measured flip added: 0.10 ms against 0.20 ms is 2x and is
    // still nothing anybody can act on. Without the absolute floor this shape
    // would report "the recursive CTE wins by 2x" and flip the whole verdict.
    const verdict = deriveAncestryVerdict([
      comparison('X7', fakeSide(5, 0.200, 6), fakeSide(5, 0.100, 24), 5),
    ]);
    expect(verdict.adrD2).toBe('agrees');
    const [shape] = verdict.shapes;
    if (shape?.outcome !== 'measured') throw new Error('expected a measured verdict');
    expect(shape.winner).toBe('tie');
    expect(shape.latencyRatio).toBeGreaterThan(ANCESTRY_TIE_BAND);
    expect(shape.sentence).toMatch(new RegExp(String(ANCESTRY_TIE_FLOOR_MS)));
  });

  it('says DISAGREES when the recursive CTE wins a shape on both thresholds', () => {
    const verdict = deriveAncestryVerdict([
      comparison('X5', fakeSide(500, 4.0, 5_010), fakeSide(500, 1.0, 500), 500),
      comparison('X6', fakeSide(30, 1.0, 40), fakeSide(30, 4.0, 5_010), 30),
    ]);
    expect(verdict.adrD2).toBe('disagrees');
    const [first, second] = verdict.shapes;
    if (first?.outcome !== 'measured' || second?.outcome !== 'measured') {
      throw new Error('expected two measured verdicts');
    }
    expect(first.winner).toBe('recursive_cte');
    expect(first.latencyRatio).toBeCloseTo(4, 5);
    expect(second.winner).toBe('materialized_path');
  });

  it('is inconclusive when nothing was measured at all', () => {
    expect(deriveAncestryVerdict([]).adrD2).toBe('inconclusive');
  });

  it('refuses to fold an empty plan list into facts', () => {
    // The vacuity floor one layer down: a strategy that issued no statement has
    // no plan, and zeroes for it would read as the fastest query in the report.
    expect(() => aggregatePlanFacts([])).toThrow(/at least one plan/u);
  });
});

/**
 * Epic #367 line 138 — *"add indexes for ancestry, descendants, breadcrumb reads
 * and category-scoped schema resolution"*.
 *
 * The answer measurement gave is that **no index is missing**, so what is gated
 * here is the coverage that already exists. The two properties asserted are the
 * ones that cannot flip on table statistics: the index CAN serve its shape's
 * predicate when the sequential scan is taken away, and each reader sends the
 * number of statements it is pinned at. Which plan the planner PREFERS is
 * asserted nowhere — see `category-index-coverage.ts` and the module docblock of
 * `ancestry-benchmark.ts`, which records two opposite confident readings of that
 * same question before it was understood.
 *
 * It runs in THIS file rather than a new one because it needs a real tree, its
 * own database and a settled `ANALYZE`, and this file already owns all three. A
 * twelfth private-database realdb file would also spend one of the three
 * remaining slots `validate:lock-capacity` is tracking, to measure a subject
 * this file is already about.
 */
describe('category index coverage (#367 line 138)', () => {
  /** What one shape produced, and the plan of every statement it sent. */
  interface MeasuredRead {
    readonly rowsProduced: number;
    readonly statements: readonly MeasuredStatement[];
    readonly analyses: readonly PlanAnalysis[];
  }

  let fixture: CategorySchemaFixture;
  let registryCounts: ReadonlyMap<string, number>;
  const measured = new Map<string, MeasuredRead>();

  beforeAll(async () => {
    fixture = await seedCategorySchemaRegistry(capturing.db, result.seed);
    // The plans below are a function of table statistics, so the registry has to
    // be settled before any of them is taken — an unanalyzed 4,000-row table is
    // planned as though it held the ten rows the last `ANALYZE` saw.
    await capturing.client.unsafe('analyze');
    registryCounts = await countSeededRegistry(capturing.db);

    for (const shape of CATEGORY_READ_SHAPES) {
      capturing.begin();
      const rowsProduced = await shape.read(capturing.db, result.seed, fixture);
      const statements = capturing.take();
      const analyses: PlanAnalysis[] = [];
      for (const statement of statements) {
        analyses.push(await explainStatement(capturing.client, statement));
      }
      measured.set(shape.id, { rowsProduced, statements, analyses });
    }
  }, 900_000);

  it('covers all four of line 138’s reads, with an index question in each', () => {
    // The vacuity floor over the SHAPE TABLE itself. Every assertion below is an
    // `it.each` over `CATEGORY_READ_SHAPES`, and `it.each([])` registers no cases
    // at all — so a table emptied by a bad merge would take the whole gate green
    // and silent. This is the one case that cannot be removed that way.
    const kinds = new Set(CATEGORY_READ_SHAPES.map((shape) => shape.kind));
    expect([...kinds].sort()).toEqual([
      'ancestry',
      'breadcrumb',
      'category_scoped_schema_resolution',
      'descendants',
    ]);
    expect(CATEGORY_READ_SHAPES.length).toBeGreaterThanOrEqual(9);
    // And at least one shape per run has to be putting an index under test, or
    // the `servableBy` half is an `it.each([])` too.
    expect(
      CATEGORY_READ_SHAPES.filter((shape) => shape.servableBy !== undefined).length,
    ).toBeGreaterThanOrEqual(4);
    // Every shape names the reader it calls and the surface that reaches it: a
    // shape whose provenance went stale is how `ancestry-benchmark.ts`'s T4 came
    // to describe a shipped read as "EXPLORATORY — no shipped path".
    for (const shape of CATEGORY_READ_SHAPES) {
      expect(shape.reader.length, `${shape.id} names no reader`).toBeGreaterThan(0);
      expect(shape.route.length, `${shape.id} names no route`).toBeGreaterThan(0);
    }
  });

  it('seeded a registry that clears its floors', () => {
    // The dataset half of the refusal: plans taken over a registry that wrote a
    // tenth of what it announced are correct and mean nothing.
    expect(findRowCountViolations(registryCounts, categoryRegistryFloors())).toEqual([]);
    expect(fixture.scopeIds.length).toBeGreaterThan(1);
    expect(fixture.bucketIds.length).toBeGreaterThan(0);
  });

  it.each(CATEGORY_READ_SHAPES.map((shape) => [shape.id, shape] as const))(
    '%s produces rows and sends exactly the statements it is pinned at',
    (_id, shape) => {
      const read = measured.get(shape.id);
      if (!read) throw new Error(`${shape.id} was never measured.`);
      const floor = shape.minRowsProduced(result.seed, fixture);

      expect(
        read.rowsProduced,
        `${shape.id} (${shape.reader}) produced ${String(read.rowsProduced)} rows against a ` +
          `floor of ${String(floor)} — the measurement is vacuous`,
      ).toBeGreaterThanOrEqual(floor);

      // EXACT, because for the ancestry and breadcrumb shapes this number IS the
      // cost: every statement they send is an index scan over single-digit row
      // counts, so a plan-only gate would call them healthy while a fourth round
      // trip was added.
      expect(
        read.statements.length,
        `${shape.id} (${shape.reader}) sent ${String(read.statements.length)} statements, ` +
          `pinned at ${String(shape.statements)}. If this is an improvement, move the pin in ` +
          `the same diff.`,
      ).toBe(shape.statements);

      // A plan list shorter than the statement list would silently exempt a
      // statement from every assertion below it.
      expect(read.analyses.length).toBe(read.statements.length);
    },
  );

  it.each(
    CATEGORY_READ_SHAPES.filter((shape) => shape.servableBy !== undefined).map(
      (shape) => [shape.id, shape] as const,
    ),
  )('%s — its predicate is SERVABLE by the index it names', async (_id, shape) => {
    const servable = shape.servableBy;
    if (!servable) throw new Error(`${shape.id} declares no index expectation.`);
    const read = measured.get(shape.id);
    const statement = read?.statements[0];
    if (!statement) throw new Error(`${shape.id} recorded no statement.`);

    let tableRows = 0;
    const forced = await explainInRollback(statement, [FORCE_INDEX], async (tx) => {
      tableRows = await countCategories(tx);
    });

    expect(
      forced.indexNames,
      `${servable.index} cannot serve ${shape.id}'s predicate at all — that is a schema ` +
        `defect, not a scale fact. ${servable.because}`,
    ).toContain(servable.index);

    if (servable.narrowOverCategories === 'required') {
      // "The index is in the plan" and "the index bought something" are
      // different facts, and only the second is worth having.
      expect(
        forced.rowsScanned,
        `${shape.id}: ${servable.index} is in the plan and bought no narrowness — the ` +
          `executor still looked at a tenth of \`categories\` or more`,
      ).toBeLessThan(narrowRowCeiling(tableRows));
    }

    const chosen = read.analyses[0];
    process.stdout.write(
      `\n[coverage] ${shape.id} forced: ${forced.nodeTypes.join(' / ')} using ` +
        `${forced.indexNames.join(', ') || 'NO INDEX'}; ${String(forced.rowsScanned)} rows ` +
        `scanned of ${String(tableRows)} categories in ${forced.executionTimeMs.toFixed(2)} ms` +
        (chosen
          ? ` — against ${String(chosen.rowsScanned)} rows in ` +
            `${chosen.executionTimeMs.toFixed(2)} ms on the CHOSEN plan ` +
            `(${chosen.indexNames.join(', ') || 'NO INDEX'})`
          : '') +
        '\n',
    );
  }, 180_000);

  it('goes red when the index it names is dropped — the mutation self-test', async () => {
    // C1 is the shipped facet scope read, so this mutates the index on the path
    // a shopper actually takes rather than on a shape written for the gate.
    const shape = CATEGORY_READ_SHAPES.find((candidate) => candidate.id === 'C1');
    const servable = shape?.servableBy;
    if (!shape || !servable) throw new Error('C1 is missing or declares no index expectation.');
    const statement = measured.get('C1')?.statements[0];
    if (!statement) throw new Error('C1 recorded no statement.');

    const forced = await explainInRollback(statement, [FORCE_INDEX]);
    let mutatedTableRows = 0;
    const mutated = await explainInRollback(
      statement,
      [FORCE_INDEX, `drop index ${servable.index}`],
      async (tx) => {
        mutatedTableRows = await countCategories(tx);
      },
    );

    expect(mutated.indexNames).not.toContain(servable.index);
    // The same assertion the case above makes, shown RED here. Without this the
    // bound would only ever be asserted where it holds, and a bound nobody has
    // shown can fail is not a bound.
    expect(
      mutated.rowsScanned,
      'the narrowness bound stayed satisfied with the index dropped — it is checking nothing',
    ).toBeGreaterThanOrEqual(narrowRowCeiling(mutatedTableRows));
    expect(mutated.rowsScanned).toBeGreaterThan(forced.rowsScanned * 10);

    // And the index is genuinely BACK, because a rollback that silently failed
    // would leave every later measurement taken against a different schema.
    const present = await capturing.client.unsafe<{ n: string }[]>(
      `select indexname as n from pg_indexes where indexname = $1`,
      [servable.index],
    );
    expect(present.length, `${servable.index} did not come back after the rollback`).toBe(1);
  }, 180_000);

  it('reports the coverage table', () => {
    const lines: string[] = [
      '',
      '# Category index coverage (#367 line 138)',
      `Registry: ${[...registryCounts].map(([t, n]) => `${t}=${String(n)}`).join(', ')}`,
      '| shape | read | reader | stmts | rows out | rows scanned | exec ms | indexes |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
    ];
    for (const shape of CATEGORY_READ_SHAPES) {
      const read = measured.get(shape.id);
      if (!read) continue;
      const scanned = read.analyses.reduce((total, plan) => total + plan.rowsScanned, 0);
      const execMs = read.analyses.reduce((total, plan) => total + plan.executionTimeMs, 0);
      const indexes = [...new Set(read.analyses.flatMap((plan) => plan.indexNames))];
      lines.push(
        `| ${shape.id} | ${shape.kind} | ${shape.reader} | ${String(read.statements.length)} | ` +
          `${String(read.rowsProduced)} | ${String(scanned)} | ${execMs.toFixed(2)} | ` +
          `${indexes.join(', ') || '—'} |`,
      );
    }
    // The CHOSEN plan is what the table above reports and it is NOT stable — see
    // the module docblock of `ancestry-benchmark.ts`. This line states the same
    // shapes under `enable_seqscan = off`, which is, and is what makes the two
    // comparable at all.
    lines.push(
      '',
      'The `[coverage]` lines above report the same shapes with the sequential scan',
      'taken away. Where the two differ, the difference is a planner decision over',
      'table statistics and not a fact about the schema — which is why no case here',
      'asserts the chosen plan.',
    );
    // Printed on SUCCESS: a measurement whose numbers appear only when it breaks
    // is one nobody reads.
    process.stdout.write(`${lines.join('\n')}\n\n`);
    expect(measured.size).toBe(CATEGORY_READ_SHAPES.length);
  });
});
