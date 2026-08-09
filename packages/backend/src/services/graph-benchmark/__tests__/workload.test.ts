/**
 * The workload covers what #61 asked for, and every shape it calls a "shipped
 * read" really is one.
 *
 * The failure mode: a shape quietly dropped, or a `reader` string that names a
 * function somebody has since renamed. Both leave a SMALLER report that looks
 * exactly like a healthy one — the same shape as every under-count in
 * `~/Oxy/AGENTS.md` §"Metro bundle freshness" (H), where finding less is
 * indistinguishable from there being less. So the coverage assertion is against
 * #61's own numbered list, and each `reader` is resolved against the real module
 * rather than eyeballed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coveredWorkloadItems,
  EXPLORATORY_SHAPES,
  WORKLOAD_SHAPES,
} from '../workload.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * #61's "Required query workload" — its fourteen numbered entries.
 *
 * Written out rather than derived from the shapes, on purpose: deriving it from
 * the thing under test is how a dropped shape passes as a shorter list.
 */
const ISSUE_WORKLOAD_ITEMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

describe('the benchmark workload', () => {
  it('covers every numbered workload item in #61', () => {
    const covered = coveredWorkloadItems();
    const missing = ISSUE_WORKLOAD_ITEMS.filter((item) => !covered.has(item));
    expect(missing, `#61 workload items with no measured shape: ${missing.join(', ')}`).toEqual([]);
  });

  it('claims no workload item the issue does not have', () => {
    const known = new Set<number>(ISSUE_WORKLOAD_ITEMS);
    for (const item of coveredWorkloadItems()) {
      expect(known.has(item), `shape claims workload item ${String(item)}, which #61 has not`).toBe(
        true,
      );
    }
  });

  it('has a vacuity floor on its own size', () => {
    // A traversal that returned nothing would satisfy every "for each" above.
    expect(WORKLOAD_SHAPES.length).toBeGreaterThanOrEqual(15);
    expect(EXPLORATORY_SHAPES.length).toBeGreaterThanOrEqual(5);
  });

  it('gives every shape a unique id', () => {
    const ids = [...WORKLOAD_SHAPES, ...EXPLORATORY_SHAPES].map((shape) => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a REAL exported reader for every shipped shape', () => {
    // The fidelity guarantee is that a shape calls the function production
    // calls. `run` already holds a direct reference, so what can rot is the
    // `reader` STRING the report prints — and a report citing a function that
    // no longer exists is worse than one citing none.
    for (const shape of WORKLOAD_SHAPES) {
      const [relativePath, exportName] = shape.reader.split('::');
      expect(relativePath, `${shape.id} has a malformed reader string`).toBeDefined();
      expect(exportName, `${shape.id} names no export`).toBeDefined();
      const source = readFileSync(join(SRC_ROOT, relativePath ?? ''), 'utf8');
      expect(source.length, `${shape.id}: ${relativePath ?? ''} looks empty — did it move?`)
        .toBeGreaterThan(200);
      expect(
        source.includes(`export async function ${exportName ?? ''}(`) ||
          source.includes(`export function ${exportName ?? ''}(`),
        `${shape.id}: ${relativePath ?? ''} does not export ${exportName ?? ''}`,
      ).toBe(true);
    }
  });

  it('the reader check actually detects — the mutation self-test', () => {
    // A grep that matched nothing would pass the loop above vacuously, so run
    // the same predicate against a file that definitely does not export it.
    const source = readFileSync(join(SRC_ROOT, 'db/offers/offerRepository.ts'), 'utf8');
    expect(source.includes('export async function listOffersForComparison(')).toBe(true);
    expect(source.includes('export async function definitelyNotAReader(')).toBe(false);
  });

  it('every exploratory shape states its provenance and names an owning issue', () => {
    // An exploratory number is only safe to publish beside a sentence saying
    // what it is NOT — otherwise it reads as a production latency. The issue
    // reference is what turns "nobody runs this" into "#84 will".
    for (const shape of EXPLORATORY_SHAPES) {
      expect(shape.provenance.length, `${shape.id} has no explanation`).toBeGreaterThan(40);
      expect(shape.provenance, `${shape.id} does not name an owning issue`).toMatch(/#\d+/);
    }
  });

  it('every shape declares a row floor', () => {
    for (const shape of [...WORKLOAD_SHAPES, ...EXPLORATORY_SHAPES]) {
      expect(
        shape.expectation.minRowsReturned,
        `${shape.id} declares no minimum row count`,
      ).toBeGreaterThanOrEqual(0);
    }
    // And at least most of them demand rows: a workload where every floor was
    // quietly relaxed to zero would pass the line above and measure nothing.
    const demanding = [...WORKLOAD_SHAPES, ...EXPLORATORY_SHAPES].filter(
      (shape) => shape.expectation.minRowsReturned > 0,
    );
    expect(demanding.length).toBe(WORKLOAD_SHAPES.length + EXPLORATORY_SHAPES.length);
  });
});
