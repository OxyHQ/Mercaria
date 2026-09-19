/**
 * THE CENSUS over the measured/claimed line (#1015 Workstream 3, ADR 0010 D12).
 *
 * `THREE_D_MEASURED_FACTS` is a claim about another table: that `triangle_count`
 * is answered by `asset_file_inspections.triangle_count` and that no seller can
 * type one. A registry making that claim with nothing reading the table is the
 * hand-maintained map `catalog-table-ownership-census.test.ts` was written
 * against — it does not go wrong by saying something false, it goes QUIET. A
 * column renamed by the inspection workstream would leave this registry
 * describing a column that no longer exists, and every product page rendering a
 * blank where a measurement was.
 *
 * So the population is DERIVED from the real drizzle table rather than from a
 * list beside the registry, and it is checked in both directions:
 *
 * - every column the registry NAMES exists on `assetFileInspections`;
 * - every column that EXISTS is classified — named by a measured fact, or listed
 *   in {@link NOT_A_BUYER_FACT} with a reason. A new measurement column fails
 *   the build until somebody decides which, which is `merge-plan-census`'s device
 *   and the reason it forces the decision at the moment the column is added, by
 *   the person adding it.
 *
 * ## What a census can and cannot prove
 *
 * It proves a column was CLASSIFIED. It cannot prove the classification is TRUE —
 * no gate can read a column name and know a product page renders it with its
 * processor beside it. What it can prove, and does, is that the two POPULATIONS
 * are disjoint: no claim attribute names a measured fact, under the registry's own
 * spelling or under the column's.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';

import {
  THREE_D_CLAIM_ATTRIBUTE_KEYS,
  THREE_D_MEASURED_FACTS,
  THREE_D_MEASURED_FACT_ORIGINS,
  threeDFactProvenance,
} from '@mercaria/shared-types';

import { assetFileInspections } from '../../../../db/schema/digitalAssets.js';
import { THREE_D_PROFILE_PACKAGE } from '../package.js';

/**
 * Columns of `asset_file_inspections` that are not a fact a BUYER reads, each
 * with the reason — the `NOT_IN_THE_MAP` device.
 *
 * An entry here is a decision the census accepts; silence is not. Every one must
 * be a real column, so a stale exemption fails just as loudly as a missing
 * classification.
 */
const NOT_A_BUYER_FACT: Readonly<Record<string, string>> = {
  id: 'the row identity',
  fileId: 'the subject, not a fact about it',
  measuredAt: 'when the measurement ran — attribution of the row rather than a property of the model',
  createdAt: 'the row clock',
  failureDetail:
    "why a verdict failed, for the CREATOR's own screen. A buyer reads the verdict; the stack behind it is not a product fact and publishing one would leak what a parser choked on",
};

/** The columns a measured fact names, flattened. */
const NAMED_COLUMNS = new Set<string>(
  Object.values(THREE_D_MEASURED_FACT_ORIGINS).flatMap((origin) =>
    origin.kind === 'file_census' ? [] : [...origin.columns],
  ),
);

/** The real columns, read off the drizzle table. */
const REAL_COLUMNS = Object.keys(getTableColumns(assetFileInspections));

/** The classifier, as a function so a control can drive it over invented columns. */
function unclassified(columns: readonly string[]): string[] {
  return columns.filter((column) => !NAMED_COLUMNS.has(column) && !(column in NOT_A_BUYER_FACT));
}

describe('the measured-fact registry describes the real inspection table', () => {
  it('has a table to measure', () => {
    // The floor: a broken import would make every check below vacuously green.
    expect(REAL_COLUMNS.length).toBeGreaterThanOrEqual(15);
    expect(REAL_COLUMNS).toContain('triangleCount');
    expect(THREE_D_MEASURED_FACTS.length).toBeGreaterThanOrEqual(17);
  });

  it('names only columns that exist', () => {
    const real = new Set(REAL_COLUMNS);
    const missing = [...NAMED_COLUMNS].filter((column) => !real.has(column));
    expect(missing).toEqual([]);
  });

  it('classifies every column that exists', () => {
    expect(unclassified(REAL_COLUMNS)).toEqual([]);
  });

  it('is a real test — a new measurement column fails until it is classified', () => {
    // The mutation. Without it this block passes against a classifier that
    // returns `[]` for everything, which is what an accidental `.filter(() =>
    // false)` would be — and a census that can only answer "clean" is worse than
    // none, because a green run looks like coverage.
    expect(unclassified([...REAL_COLUMNS, 'minimumWallThicknessUm'])).toEqual([
      'minimumWallThicknessUm',
    ]);
  });

  it('carries no stale exemption', () => {
    const real = new Set(REAL_COLUMNS);
    const dead = Object.keys(NOT_A_BUYER_FACT).filter((column) => !real.has(column));
    expect(dead).toEqual([]);
    // And no column is answered twice: an exemption beside a classification is
    // two answers to one question, which is the defect rather than the fix.
    const both = Object.keys(NOT_A_BUYER_FACT).filter((column) => NAMED_COLUMNS.has(column));
    expect(both).toEqual([]);
  });

  it('gives every fact an origin, and every inspection origin a real column', () => {
    for (const fact of THREE_D_MEASURED_FACTS) {
      const origin = THREE_D_MEASURED_FACT_ORIGINS[fact];
      expect(origin, fact).toBeDefined();
      if (origin.kind === 'file_census') {
        expect(origin.census.length, fact).toBeGreaterThan(0);
        continue;
      }
      expect(origin.columns.length, fact).toBeGreaterThan(0);
    }
    // The bounding box is three columns or it is nothing —
    // `asset_file_inspections_bbox_check` says the same thing one layer down, and
    // a registry naming two of the three would describe a measurement no product
    // page can render.
    const bbox = THREE_D_MEASURED_FACT_ORIGINS.bounding_box_mm;
    expect(bbox.kind).toBe('inspection_column');
    expect(bbox.kind === 'file_census' ? [] : bbox.columns).toHaveLength(3);
  });
});

describe('the two provenances cannot be confused', () => {
  it('answers `measured` or `seller_claimed` and never guesses', () => {
    for (const fact of THREE_D_MEASURED_FACTS) expect(threeDFactProvenance(fact), fact).toBe('measured');
    for (const key of THREE_D_CLAIM_ATTRIBUTE_KEYS) {
      expect(threeDFactProvenance(key), key).toBe('seller_claimed');
    }
    // `undefined` is a real answer. Defaulting an unknown key to
    // `seller_claimed` would make a typo render as something a seller said.
    expect(threeDFactProvenance('triangle_counts')).toBeUndefined();
    expect(threeDFactProvenance('')).toBeUndefined();
  });

  it('declares no seller attribute whose key is an inspection COLUMN, snake-cased', () => {
    // The same disjointness the pure suite asserts over the registry's own fact
    // names, keyed instead on the COLUMN names — because the spelling a seller
    // would reach for is as likely to be the column's (`has_uv_mapping`) as the
    // registry's (`uv_mapped`).
    const snake = new Set(
      REAL_COLUMNS.map((column) => column.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()),
    );
    expect(snake.has('has_uv_mapping')).toBe(true);
    const declared = THREE_D_PROFILE_PACKAGE.attributes.map((attribute) => attribute.key);
    expect(declared.filter((key) => snake.has(key))).toEqual([]);
  });
});
