/**
 * Running the workload and collecting the numbers #61's measurement section
 * asks for.
 *
 * ## The statement measured is the statement the reader sent
 *
 * `createCapturingDatabase` builds a drizzle handle through `@oxyhq/db`'s
 * `createDatabase` — the same casing authority `connectPostgres()` uses — with
 * postgres.js's `debug` hook attached. Calling a repository function against
 * that handle therefore RECORDS the exact SQL and bound parameters the driver
 * put on the wire, and that recording is what gets EXPLAINed and timed. No SQL
 * is transcribed anywhere, so the benchmark cannot drift away from the read it
 * claims to measure. See `workload.ts` for why that mattered enough to build.
 *
 * ## Two clocks, deliberately
 *
 * `EXPLAIN ANALYZE` instruments every node, which inflates execution time —
 * quoting its `Execution Time` as "the latency" reports the cost of measuring.
 * So the plan facts come from ONE instrumented execution and the p50/p95/p99
 * come from N UNINSTRUMENTED ones, timed client-side. The two are reported side
 * by side and never averaged together.
 *
 * ## A mutating shape runs inside a transaction that is rolled back
 *
 * `EXPLAIN ANALYZE` really executes. The freshness sweep measured fifty times
 * outside a transaction would retire fifty pages of offers, and runs two
 * onwards would each measure a predicate the previous run had emptied — falling
 * latencies that look like a warming cache and are actually a shrinking table.
 */

import { createDatabase } from '@oxyhq/db';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Database, Transaction } from '../../db/postgres.js';
import * as schema from '../../db/schema/index.js';
import { upsertExternalOffer } from '../../db/offers/offerRepository.js';
import {
  findRowCountViolations,
  findVacuityViolations,
  parsePlanJson,
  summarizeLatency,
  type LatencySummary,
  type PlanAnalysis,
} from './measure.js';
import {
  countSeededRows,
  rowCountFloors,
  type BenchmarkScale,
  type SeededGraph,
} from './dataset.js';
import { EXPLORATORY_SHAPES, WORKLOAD_SHAPES } from './workload.js';

/** One statement postgres.js actually sent. */
interface CapturedStatement {
  readonly text: string;
  /**
   * Typed as postgres.js's own parameter type rather than `unknown[]`, because
   * these values go straight back into `client.unsafe(text, params)` — the
   * driver handed them out and the driver takes them back, so anything narrower
   * here would be this file's opinion about a round trip it does not own.
   */
  readonly parameters: readonly postgres.ParameterOrJSON<never>[];
}

/** A handle that records what it sends, plus the client underneath it. */
export interface CapturingDatabase {
  readonly db: Database;
  readonly client: postgres.Sql;
  /** Start recording; returns the statements captured since the previous call. */
  begin(): void;
  take(): CapturedStatement[];
  close(): Promise<void>;
}

/** Statements the driver issues on its own behalf, which measure nothing. */
const DRIVER_NOISE = /^\s*(begin|commit|rollback|discard|set|show|select\s+1\s*$)/i;

export function createCapturingDatabase(databaseUrl: string): CapturingDatabase {
  let recording = false;
  let captured: CapturedStatement[] = [];

  const instance = createDatabase({
    databaseUrl,
    schema,
    client: {
      max: 4,
      // The generator's TRUNCATE cascades across the whole schema and postgres.js
      // prints a NOTICE per table, which buries the report under a hundred lines
      // of nothing. Swallowed here rather than not asked for, because CASCADE is
      // what makes the truncation correct.
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

  return {
    db: instance.db,
    client: instance.client,
    begin: () => {
      recording = true;
      captured = [];
    },
    take: () => {
      recording = false;
      const taken = captured;
      captured = [];
      return taken;
    },
    close: () => instance.client.end({ timeout: 5 }),
  };
}

/** Thrown to make postgres.js roll a measuring transaction back. */
class RollbackSignal extends Error {
  constructor() {
    super('benchmark rollback');
    this.name = 'RollbackSignal';
  }
}

/**
 * Run `work` inside a transaction that is ALWAYS rolled back.
 *
 * The result is carried out through a closure variable rather than returned,
 * because the only way to make postgres.js roll back is to throw — so the
 * transaction callback never gets to return anything.
 */
async function inRolledBackTransaction<TResult>(
  client: postgres.Sql,
  work: (tx: postgres.TransactionSql) => Promise<TResult>,
): Promise<TResult> {
  let carried: { value: TResult } | null = null;
  try {
    await client.begin(async (tx) => {
      carried = { value: await work(tx) };
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (carried === null) throw new Error('The measuring transaction produced no result.');
  return carried.value;
}

/**
 * Run a READER inside a drizzle transaction that is always rolled back.
 *
 * Separate from {@link inRolledBackTransaction} because the two take different
 * handles and neither substitutes for the other: a reader takes drizzle's
 * `Transaction`, a captured statement is replayed on postgres.js's own. Drizzle
 * signals its rollback by throwing `TransactionRollbackError`, which is caught
 * here and nowhere else — anything else propagates, so a real failure inside a
 * measured write still stops the run instead of reading as a rollback.
 */
async function captureInRolledBackTransaction(
  db: Database,
  run: (tx: Transaction) => Promise<unknown>,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await run(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
}

/** Everything one statement of one shape yielded. */
export interface ShapeMeasurement {
  readonly shapeId: string;
  readonly workloadItem: number;
  readonly title: string;
  /** The real reader, or an exploratory shape's provenance sentence. */
  readonly reader: string;
  readonly statementIndex: number;
  readonly statementCount: number;
  readonly sqlText: string;
  readonly analysis: PlanAnalysis;
  readonly latency: LatencySummary;
  /**
   * Buffers on the FIRST instrumented execution of this statement.
   *
   * Labelled "first touch", not "cold": evicting the OS page cache is not
   * available to this harness, so a non-zero read count is a lower bound on
   * what a genuinely cold cache would cost. See the report for the full caveat.
   */
  readonly firstTouchReadBlocks: number;
  readonly steadyHitBlocks: number;
  readonly steadyReadBlocks: number;
  readonly violations: readonly string[];
}

export interface RelationSize {
  readonly relation: string;
  readonly kind: 'table' | 'index';
  readonly bytes: number;
}

export interface WriteCost {
  readonly label: string;
  readonly reader: string;
  readonly latency: LatencySummary;
}

export interface BenchmarkResult {
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly graph: SeededGraph;
  readonly postgresVersion: string;
  readonly measuredAt: string;
  readonly latencyRuns: number;
  readonly rowCounts: ReadonlyMap<string, number>;
  readonly floorViolations: readonly string[];
  readonly shapes: readonly ShapeMeasurement[];
  readonly exploratory: readonly ShapeMeasurement[];
  readonly sizes: readonly RelationSize[];
  readonly writeCosts: readonly WriteCost[];
}

interface ExplainRow {
  readonly 'QUERY PLAN': unknown;
}

async function explainOnce(
  runner: postgres.Sql | postgres.TransactionSql,
  statement: CapturedStatement,
): Promise<PlanAnalysis> {
  const rows = await runner.unsafe<ExplainRow[]>(
    `explain (analyze, buffers, format json) ${statement.text}`,
    [...statement.parameters],
  );
  return parsePlanJson(rows[0]?.['QUERY PLAN']);
}

/**
 * How one execution is isolated from the next.
 *
 * A read runs straight on the pool. A WRITE runs in its own rolled-back
 * transaction — one per execution, not one around the whole measurement, and
 * that distinction is the bug this shape exists to prevent: twenty-two
 * executions sharing a transaction still see each other, so the freshness
 * sweep's second run finds five hundred fewer lapsed rows than its first and
 * its twenty-second finds none. Measured here first time round — the vacuity
 * floor reported `Q13: returned 0 rows` and it was the harness, not the seed.
 */
type ExecutionScope = <TResult>(
  work: (runner: postgres.Sql | postgres.TransactionSql) => Promise<TResult>,
) => Promise<TResult>;

/**
 * Time one statement `runs` times WITHOUT instrumentation.
 *
 * Client-side wall clock, so the number includes the round trip a real caller
 * also pays. That is the honest latency for a page budget; the plan's own
 * `Execution Time` is reported separately as the server-side, instrumented
 * upper bound.
 */
async function timeStatement(
  scope: ExecutionScope,
  statement: CapturedStatement,
  runs: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < runs; attempt += 1) {
    samples.push(
      await scope(async (runner) => {
        const started = performance.now();
        await runner.unsafe(statement.text, [...statement.parameters]);
        return performance.now() - started;
      }),
    );
  }
  return samples;
}

async function measureStatement(
  scope: ExecutionScope,
  statement: CapturedStatement,
  runs: number,
): Promise<{
  analysis: PlanAnalysis;
  latency: LatencySummary;
  firstTouchReadBlocks: number;
  steadyHitBlocks: number;
  steadyReadBlocks: number;
}> {
  const first = await scope((runner) => explainOnce(runner, statement));
  const samples = await timeStatement(scope, statement, runs);
  const steady = await scope((runner) => explainOnce(runner, statement));
  return {
    analysis: steady,
    latency: summarizeLatency(samples),
    firstTouchReadBlocks: first.sharedReadBlocks,
    steadyHitBlocks: steady.sharedHitBlocks,
    steadyReadBlocks: steady.sharedReadBlocks,
  };
}

async function readSizes(db: Database): Promise<RelationSize[]> {
  const tables = await db.execute<{ relation: string; bytes: string | number }>(sql`
    select relname as relation, pg_table_size(oid)::bigint as bytes
    from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace
      and pg_table_size(oid) > 0
    order by pg_table_size(oid) desc`);
  const indexes = await db.execute<{ relation: string; bytes: string | number }>(sql`
    select indexrelname as relation, pg_relation_size(indexrelid)::bigint as bytes
    from pg_stat_user_indexes
    where pg_relation_size(indexrelid) > 0
    order by pg_relation_size(indexrelid) desc`);
  return [
    // `Number(...)` and not the value as-is: postgres.js decodes `bigint` as a
    // STRING, so a raw sum or comparison downstream would concatenate.
    ...tables.map((row) => ({ relation: row.relation, kind: 'table' as const, bytes: Number(row.bytes) })),
    ...indexes.map((row) => ({ relation: row.relation, kind: 'index' as const, bytes: Number(row.bytes) })),
  ];
}

/**
 * What the ingestion converge costs per row — #61's "write/update cost where
 * relevant", and the number an added index has to be justified against.
 *
 * Runs the REAL upsert (`upsertExternalOffer`, the shape every external feed
 * delivery takes) inside a rolled-back transaction, so measuring the write does
 * not change the table the reads above were measured on.
 */
async function measureWriteCost(
  capturing: CapturingDatabase,
  graph: SeededGraph,
  runs: number,
): Promise<WriteCost[]> {
  // The insert half cannot run inside a rolled-back transaction: the reader is
  // `upsertExternalOffer`, which takes the DRIZZLE handle, and that handle is
  // bound to the pool rather than to a postgres.js transaction. So the writes
  // are made distinguishable instead — a `provider` no seeded row carries — and
  // deleted by that provider afterwards, which leaves the dataset exactly as
  // the seed built it.
  const inserts: number[] = [];
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const started = performance.now();
    await upsertExternalOffer(capturing.db, {
      kind: 'external',
      status: 'active',
      canonicalVariantId: graph.writeCostVariantId,
      merchantId: `bx-merch-${String(attempt)}`,
      storefrontId: 'bx-sf-0',
      sourceRecordId: 'bx-sr-0',
      provider: 'bench-writecost',
      externalOfferId: `bx-writecost-${String(attempt)}`,
      destinationUrl: 'https://example.test/w',
      priceAmount: 1_234 + attempt,
      priceCurrency: 'EUR',
      availability: 'in_stock',
      condition: 'new',
      conditionMappingState: 'declared',
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
      firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      staleAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    inserts.push(performance.now() - started);
  }
  await capturing.client`delete from offers where provider = 'bench-writecost'`;

  // The update half CAN be rolled back — it is raw SQL on the client, so the
  // transaction handle is the one issuing it. It moves `price_amount`, which is
  // a key column of the comparison index, so this is the number an added index
  // on that column has to be justified against.
  const updates = await inRolledBackTransaction(capturing.client, async (tx) => {
    const samples: number[] = [];
    for (let attempt = 0; attempt < runs; attempt += 1) {
      const started = performance.now();
      await tx`
        update offers set price_amount = price_amount + 1
        where id = ${`bx-offer-0-${String(attempt % 8)}`}`;
      samples.push(performance.now() - started);
    }
    return samples;
  });

  return [
    {
      label: 'External offer insert (new source mapping)',
      reader: 'db/offers/offerRepository.ts::upsertExternalOffer',
      latency: summarizeLatency(inserts),
    },
    {
      label: 'Offer price update by id (what an index on price costs a write)',
      reader: 'raw UPDATE inside a rolled-back transaction',
      latency: summarizeLatency(updates),
    },
  ];
}

/** Run the whole workload against an already-seeded database. */
export async function runBenchmark(
  capturing: CapturingDatabase,
  graph: SeededGraph,
  seed: number,
  latencyRuns: number,
  log: (message: string) => void = () => undefined,
): Promise<BenchmarkResult> {
  const { db, client } = capturing;

  const versionRows = await db.execute<{ version: string }>(sql`select version() as version`);
  const rowCounts = await countSeededRows(db);
  const floorViolations = findRowCountViolations(rowCounts, rowCountFloors(graph.scale));

  const shapes: ShapeMeasurement[] = [];
  for (const shape of WORKLOAD_SHAPES) {
    log(`  ${shape.id} ${shape.title}…`);
    capturing.begin();
    // The CAPTURE itself executes the reader, so a mutating shape has to be
    // captured inside a rolled-back transaction too — otherwise the freshness
    // sweep really retires five hundred offers before the shapes measured after
    // it ever run, and a dataset the whole report calls deterministic quietly
    // stops being the one that was seeded.
    if (shape.mutates) {
      await captureInRolledBackTransaction(db, (tx) => shape.run(tx, graph));
    } else {
      await shape.run(db, graph);
    }
    const statements = capturing.take();
    if (statements.length === 0) {
      throw new Error(`${shape.id} captured no statement — the reader issued nothing.`);
    }

    for (const [statementIndex, statement] of statements.entries()) {
      const scope: ExecutionScope = shape.mutates
        ? (work) => inRolledBackTransaction(client, work)
        : (work) => work(client);
      const measured = await measureStatement(scope, statement, latencyRuns);
      shapes.push({
        shapeId: shape.id,
        workloadItem: shape.workloadItem,
        title: shape.title,
        reader: shape.reader,
        statementIndex,
        statementCount: statements.length,
        sqlText: statement.text,
        ...measured,
        // Only the FIRST statement of a multi-statement reader carries the
        // shape's row floor: `searchListingsPage` issues the page and its
        // `count(*)`, and a count always returns exactly one row, so applying
        // the floor to it would pass whatever the page found.
        violations:
          statementIndex === 0
            ? findVacuityViolations(shape.id, measured.analysis, shape.expectation)
            : [],
      });
    }
  }

  const exploratory: ShapeMeasurement[] = [];
  for (const shape of EXPLORATORY_SHAPES) {
    log(`  ${shape.id} ${shape.title}…`);
    capturing.begin();
    await db.execute(shape.build(graph));
    const statements = capturing.take();
    const statement = statements[0];
    if (!statement) throw new Error(`${shape.id} captured no statement.`);
    const measured = await measureStatement((work) => work(client), statement, latencyRuns);
    exploratory.push({
      shapeId: shape.id,
      workloadItem: shape.workloadItem,
      title: shape.title,
      reader: shape.provenance,
      statementIndex: 0,
      statementCount: 1,
      sqlText: statement.text,
      ...measured,
      violations: findVacuityViolations(shape.id, measured.analysis, shape.expectation),
    });
  }

  log('  write cost…');
  const writeCosts = await measureWriteCost(capturing, graph, Math.min(latencyRuns, 25));

  return {
    scale: graph.scale,
    seed,
    graph,
    postgresVersion: versionRows[0]?.version ?? 'unknown',
    measuredAt: new Date().toISOString(),
    latencyRuns,
    rowCounts,
    floorViolations,
    shapes,
    exploratory,
    sizes: await readSizes(db),
    writeCosts,
  };
}
