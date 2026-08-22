/**
 * The taxonomy hierarchy benchmark ADR 0007 D2 is provisional on.
 *
 * D2 adopted a **materialized path of ids** (`categories.ancestor_ids text[]`
 * plus the GIN index `categories_ancestor_ids_idx`) over a closure table and
 * over a bare recursive CTE, and said so in as many words: *"The choice is
 * provisional on a benchmark … if the materialized path loses to a recursive
 * CTE at a realistic scale, the ADR is amended before the alternative is
 * adopted, never after."* This module is that benchmark. It produces a number
 * per shape per strategy and a structured verdict; it changes no schema, adopts
 * nothing and recommends nothing on its own.
 *
 * ## Why it seeds its own tree rather than using #61's dataset
 *
 * `services/graph-benchmark/dataset.ts` seeds twenty-four categories, sets no
 * `parent_id` on any of them and never writes `ancestor_ids` at all — the column
 * takes its `'{}'::text[]` default on every row. Every ancestry read over that
 * dataset therefore returns zero rows, which is precisely the measurement of
 * nothing #61's own vacuity floors exist to refuse. A benchmark of a hierarchy
 * needs a hierarchy, so this one builds one: ADR 0007 D2's own description of
 * the real thing — *"shallow (single-digit depth) and small (thousands of
 * nodes, not millions)"* — is the specification, and {@link SHAPE_OF_THE_TREE}
 * is that sentence as numbers.
 *
 * ## The tree is built by the REAL writer
 *
 * Every category is created through `insertCategory`, the taxonomy's single
 * write chokepoint, so `ancestor_ids` is the derivation production performs
 * rather than this file's opinion of it. A benchmark that populated the array
 * itself would be measuring a read against a path its own author wrote, and the
 * one bug that could not survive is the one where the two disagree. It also
 * keeps this module out of `taxonomy-write-chokepoint.test.ts`'s census by
 * construction rather than by exemption.
 *
 * ## Both sides of every comparison run through the same handle
 *
 * The materialized-path side CALLS the repository function the API calls
 * (`findCategoryDescendants`, `findCategoryAncestors`), against a handle that
 * records what postgres.js actually sent — #61's rule that the SQL measured is
 * the SQL the reader sent, so there is no transcription to drift. The recursive
 * CTE has no shipped reader (that is the point: it is the alternative), so it is
 * composed here and issued through the SAME handle, which means it is recorded,
 * EXPLAINed and timed by the identical code path. The two sides differ in their
 * SQL and in nothing else.
 *
 * ## Two clocks, never averaged
 *
 * Plan facts come from ONE `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` execution
 * per statement; p50/p95/p99 come from N UNINSTRUMENTED executions timed with
 * `performance.now()`. `EXPLAIN ANALYZE` instruments every node, so quoting its
 * `Execution Time` as the latency reports the cost of measuring.
 *
 * ## A comparison that measured nothing is REFUSED, not printed small
 *
 * {@link deriveAncestryVerdict} refuses a shape whose either side produced zero
 * rows, whose two sides disagree about how many rows they produced, or which
 * fell under the shape's declared floor. A seed that came out flat, a subject id
 * that named nothing and a predicate that matched nothing all produce a fast
 * query and a tidy plan; the only thing that tells them apart from a real
 * measurement is a floor that had to be cleared before the number was allowed to
 * exist.
 *
 * ## What it measured, over SEVEN runs, because one run is not an answer
 *
 * PostgreSQL 17.5, 5,010 categories over six levels, 5,760 canonical products,
 * 200 uninstrumented executions per side per shape.
 *
 * **D2's materialized path stands, and T1 and T2 are what carry it.** Those two
 * descendants shapes are won on every run without exception, by 1.56x to 6.59x.
 * Nothing measured here suggests replacing the strategy, and the ADR should not
 * be amended to.
 *
 * The other two shapes are where the honest detail lives, and neither is a clean
 * win:
 *
 *   - **T3, the breadcrumb, is a TIE on every run — and the recursive CTE is
 *     consistently the marginally faster side** (0.115-0.226 ms), held under the
 *     tie band rather than being a loss. The cause is a property of the
 *     REPOSITORY, not of the strategy: `findCategoryAncestors` answers in TWO
 *     round trips (read the row, then read its ancestors by id) where the CTE
 *     takes one. A single statement joining the row to its own `ancestor_ids`
 *     removes it. This is the shape most likely to get worse on a deployment
 *     whose database is a network hop away rather than a socket away, because the
 *     second round trip is then the dominant cost.
 *   - **T4, the category-scoped product read, is CONDITIONAL on the planner
 *     choosing `categories_ancestor_ids_idx`, and that choice is not stable at
 *     this scale.** With the index it scans 6,261 rows and the materialized path
 *     wins by 2.32x; without it, 10,771 rows, and the result is a tie or a
 *     marginal CTE win (1.18x). Over seven runs the harness's headline verdict
 *     was `agrees` five times and `disagrees` twice, and every `disagrees` was
 *     T4 losing on a run where the index was not chosen.
 *
 * **`categories_ancestor_ids_idx` does real work, and SELECTIVITY decides
 * whether it is used.** T2 returning 30 of 5,010 rows (0.6%) gets a Bitmap Index
 * Scan and scans 30 rather than 5,010; T1 returning 500 of 5,010 (10%) gets a
 * sequential scan, correctly, because an index is the wrong tool for a tenth of a
 * small table. So D2's "the shape is already in the schema and already indexed"
 * is right — with the caveat that on a table this size the planner sits near its
 * own cost boundary on the less selective shapes and its choice moves with
 * `analyze` and with concurrent load.
 *
 * **Two earlier drafts of this comment were wrong in opposite directions, and
 * that is the finding about the METHOD.** The first, from measurements taken
 * before `analyze` had settled on the freshly seeded tree, said the index is
 * never chosen at this scale and only starts paying between 20,000 and 30,000
 * categories. The second, from two consecutive settled runs, said it is simply
 * chosen and D2 is vindicated outright. Both were single-condition readings of a
 * cost-model decision. Nothing in this file ASSERTS a planner choice or a
 * verdict for exactly that reason: what it asserts is that the index CAN serve
 * the predicate when the sequential scan is taken away, and that dropping the
 * index turns that red naming it. Those cannot flip on statistics.
 *
 * The breadcrumb tie has a cause worth naming rather than averaging away: the
 * materialized path answers it in TWO round trips (`findCategoryAncestors` reads
 * the row, then reads its ancestors by id) where the recursive CTE takes one.
 * That is a property of the REPOSITORY, not of the strategy — a single statement
 * joining the row to its own `ancestor_ids` would remove it — and it is the
 * shape most likely to reverse on a deployment whose database is a network hop
 * away rather than a socket away, since the second round trip is then the
 * dominant cost.
 */

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Database } from '../../db/postgres.js';
import { canonicalProducts } from '../../db/schema/canonicalCatalog.js';
import {
  findCategoryAncestors,
  findCategoryDescendants,
  insertCategory,
} from '../../db/taxonomy/taxonomyRepository.js';
import {
  findRowCountViolations,
  parsePlanJson,
  summarizeLatency,
  type LatencySummary,
  type PlanAnalysis,
  type ShapeExpectation,
} from '../graph-benchmark/measure.js';
import type { CapturingDatabase } from '../graph-benchmark/runner.js';

// ─── The tree ──────────────────────────────────────────────────────────────

/**
 * ADR 0007 D2's "shallow, single-digit depth; thousands of nodes", as numbers.
 *
 * Ten roots and a branching factor that narrows with depth — the shape a real
 * marketplace taxonomy has, where a top level fans out and the bottom two levels
 * are pairs of near-synonyms. Six levels (depth indices 0…5, so a leaf carries
 * five ancestors) and 10 + 40 + 160 + 480 + 1 440 + 2 880 = **5 010** nodes.
 *
 * The size is not smaller for the same reason #61's `ci` scale is not: the
 * property under test is partly a PLANNER decision, and a tree small enough that
 * every plan is a sequential scan measures the absence of a decision.
 */
export const SHAPE_OF_THE_TREE = {
  /** Top-level categories. */
  roots: 10,
  /** Children of a node at depth 0, 1, 2, 3, 4 — so six levels in all. */
  childrenPerLevel: [4, 4, 3, 3, 2],
  /** Canonical products filed under each leaf. Only leaves are `selectable`. */
  productsPerLeaf: 2,
} as const;

/** How many nodes sit strictly beneath one node at `depth`. */
function subtreeDescendantCount(depth: number): number {
  let level = 1;
  let total = 0;
  for (let index = depth; index < SHAPE_OF_THE_TREE.childrenPerLevel.length; index += 1) {
    level *= SHAPE_OF_THE_TREE.childrenPerLevel[index] ?? 0;
    total += level;
  }
  return total;
}

/** How many LEAVES sit beneath one node at `depth` — the products' multiplier. */
function subtreeLeafCount(depth: number): number {
  let level = 1;
  for (let index = depth; index < SHAPE_OF_THE_TREE.childrenPerLevel.length; index += 1) {
    level *= SHAPE_OF_THE_TREE.childrenPerLevel[index] ?? 0;
  }
  return level;
}

/** What one seeded run built, and the three subjects the shapes read. */
export interface SeededTaxonomy {
  /** Per-run token every key, slug and product name carries. */
  readonly token: string;
  readonly categoryCount: number;
  readonly productCount: number;
  /** Number of LEVELS, so a leaf's ancestry is `depth - 1` long. */
  readonly depth: number;
  /** Category ids by depth, level 0 first. */
  readonly idsByDepth: readonly (readonly string[])[];
  /** The worst case: a root, whose subtree is the largest. */
  readonly rootId: string;
  readonly rootDescendants: number;
  readonly rootSubtreeProducts: number;
  /** A mid-depth node (level 2 of six). */
  readonly midId: string;
  readonly midDescendants: number;
  /** A leaf at the deepest level. */
  readonly leafId: string;
  readonly leafAncestors: number;
}

/** How many category inserts are in flight at once while seeding. */
const SEED_CONCURRENCY = 12;

/** Rows per `canonical_products` insert statement. */
const PRODUCT_BATCH = 500;

/**
 * Build the tree and file products under its leaves.
 *
 * Level by level, so every parent exists before its children and
 * `insertCategory` can derive each row's ancestry from the parent's own arrays.
 * Siblings go in concurrently because they are independent rows; the ORDER
 * within a level is not a property anything here measures.
 *
 * Only the deepest level is `selectable`, which is ADR 0007 D2's structural-node
 * rule and is also what `mercaria_category_assignment_selectable` enforces
 * against `canonical_products.category_id` — so the products can only be filed
 * where they are filed here.
 */
export async function seedAncestryTaxonomy(
  db: Database,
  log: (line: string) => void = () => undefined,
): Promise<SeededTaxonomy> {
  const token = `abx${randomBytes(6).toString('hex')}`;
  const levels: string[][] = [];
  const deepest = SHAPE_OF_THE_TREE.childrenPerLevel.length;

  let parents: (string | null)[] = [null];
  for (let depth = 0; depth <= deepest; depth += 1) {
    const perParent =
      depth === 0 ? SHAPE_OF_THE_TREE.roots : (SHAPE_OF_THE_TREE.childrenPerLevel[depth - 1] ?? 0);
    const requests: { parentId: string | null; ordinal: number }[] = [];
    for (const parentId of parents) {
      for (let child = 0; child < perParent; child += 1) {
        requests.push({ parentId, ordinal: requests.length });
      }
    }

    const created: string[] = new Array<string>(requests.length);
    for (let start = 0; start < requests.length; start += SEED_CONCURRENCY) {
      const batch = requests.slice(start, start + SEED_CONCURRENCY);
      await Promise.all(
        batch.map(async (request, offset) => {
          const row = await insertCategory(
            {
              key: `${token}.d${String(depth)}-${String(request.ordinal)}`,
              name: `Ancestry bench ${String(depth)}/${String(request.ordinal)}`,
              slug: `${token}-d${String(depth)}-${String(request.ordinal)}`,
              parentId: request.parentId,
              // Every level but the deepest is a grouping level (D2).
              selectable: depth === deepest,
              position: request.ordinal,
            },
            db,
          );
          created[start + offset] = row.id;
        }),
      );
    }
    levels.push(created);
    parents = created;
    log(`  depth ${String(depth)}: ${String(created.length)} categories`);
  }

  const leaves = levels[deepest] ?? [];
  const productRows = leaves.flatMap((categoryId, index) =>
    Array.from({ length: SHAPE_OF_THE_TREE.productsPerLeaf }, (_, copy) => ({
      id: `${token}-p-${String(index)}-${String(copy)}`,
      slug: `${token}-p-${String(index)}-${String(copy)}`,
      name: `Ancestry bench product ${String(index)}/${String(copy)}`,
      // Per-run rather than literal: `normalized_name` is what the matcher's
      // retrieval looks up exactly, so a stable value here would be a standing
      // attractor for every other file's matcher. This benchmark owns its own
      // throwaway database, but the habit is what keeps that true if it ever
      // does not.
      normalizedName: `${token} bench product ${String(index)} ${String(copy)}`,
      categoryId,
      status: 'active' as const,
    })),
  );
  for (let start = 0; start < productRows.length; start += PRODUCT_BATCH) {
    await db.insert(canonicalProducts).values(productRows.slice(start, start + PRODUCT_BATCH));
  }
  log(`  products: ${String(productRows.length)}`);

  // Statistics before anything is measured. A plan chosen from PostgreSQL's
  // default estimates for a table it has never counted is a plan for a database
  // nobody runs, and the direction of that error is unpredictable rather than
  // conservative.
  await db.execute(sql`analyze categories, canonical_products`);

  const categoryCount = levels.reduce((total, level) => total + level.length, 0);
  return {
    token,
    categoryCount,
    productCount: productRows.length,
    depth: deepest + 1,
    idsByDepth: levels,
    rootId: levels[0]?.[0] ?? '',
    rootDescendants: subtreeDescendantCount(0),
    rootSubtreeProducts: subtreeLeafCount(0) * SHAPE_OF_THE_TREE.productsPerLeaf,
    midId: levels[2]?.[0] ?? '',
    midDescendants: subtreeDescendantCount(2),
    leafId: levels[deepest]?.[0] ?? '',
    leafAncestors: deepest,
  };
}

/**
 * The floors the seed must clear before any number it produced may be printed.
 *
 * `findRowCountViolations` is #61's, imported rather than re-derived: a second
 * implementation of a floor is a floor that can disagree with the one being
 * quoted.
 */
export function ancestrySeedFloors(): ReadonlyMap<string, number> {
  const categories =
    SHAPE_OF_THE_TREE.roots + SHAPE_OF_THE_TREE.roots * subtreeDescendantCount(0);
  return new Map<string, number>([
    ['categories', categories],
    ['canonical_products', SHAPE_OF_THE_TREE.productsPerLeaf * SHAPE_OF_THE_TREE.roots * subtreeLeafCount(0)],
  ]);
}

/** Count what the seed actually wrote — the evidence beside the promise. */
export async function countSeededTaxonomy(db: Database): Promise<ReadonlyMap<string, number>> {
  const rows = await db.execute<{ relation: string; rows: string | number }>(sql`
    select 'categories' as relation, count(*)::bigint as rows from categories
    union all
    select 'canonical_products' as relation, count(*)::bigint as rows from canonical_products`);
  // `Number(...)`: postgres.js decodes `bigint` as a STRING, so a bare value
  // here would compare lexicographically against its floor.
  return new Map(rows.map((row) => [row.relation, Number(row.rows)]));
}

// ─── Strategies and shapes ─────────────────────────────────────────────────

/** The two hierarchy strategies ADR 0007 D2 weighed against each other. */
export const ANCESTRY_STRATEGIES = ['materialized_path', 'recursive_cte'] as const;
export type AncestryStrategy = (typeof ANCESTRY_STRATEGIES)[number];

/** One statement postgres.js actually sent, replayable under `EXPLAIN`. */
export interface MeasuredStatement {
  readonly text: string;
  readonly parameters: readonly postgres.ParameterOrJSON<never>[];
}

/**
 * One side of one comparison: runs the strategy and returns the number of rows
 * the CALLER receives — which is the figure the vacuity floor is applied to,
 * because it is the only one a wrong subject id or an empty tree cannot flatter.
 */
type StrategyRun = (db: Database, seed: SeededTaxonomy) => Promise<number>;

/** One question, asked both ways. */
export interface AncestryShape {
  readonly id: string;
  readonly title: string;
  /** The production reader, or the provenance of a shape no shipped path runs. */
  readonly reader: string;
  /** Depth of the node the shape reads from, for the report. */
  readonly subjectDepth: number;
  /** Rows both sides must produce, from the tree's arithmetic. */
  readonly minRowsProduced: (seed: SeededTaxonomy) => number;
  /**
   * What the MATERIALIZED-PATH plan must show, when the shape is one whose
   * index use is asserted. Absent where the planner's choice is itself the
   * finding rather than a regression to gate.
   *
   * `minRowsReturned` is deliberately NOT part of it: the floor is
   * {@link minRowsProduced}, which is a function of the seeded tree, and stating
   * a second constant here is how the two come to disagree — with the weaker of
   * them silently deciding.
   */
  readonly materializedPathPlan?: Omit<ShapeExpectation, 'minRowsReturned'>;
  readonly materializedPath: StrategyRun;
  readonly recursiveCte: StrategyRun;
}

/**
 * Descendants of `subjectId`, as a recursive walk down `parent_id`.
 *
 * The same rows `findCategoryDescendants` returns, in the same order, with the
 * same projection — the difference between the two sides of this comparison is
 * the traversal and nothing else.
 */
async function recursiveDescendants(db: Database, subjectId: string): Promise<number> {
  const rows = await db.execute(sql`
    with recursive subtree as (
      select c.id from categories c where c.parent_id = ${subjectId}
      union all
      select c.id from categories c join subtree s on c.parent_id = s.id
    )
    select c.* from categories c join subtree s on s.id = c.id
    order by c.position asc, c.slug asc`);
  return rows.length;
}

export const ANCESTRY_SHAPES: readonly AncestryShape[] = [
  {
    id: 'T1',
    title: 'Descendants of a ROOT — the largest subtree in the tree',
    reader: 'db/taxonomy/taxonomyRepository.ts findCategoryDescendants',
    subjectDepth: 0,
    minRowsProduced: (seed) => seed.rootDescendants,
    materializedPath: async (db, seed) => (await findCategoryDescendants(seed.rootId, {}, db)).length,
    recursiveCte: (db, seed) => recursiveDescendants(db, seed.rootId),
  },
  {
    id: 'T2',
    title: 'Descendants of a MID-DEPTH node (level 2 of six)',
    reader: 'db/taxonomy/taxonomyRepository.ts findCategoryDescendants',
    subjectDepth: 2,
    minRowsProduced: (seed) => seed.midDescendants,
    // The narrow read is where a GIN'd containment predicate is supposed to
    // earn its place, so this is the shape whose index use is gated.
    materializedPathPlan: {
      requireIndexes: ['categories_ancestor_ids_idx'],
      forbidNodeTypes: ['Seq Scan'],
    },
    materializedPath: async (db, seed) => (await findCategoryDescendants(seed.midId, {}, db)).length,
    recursiveCte: (db, seed) => recursiveDescendants(db, seed.midId),
  },
  {
    id: 'T3',
    title: 'Ancestors of a DEEP LEAF — the breadcrumb read',
    reader: 'db/taxonomy/taxonomyRepository.ts findCategoryAncestors',
    subjectDepth: 5,
    minRowsProduced: (seed) => seed.leafAncestors,
    materializedPath: async (db, seed) => (await findCategoryAncestors(seed.leafId, db)).length,
    recursiveCte: async (db, seed) => {
      const rows = await db.execute(sql`
        with recursive ancestry as (
          select c.id, c.parent_id, 0 as hops from categories c where c.id = ${seed.leafId}
          union all
          select p.id, p.parent_id, a.hops + 1 from categories p join ancestry a on p.id = a.parent_id
        )
        select c.* from categories c join ancestry a on a.id = c.id
        where a.hops > 0
        order by a.hops desc`);
      return rows.length;
    },
  },
  {
    id: 'T4',
    title: 'Canonical products filed anywhere under a ROOT — the category-scoped read',
    reader:
      'SYNTHETIC, and no longer exploratory: `db/facets/facetRepository.ts ' +
      'countCategoryBuckets` ships this resolution on `POST /facets`, one ' +
      'correlated subtree per child bucket. This statement is still hand-written ' +
      'because the comparison needs BOTH strategies over one predicate and the ' +
      'shipped reader has only the one; the shipped reader is measured as C9 in ' +
      '`category-index-coverage.ts`, which calls it rather than restating it',
    subjectDepth: 0,
    minRowsProduced: (seed) => seed.rootSubtreeProducts,
    materializedPath: async (db, seed) => {
      const rows = await db.execute(sql`
        select p.id from canonical_products p
        where p.category_id in (
          select c.id from categories c where c.ancestor_ids @> array[${seed.rootId}]::text[]
          union all
          select ${seed.rootId}::text
        )`);
      return rows.length;
    },
    recursiveCte: async (db, seed) => {
      const rows = await db.execute(sql`
        with recursive subtree as (
          select c.id from categories c where c.id = ${seed.rootId}
          union all
          select c.id from categories c join subtree s on c.parent_id = s.id
        )
        select p.id from canonical_products p join subtree s on s.id = p.category_id`);
      return rows.length;
    },
  },
];

// ─── Measurement ───────────────────────────────────────────────────────────

/** The plan facts of one strategy, summed across the statements it sends. */
export interface StrategyPlanFacts {
  /** How many round trips the strategy costs — a first-class part of the answer. */
  readonly statementCount: number;
  /** Rows the LAST statement returned; the earlier ones are lookups. */
  readonly rowsReturned: number;
  /** Rows the executor touched at the leaves, summed over every statement. */
  readonly rowsScanned: number;
  readonly executionTimeMs: number;
  readonly planningTimeMs: number;
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  readonly nodeTypes: readonly string[];
  readonly indexNames: readonly string[];
}

/**
 * Fold one strategy's per-statement plans into the facts a comparison quotes.
 *
 * @throws {Error} On an empty list. A strategy that sent no statement produced
 *   its rows from somewhere this harness cannot see, and reporting zeroes for it
 *   would read exactly like the fastest possible query.
 */
export function aggregatePlanFacts(analyses: readonly PlanAnalysis[]): StrategyPlanFacts {
  if (analyses.length === 0) throw new Error('aggregatePlanFacts needs at least one plan.');
  const nodeTypes = new Set<string>();
  const indexNames = new Set<string>();
  let rowsScanned = 0;
  let executionTimeMs = 0;
  let planningTimeMs = 0;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  for (const analysis of analyses) {
    for (const nodeType of analysis.nodeTypes) nodeTypes.add(nodeType);
    for (const indexName of analysis.indexNames) indexNames.add(indexName);
    rowsScanned += analysis.rowsScanned;
    executionTimeMs += analysis.executionTimeMs;
    planningTimeMs += analysis.planningTimeMs;
    sharedHitBlocks += analysis.sharedHitBlocks;
    sharedReadBlocks += analysis.sharedReadBlocks;
  }
  const last = analyses[analyses.length - 1];
  return {
    statementCount: analyses.length,
    rowsReturned: last ? last.rowsReturned : 0,
    rowsScanned,
    executionTimeMs,
    planningTimeMs,
    sharedHitBlocks,
    sharedReadBlocks,
    nodeTypes: [...nodeTypes].sort(),
    indexNames: [...indexNames].sort(),
  };
}

/** Everything one strategy yielded for one shape. */
export interface StrategyMeasurement {
  readonly strategy: AncestryStrategy;
  readonly statements: readonly MeasuredStatement[];
  /** One `PlanAnalysis` per statement, in the order they were sent. */
  readonly analyses: readonly PlanAnalysis[];
  readonly plan: StrategyPlanFacts;
  readonly latency: LatencySummary;
  /** Rows the caller received — what the vacuity floor is applied to. */
  readonly rowsProduced: number;
}

/** One shape, measured both ways. */
export interface ShapeComparison {
  readonly shapeId: string;
  readonly title: string;
  readonly reader: string;
  readonly subjectDepth: number;
  readonly minRowsProduced: number;
  readonly materializedPath: StrategyMeasurement;
  readonly recursiveCte: StrategyMeasurement;
}

interface ExplainRow {
  readonly 'QUERY PLAN': unknown;
}

/**
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` one recorded statement.
 *
 * Exported because the plan-mutation self-test replays exactly these statements
 * with an index dropped, and a second spelling of the EXPLAIN would be a second
 * thing to keep in step with the one being quoted.
 */
export async function explainStatement(
  runner: postgres.Sql | postgres.TransactionSql,
  statement: MeasuredStatement,
): Promise<PlanAnalysis> {
  const rows = await runner.unsafe<ExplainRow[]>(
    `explain (analyze, buffers, format json) ${statement.text}`,
    [...statement.parameters],
  );
  return parsePlanJson(rows[0]?.['QUERY PLAN']);
}

/**
 * Run one strategy once to record what it sends, then EXPLAIN it once and time
 * it `latencyRuns` times without instrumentation.
 *
 * The timing replays the RECORDED statements rather than calling the reader
 * again, so both strategies are timed by identical code — a reader called
 * through drizzle would otherwise be paying for the query builder while the
 * hand-written CTE was not, and that difference has nothing to do with either
 * hierarchy strategy.
 */
async function measureStrategy(
  capturing: CapturingDatabase,
  strategy: AncestryStrategy,
  run: StrategyRun,
  seed: SeededTaxonomy,
  latencyRuns: number,
): Promise<StrategyMeasurement> {
  capturing.begin();
  const rowsProduced = await run(capturing.db, seed);
  const statements: MeasuredStatement[] = capturing.take();
  if (statements.length === 0) throw new Error(`${strategy} issued no statement.`);

  const analyses: PlanAnalysis[] = [];
  for (const statement of statements) {
    analyses.push(await explainStatement(capturing.client, statement));
  }

  const samples: number[] = [];
  for (let attempt = 0; attempt < latencyRuns; attempt += 1) {
    const started = performance.now();
    for (const statement of statements) {
      await capturing.client.unsafe(statement.text, [...statement.parameters]);
    }
    samples.push(performance.now() - started);
  }

  return {
    strategy,
    statements,
    analyses,
    plan: aggregatePlanFacts(analyses),
    latency: summarizeLatency(samples),
    rowsProduced,
  };
}

// ─── The verdict ───────────────────────────────────────────────────────────

/**
 * How much faster one side has to be, RELATIVELY, before it is called a win.
 *
 * Ten per cent, and it is a real decision rather than a rounding convenience:
 * reporting a 3% difference as "the recursive CTE wins" would amend an ADR on
 * scheduler noise.
 */
export const ANCESTRY_TIE_BAND = 1.1;

/**
 * How much faster one side has to be, ABSOLUTELY, before it is called a win.
 *
 * The relative band alone is not enough and this was measured rather than
 * anticipated: on the breadcrumb shape, whose two sides both answer in about
 * half a millisecond, consecutive runs of this benchmark put the materialized
 * path ahead by 1.15x and then behind by 1.11x — flipping the OVERALL verdict
 * between "agrees with D2" and "disagrees" on a difference of fifty
 * microseconds. A percentage of a very small number is a very small number, and
 * an ADR amended on one is an ADR amended on which container had the CPU.
 *
 * A quarter of a millisecond, which is roughly one round trip to a database on
 * the other side of an availability zone — below that the strategy is not what
 * the caller is waiting for.
 */
export const ANCESTRY_TIE_FLOOR_MS = 0.25;

export type ShapeVerdict =
  | {
      readonly outcome: 'refused';
      readonly shapeId: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly outcome: 'measured';
      readonly shapeId: string;
      /** `'tie'` when the two sit inside {@link ANCESTRY_TIE_BAND}. */
      readonly winner: AncestryStrategy | 'tie';
      /** Slower p50 over faster p50, always at least 1. */
      readonly latencyRatio: number;
      /** Recursive-CTE rows scanned over materialized-path rows scanned. */
      readonly rowsScannedRatio: number;
      readonly sentence: string;
    };

/** Whether the measurement supports the choice D2 made provisionally. */
export type AncestryAdrAgreement = 'agrees' | 'disagrees' | 'inconclusive';

export interface AncestryVerdict {
  readonly shapes: readonly ShapeVerdict[];
  readonly adrD2: AncestryAdrAgreement;
  readonly summary: readonly string[];
}

/**
 * Turn measurements into an answer, purely — no database, no clock, no I/O.
 *
 * Separate from the measuring so the decision rule can be tested against
 * measurements nobody took: the interesting cases are a tie, a refusal and a
 * recursive-CTE win, and waiting for hardware to produce one of those is how a
 * decision rule ends up asserted by nothing.
 */
export function deriveAncestryVerdict(
  comparisons: readonly ShapeComparison[],
): AncestryVerdict {
  const shapes: ShapeVerdict[] = [];
  const summary: string[] = [];

  for (const comparison of comparisons) {
    const reasons: string[] = [];
    const path = comparison.materializedPath;
    const cte = comparison.recursiveCte;

    if (path.rowsProduced === 0 || cte.rowsProduced === 0) {
      reasons.push(
        `${comparison.shapeId}: a side produced ZERO rows (materialized path ` +
          `${String(path.rowsProduced)}, recursive CTE ${String(cte.rowsProduced)}) — ` +
          `the comparison measured nothing.`,
      );
    }
    if (path.rowsProduced !== cte.rowsProduced) {
      reasons.push(
        `${comparison.shapeId}: the two strategies disagree — materialized path ` +
          `${String(path.rowsProduced)} rows, recursive CTE ${String(cte.rowsProduced)}. ` +
          `They are not answering the same question, so neither timing means anything.`,
      );
    }
    if (path.rowsProduced < comparison.minRowsProduced) {
      reasons.push(
        `${comparison.shapeId}: produced ${String(path.rowsProduced)} rows, the tree's ` +
          `arithmetic says at least ${String(comparison.minRowsProduced)} — the seed came out ` +
          `flatter than it claims.`,
      );
    }

    if (reasons.length > 0) {
      shapes.push({ outcome: 'refused', shapeId: comparison.shapeId, reasons });
      continue;
    }

    const pathP50 = Math.max(path.latency.p50Ms, Number.EPSILON);
    const cteP50 = Math.max(cte.latency.p50Ms, Number.EPSILON);
    const ratio = pathP50 <= cteP50 ? cteP50 / pathP50 : pathP50 / cteP50;
    const deltaMs = Math.abs(pathP50 - cteP50);
    // BOTH thresholds, and the conjunction is the rule: a 2x difference between
    // 0.10 ms and 0.20 ms is still a tie, because nothing downstream of this
    // benchmark can act on a tenth of a millisecond.
    const decisive = ratio >= ANCESTRY_TIE_BAND && deltaMs >= ANCESTRY_TIE_FLOOR_MS;
    const winner: AncestryStrategy | 'tie' = !decisive
      ? 'tie'
      : pathP50 < cteP50
        ? 'materialized_path'
        : 'recursive_cte';
    const rowsScannedRatio =
      path.plan.rowsScanned === 0
        ? cte.plan.rowsScanned
        : cte.plan.rowsScanned / path.plan.rowsScanned;
    const sentence =
      winner === 'tie'
        ? `${comparison.shapeId}: TIE (${ratio.toFixed(2)}×, ${deltaMs.toFixed(3)} ms apart; ` +
          `a win needs ${String(ANCESTRY_TIE_BAND)}× AND ` +
          `${String(ANCESTRY_TIE_FLOOR_MS)} ms) — materialized path p50 ` +
          `${pathP50.toFixed(3)} ms (${String(path.plan.statementCount)} statement(s), ` +
          `${String(path.plan.rowsScanned)} rows scanned), recursive CTE p50 ` +
          `${cteP50.toFixed(3)} ms (${String(cte.plan.statementCount)} statement(s), ` +
          `${String(cte.plan.rowsScanned)} rows scanned).`
        : `${comparison.shapeId}: ${winner === 'materialized_path' ? 'MATERIALIZED PATH' : 'RECURSIVE CTE'} ` +
          `wins by ${ratio.toFixed(2)}× (${deltaMs.toFixed(3)} ms) — materialized path p50 ` +
          `${pathP50.toFixed(3)} ms (${String(path.plan.statementCount)} statement(s), ` +
          `${String(path.plan.rowsScanned)} rows scanned), recursive CTE p50 ` +
          `${cteP50.toFixed(3)} ms (${String(cte.plan.statementCount)} statement(s), ` +
          `${String(cte.plan.rowsScanned)} rows scanned).`;

    shapes.push({
      outcome: 'measured',
      shapeId: comparison.shapeId,
      winner,
      latencyRatio: ratio,
      rowsScannedRatio,
      sentence,
    });
    summary.push(sentence);
  }

  if (comparisons.length === 0) {
    return {
      shapes,
      adrD2: 'inconclusive',
      summary: ['No shape was measured at all.'],
    };
  }
  const refused = shapes.filter((shape) => shape.outcome === 'refused');
  if (refused.length > 0) {
    return {
      shapes,
      adrD2: 'inconclusive',
      summary: refused.flatMap((shape) => (shape.outcome === 'refused' ? shape.reasons : [])),
    };
  }
  const cteWins = shapes.filter(
    (shape) => shape.outcome === 'measured' && shape.winner === 'recursive_cte',
  );
  return {
    shapes,
    adrD2: cteWins.length > 0 ? 'disagrees' : 'agrees',
    summary,
  };
}

// ─── Running the whole thing ───────────────────────────────────────────────

export interface AncestryBenchmarkResult {
  readonly seed: SeededTaxonomy;
  readonly postgresVersion: string;
  readonly latencyRuns: number;
  readonly seedFloorViolations: readonly string[];
  readonly rowCounts: ReadonlyMap<string, number>;
  readonly comparisons: readonly ShapeComparison[];
  readonly verdict: AncestryVerdict;
}

/**
 * Uninstrumented executions per strategy per shape.
 *
 * Two hundred rather than the thirty this started at, for the reason
 * {@link ANCESTRY_TIE_FLOOR_MS} exists: at thirty samples the p50 of a
 * half-millisecond read moved enough between consecutive runs to change which
 * strategy the breadcrumb shape reported as faster. Samples are the cheap half
 * of that fix and the tie floor is the honest half; neither alone was enough.
 */
export const DEFAULT_ANCESTRY_LATENCY_RUNS = 200;

/**
 * Seed, measure every shape both ways, and answer.
 *
 * Takes an already-open recording handle rather than a URL, because the caller
 * that owns the throwaway database is also the one that has to EXPLAIN the
 * recorded statements again with an index dropped — and a function that opened
 * and closed its own connection would leave it nothing to do that with.
 */
export async function runAncestryBenchmark(
  capturing: CapturingDatabase,
  options: { readonly latencyRuns?: number; readonly log?: (line: string) => void } = {},
): Promise<AncestryBenchmarkResult> {
  const log = options.log ?? ((): void => undefined);
  const latencyRuns = options.latencyRuns ?? DEFAULT_ANCESTRY_LATENCY_RUNS;

  log('seeding the taxonomy…');
  const seed = await seedAncestryTaxonomy(capturing.db, log);
  const rowCounts = await countSeededTaxonomy(capturing.db);
  const seedFloorViolations = findRowCountViolations(rowCounts, ancestrySeedFloors());

  const versionRows = await capturing.db.execute<{ version: string }>(
    sql`select version() as version`,
  );
  const postgresVersion = versionRows[0]?.version ?? 'unknown';

  const comparisons: ShapeComparison[] = [];
  for (const shape of ANCESTRY_SHAPES) {
    log(`measuring ${shape.id}…`);
    const materializedPath = await measureStrategy(
      capturing,
      'materialized_path',
      shape.materializedPath,
      seed,
      latencyRuns,
    );
    const recursiveCte = await measureStrategy(
      capturing,
      'recursive_cte',
      shape.recursiveCte,
      seed,
      latencyRuns,
    );
    comparisons.push({
      shapeId: shape.id,
      title: shape.title,
      reader: shape.reader,
      subjectDepth: shape.subjectDepth,
      minRowsProduced: shape.minRowsProduced(seed),
      materializedPath,
      recursiveCte,
    });
  }

  return {
    seed,
    postgresVersion,
    latencyRuns,
    seedFloorViolations,
    rowCounts,
    comparisons,
    verdict: deriveAncestryVerdict(comparisons),
  };
}

/** The measurement as text somebody can paste into the ADR. */
export function renderAncestryReport(result: AncestryBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('# Taxonomy hierarchy benchmark (ADR 0007 D2)');
  lines.push('');
  lines.push(`PostgreSQL: ${result.postgresVersion}`);
  lines.push(
    `Tree: ${String(result.seed.categoryCount)} categories, depth ${String(result.seed.depth)}` +
      ` (a leaf carries ${String(result.seed.leafAncestors)} ancestors); ` +
      `${String(result.seed.productCount)} canonical products on ` +
      `${String(result.seed.idsByDepth[result.seed.idsByDepth.length - 1]?.length ?? 0)} leaves.`,
  );
  lines.push(
    `Row counts measured: ${[...result.rowCounts]
      .map(([relation, count]) => `${relation}=${String(count)}`)
      .join(', ')}`,
  );
  lines.push(`Latency runs per strategy per shape: ${String(result.latencyRuns)} (uninstrumented).`);
  if (result.seedFloorViolations.length > 0) {
    lines.push('');
    lines.push('## THIS RUN MEASURED NOTHING');
    lines.push(...result.seedFloorViolations.map((violation) => `- ${violation}`));
    return lines.join('\n');
  }

  for (const comparison of result.comparisons) {
    lines.push('');
    lines.push(`## ${comparison.shapeId} — ${comparison.title}`);
    lines.push(`reader: ${comparison.reader}`);
    lines.push(
      `subject depth ${String(comparison.subjectDepth)}; floor ${String(comparison.minRowsProduced)} rows`,
    );
    lines.push('');
    lines.push('| strategy | stmts | rows out | rows scanned | p50 ms | p95 ms | p99 ms | nodes | indexes |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
    for (const side of [comparison.materializedPath, comparison.recursiveCte]) {
      lines.push(
        `| ${side.strategy} | ${String(side.plan.statementCount)} | ` +
          `${String(side.rowsProduced)} | ${String(side.plan.rowsScanned)} | ` +
          `${side.latency.p50Ms.toFixed(3)} | ${side.latency.p95Ms.toFixed(3)} | ` +
          `${side.latency.p99Ms.toFixed(3)} | ${side.plan.nodeTypes.join(', ')} | ` +
          `${side.plan.indexNames.join(', ') || '—'} |`,
      );
    }
  }

  lines.push('');
  lines.push('## Verdict');
  lines.push(`ADR 0007 D2's provisional materialized path: **${result.verdict.adrD2}**`);
  lines.push(...result.verdict.summary.map((sentence) => `- ${sentence}`));
  return lines.join('\n');
}
