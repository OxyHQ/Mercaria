/**
 * The vacuity floors, and the proof that they are not vacuous themselves.
 *
 * #61's harness exists to produce numbers somebody will quote, and the thing
 * that makes a benchmark dangerous is that a measurement of NOTHING looks
 * exactly like a fast one. `measure.ts` is where the refusals live, so every
 * assertion here is paired with a mutation self-test: the check is run against
 * an input that must FAIL it, so a floor that rotted into always-passing turns
 * this file red instead of turning the report into fiction.
 *
 * These tests take no database on purpose. A floor that can only be exercised
 * by seeding a hundred thousand products is a floor nobody re-runs.
 */

import { describe, expect, it } from 'vitest';
import {
  findRowCountViolations,
  findVacuityViolations,
  parsePlanJson,
  summarizeLatency,
  type PlanAnalysis,
} from '../measure.js';

/**
 * A plan payload in the exact shape `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
 * returns: an ARRAY holding one object whose `Plan` is the tree root.
 */
function planPayload(root: Record<string, unknown>, timings?: Record<string, number>): unknown {
  return [{ 'Planning Time': 0.2, 'Execution Time': 1.5, ...timings, Plan: root }];
}

const indexScan = {
  'Node Type': 'Index Scan',
  'Relation Name': 'offers',
  'Index Name': 'offers_variant_comparison_idx',
  'Actual Rows': 20,
  'Actual Loops': 1,
  'Rows Removed by Filter': 130,
  'Shared Hit Blocks': 49,
  'Shared Read Blocks': 0,
};

describe('parsePlanJson', () => {
  it('reads the facts #61 measures out of one plan', () => {
    const analysis = parsePlanJson(
      planPayload({
        'Node Type': 'Limit',
        'Actual Rows': 20,
        'Actual Loops': 1,
        'Shared Hit Blocks': 49,
        'Shared Read Blocks': 3,
        Plans: [indexScan],
      }),
    );

    expect(analysis.rowsReturned).toBe(20);
    // 20 emitted + 130 the filter threw away, at the ONE leaf.
    expect(analysis.rowsScanned).toBe(150);
    expect(analysis.nodeTypes).toEqual(['Index Scan', 'Limit']);
    expect(analysis.indexNames).toEqual(['offers_variant_comparison_idx']);
    // Buffers are cumulative over the subtree, so the ROOT carries the total.
    expect(analysis.sharedHitBlocks).toBe(49);
    expect(analysis.sharedReadBlocks).toBe(3);
    expect(analysis.executionTimeMs).toBe(1.5);
  });

  it('multiplies a re-scanned inner side by its loop count', () => {
    // The nested-loop case, which is the one a per-leaf sum gets wrong if it
    // ignores loops: an inner index scan run 500 times has touched 500 rows,
    // not the one row Postgres reports as its per-loop average.
    const analysis = parsePlanJson(
      planPayload({
        'Node Type': 'Nested Loop',
        'Actual Rows': 500,
        'Actual Loops': 1,
        Plans: [
          { 'Node Type': 'Seq Scan', 'Actual Rows': 500, 'Actual Loops': 1 },
          {
            'Node Type': 'Index Scan',
            'Index Name': 'offers_pkey',
            'Actual Rows': 1,
            'Actual Loops': 500,
          },
        ],
      }),
    );
    expect(analysis.rowsScanned).toBe(500 + 500);
  });

  it('refuses a payload that is not a plan, rather than reporting zeroes', () => {
    // A row of zeroes reads exactly like an instant query, which is the whole
    // failure mode this module exists to refuse.
    expect(() => parsePlanJson([])).toThrow(/no plan object/i);
    expect(() => parsePlanJson([{ 'Execution Time': 1 }])).toThrow(/no "Plan" node/i);
    expect(() => parsePlanJson('QUERY PLAN')).toThrow();
  });
});

describe('summarizeLatency', () => {
  it('reports percentiles that were actually observed', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    const summary = summarizeLatency(samples);
    expect(summary.runs).toBe(100);
    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(95);
    expect(summary.p99Ms).toBe(99);
    expect(summary.minMs).toBe(1);
    expect(summary.maxMs).toBe(100);
    // Nearest-rank, so every reported figure is one of the inputs.
    expect(samples).toContain(summary.p99Ms);
  });

  it('does not invent a percentile from an empty sample', () => {
    expect(() => summarizeLatency([])).toThrow(/at least one sample/i);
  });

  it('handles a single sample without reaching outside the array', () => {
    const summary = summarizeLatency([7]);
    expect(summary.p50Ms).toBe(7);
    expect(summary.p99Ms).toBe(7);
  });
});

/** A minimal analysis with the fields the floors read. */
function analysisWith(overrides: Partial<PlanAnalysis>): PlanAnalysis {
  return {
    planningTimeMs: 0,
    executionTimeMs: 0,
    root: {
      nodeType: 'Limit',
      relationName: null,
      indexName: null,
      actualRows: 0,
      actualLoops: 1,
      rowsRemovedByFilter: 0,
      rowsRemovedByIndexRecheck: 0,
      sharedHitBlocks: 0,
      sharedReadBlocks: 0,
      children: [],
    },
    rowsReturned: 20,
    rowsScanned: 20,
    sharedHitBlocks: 0,
    sharedReadBlocks: 0,
    nodeTypes: ['Index Scan', 'Limit'],
    indexNames: ['offers_variant_comparison_idx'],
    ...overrides,
  };
}

describe('findVacuityViolations', () => {
  it('passes a measurement that measured something', () => {
    expect(
      findVacuityViolations('Q05', analysisWith({}), {
        minRowsReturned: 1,
        requireIndexes: ['offers_variant_comparison_idx'],
        forbidNodeTypes: ['Seq Scan'],
      }),
    ).toEqual([]);
  });

  it('refuses a read that returned nothing — the mutation self-test', () => {
    // Break the thing the floor guards, in miniature. A read that matched no
    // rows is fast for a reason that has nothing to do with the schema, and
    // this is the case that must never pass silently.
    const violations = findVacuityViolations('Q13', analysisWith({ rowsReturned: 0 }), {
      minRowsReturned: 1,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/Q13/);
    expect(violations[0]).toMatch(/vacuous/);
  });

  it('refuses a plan that stopped using the index it was measured on', () => {
    const violations = findVacuityViolations('Q05', analysisWith({ indexNames: [] }), {
      minRowsReturned: 1,
      requireIndexes: ['offers_variant_comparison_idx'],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/offers_variant_comparison_idx/);
    // The message must name what the plan DID use, or an operator reading a red
    // build has to re-run the benchmark to learn anything.
    expect(violations[0]).toMatch(/no index/);
  });

  it('refuses a forbidden node type', () => {
    const violations = findVacuityViolations(
      'Q07',
      analysisWith({ nodeTypes: ['Limit', 'Seq Scan'] }),
      { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/Seq Scan/);
  });

  it('reports EVERY failure rather than the first', () => {
    // One run covers fifteen shapes; stopping at the first would hide the other
    // fourteen behind it and turn a fix into one re-run per shape.
    const violations = findVacuityViolations(
      'Q05',
      analysisWith({ rowsReturned: 0, indexNames: [], nodeTypes: ['Seq Scan'] }),
      {
        minRowsReturned: 1,
        requireIndexes: ['offers_variant_comparison_idx'],
        forbidNodeTypes: ['Seq Scan'],
      },
    );
    expect(violations).toHaveLength(3);
  });
});

describe('findRowCountViolations', () => {
  const floors = new Map([
    ['offers', 1_000_000],
    ['canonical_products', 100_000],
  ]);

  it('passes a seed that reached its floors', () => {
    const counts = new Map([
      ['offers', 1_000_142],
      ['canonical_products', 100_001],
    ]);
    expect(findRowCountViolations(counts, floors)).toEqual([]);
  });

  it('refuses a seed that fell short — the mutation self-test', () => {
    const counts = new Map([
      ['offers', 103_500],
      ['canonical_products', 100_001],
    ]);
    const violations = findRowCountViolations(counts, floors);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/offers/);
    expect(violations[0]).toMatch(/103500|103,500/);
  });

  it('refuses a table the census never counted', () => {
    // A traversal that skipped a table reports the same empty violation list as
    // a healthy seed, so an ABSENT count has to be a failure and not a pass.
    const violations = findRowCountViolations(new Map([['offers', 1_000_000]]), floors);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/canonical_products/);
    expect(violations[0]).toMatch(/not counted/);
  });

  it('an empty census against empty floors is not evidence of anything', () => {
    // Pinned deliberately: `expect([]).toEqual([])` is what a BROKEN scan
    // produces, so the vacuity floor for the floors themselves lives in the
    // caller — `rowCountFloors` is derived from the scale and is never empty.
    expect(findRowCountViolations(new Map(), new Map())).toEqual([]);
  });
});
