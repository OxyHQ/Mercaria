/**
 * Reading a PostgreSQL plan, and refusing to believe a measurement that
 * measured nothing (#61).
 *
 * The failure mode this module exists for is the one #61 shares with the
 * backfill (`docs/backfill.md`): **a report that says it went fine.** A
 * generator that inserted no rows, a query whose predicate matched nothing and a
 * plan captured against an empty table all produce the same output as a clean
 * run — a small number, a tidy plan, no error. Every number this harness prints
 * is therefore accompanied by a floor that must be cleared before it is allowed
 * to be printed at all, and {@link findVacuityViolations} is where those floors
 * live.
 *
 * Everything here is PURE. It takes a parsed `EXPLAIN (ANALYZE, BUFFERS, FORMAT
 * JSON)` payload and a list of timings and returns facts; it opens no
 * connection, so the floors can be mutation-tested without a database and a
 * broken floor cannot hide behind a slow seed.
 *
 * ## Why JSON rather than the text plan
 *
 * `offer-load-benchmark.ts` (#57) regexes `Execution Time` out of the text
 * format, which is enough to print a number beside a plan a person reads. It
 * cannot answer "how many rows did this touch to return four" without parsing
 * an indented tree out of prose. The JSON format gives the same tree as data,
 * so rows-scanned-versus-returned, the buffer split and the index actually
 * chosen are READ rather than pattern-matched.
 */

/** One node of a PostgreSQL plan tree, narrowed to the fields #61 measures. */
export interface PlanNode {
  readonly nodeType: string;
  readonly relationName: string | null;
  readonly indexName: string | null;
  /** Rows this node emitted PER LOOP — Postgres reports the per-loop average. */
  readonly actualRows: number;
  readonly actualLoops: number;
  readonly rowsRemovedByFilter: number;
  readonly rowsRemovedByIndexRecheck: number;
  /** Buffers are CUMULATIVE over the subtree, so the root carries the total. */
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  readonly children: readonly PlanNode[];
}

/** What one `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` execution said. */
export interface PlanAnalysis {
  readonly planningTimeMs: number;
  readonly executionTimeMs: number;
  readonly root: PlanNode;
  /** Rows the statement actually returned to the client. */
  readonly rowsReturned: number;
  /**
   * Rows the executor had to look at at the BOTTOM of the tree.
   *
   * Summed over LEAF nodes only, and each leaf contributes
   * `(emitted + removed by filter + removed by index recheck) × loops` — so a
   * filter that throws away 90% of what it read is visible, and a nested loop
   * that re-scans its inner side 500 times is counted 500 times rather than
   * once. Counting interior nodes too would double-count every row that passes
   * through a sort or an aggregate on its way up.
   */
  readonly rowsScanned: number;
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  /** Every node type in the tree — what a plan regression asserts against. */
  readonly nodeTypes: readonly string[];
  /** Every index the plan actually used. */
  readonly indexNames: readonly string[];
}

/** Latency percentiles over repeated uninstrumented executions. */
export interface LatencySummary {
  readonly runs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function parseNode(source: Record<string, unknown>): PlanNode {
  const rawChildren = source['Plans'];
  const children = Array.isArray(rawChildren)
    ? rawChildren.filter(isRecord).map(parseNode)
    : [];
  return {
    nodeType: readString(source, 'Node Type') ?? 'Unknown',
    relationName: readString(source, 'Relation Name'),
    indexName: readString(source, 'Index Name'),
    actualRows: readNumber(source, 'Actual Rows'),
    actualLoops: readNumber(source, 'Actual Loops'),
    rowsRemovedByFilter: readNumber(source, 'Rows Removed by Filter'),
    rowsRemovedByIndexRecheck: readNumber(source, 'Rows Removed by Index Recheck'),
    sharedHitBlocks: readNumber(source, 'Shared Hit Blocks'),
    sharedReadBlocks: readNumber(source, 'Shared Read Blocks'),
    children,
  };
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Turn the one row `EXPLAIN … FORMAT JSON` returns into facts.
 *
 * @throws {Error} When the payload is not a plan at all — an empty result, a
 *   driver that handed back a string, a statement that was not an EXPLAIN. That
 *   is a harness bug and must stop the run rather than degrade into a row of
 *   zeroes, which would read exactly like a fast query.
 */
export function parsePlanJson(payload: unknown): PlanAnalysis {
  const entries = Array.isArray(payload) ? payload : [payload];
  const first = entries.find(isRecord);
  if (!first) throw new Error('EXPLAIN returned no plan object.');
  const rawPlan = first['Plan'];
  if (!isRecord(rawPlan)) throw new Error('EXPLAIN payload carries no "Plan" node.');

  const root = parseNode(rawPlan);
  let rowsScanned = 0;
  const nodeTypes = new Set<string>();
  const indexNames = new Set<string>();
  walk(root, (node) => {
    nodeTypes.add(node.nodeType);
    if (node.indexName !== null) indexNames.add(node.indexName);
    if (node.children.length === 0) {
      rowsScanned +=
        (node.actualRows + node.rowsRemovedByFilter + node.rowsRemovedByIndexRecheck) *
        Math.max(1, node.actualLoops);
    }
  });

  return {
    planningTimeMs: readNumber(first, 'Planning Time'),
    executionTimeMs: readNumber(first, 'Execution Time'),
    root,
    rowsReturned: root.actualRows * Math.max(1, root.actualLoops),
    rowsScanned,
    sharedHitBlocks: root.sharedHitBlocks,
    sharedReadBlocks: root.sharedReadBlocks,
    nodeTypes: [...nodeTypes].sort(),
    indexNames: [...indexNames].sort(),
  };
}

/**
 * Nearest-rank percentiles.
 *
 * Nearest-rank rather than an interpolating definition, because every value
 * reported is then a latency that was actually observed. An interpolated p99
 * over 50 samples is a number between two real ones, and quoting it as "the
 * ninety-ninth percentile latency" claims a measurement nobody took.
 *
 * @throws {Error} On an empty sample. A percentile of nothing is the vacuity
 *   this module exists to refuse, and returning 0 would print as a fast query.
 */
export function summarizeLatency(samplesMs: readonly number[]): LatencySummary {
  if (samplesMs.length === 0) throw new Error('summarizeLatency needs at least one sample.');
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const at = (quantile: number): number => {
    const rank = Math.ceil(quantile * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
  };
  return {
    runs: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * What a measurement of this shape must clear before its number means anything.
 *
 * `minRowsReturned` is the floor that catches the whole class: a read that
 * SHOULD find the hottest variant's offers and returns zero has measured an
 * empty predicate, and its 0.02 ms is a fact about nothing. A shape that
 * legitimately returns nothing (a sweep with no lapsed rows, an idempotency
 * probe for a key that is deliberately absent) declares `minRowsReturned: 0`
 * and states why, so the exemption is a decision somebody wrote down rather
 * than a floor nobody set.
 */
export interface ShapeExpectation {
  readonly minRowsReturned: number;
  /** Indexes the plan MUST use — the regression half of decision rule 8. */
  readonly requireIndexes?: readonly string[];
  /** Node types the plan must NOT contain, e.g. a sequential scan at scale. */
  readonly forbidNodeTypes?: readonly string[];
}

/**
 * Every way this measurement failed to measure anything, as sentences.
 *
 * A LIST rather than a throw: one run covers fourteen shapes and reporting the
 * first failure would hide the other thirteen behind it, which is how a
 * benchmark gets fixed one shape per re-run.
 */
export function findVacuityViolations(
  label: string,
  analysis: PlanAnalysis,
  expectation: ShapeExpectation,
): string[] {
  const violations: string[] = [];
  if (analysis.rowsReturned < expectation.minRowsReturned) {
    violations.push(
      `${label}: returned ${String(analysis.rowsReturned)} rows, expected at least ` +
        `${String(expectation.minRowsReturned)} — the measurement is vacuous.`,
    );
  }
  for (const required of expectation.requireIndexes ?? []) {
    if (!analysis.indexNames.includes(required)) {
      violations.push(
        `${label}: plan did not use ${required} (used: ` +
          `${analysis.indexNames.join(', ') || 'no index'}).`,
      );
    }
  }
  for (const forbidden of expectation.forbidNodeTypes ?? []) {
    if (analysis.nodeTypes.includes(forbidden)) {
      violations.push(`${label}: plan contains a forbidden node type ${forbidden}.`);
    }
  }
  return violations;
}

/**
 * Every table whose seeded row count came in under the floor the scale promised.
 *
 * The dataset half of the same refusal: `assertCohortIsNotEmpty` for a
 * benchmark. A generator that silently wrote a tenth of what it announced
 * produces plans that are correct and latencies that are meaningless, and
 * nothing downstream can tell that apart from a fast database.
 */
export function findRowCountViolations(
  counts: ReadonlyMap<string, number>,
  floors: ReadonlyMap<string, number>,
): string[] {
  const violations: string[] = [];
  for (const [table, floor] of floors) {
    const actual = counts.get(table);
    if (actual === undefined) {
      violations.push(`${table}: not counted — the dataset census missed it.`);
      continue;
    }
    if (actual < floor) {
      violations.push(
        `${table}: ${String(actual)} rows, floor is ${String(floor)} — the seed fell short.`,
      );
    }
  }
  return violations;
}
