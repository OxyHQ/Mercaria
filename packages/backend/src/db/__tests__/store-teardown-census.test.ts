/**
 * No test fixture deletes a `stores` row except through `deleteTestStores`.
 *
 * ## Why this is a census and not a list
 *
 * The failure it guards is not a bug in any one file. A whole-catalogue backfill
 * pass links EVERY active store in the shared throwaway database, and
 * `native_store_links.store_id` is `ON DELETE RESTRICT`, so any fixture that
 * drops a store it owns can be refused by a row another file's fixture caused —
 * see `store-teardown.ts` for the mechanism. Which files collide changes on
 * every run, because vitest orders files by SIZE and any added line reshuffles
 * them. So the property has to hold for files nobody has written yet, which
 * rules out a hand-maintained path list: a gate that skips what is missing from
 * its own map is not a gate.
 *
 * ## Two things this deliberately does not do
 *
 * It does NOT strip comments. The failure direction of scanning raw source is a
 * false POSITIVE — a comment quoting the call fails the build loudly and is
 * corrected in one line — while comment stripping truncates at a `//` inside a
 * string literal and can hide a real call, which is the direction that costs
 * something. Probes below are therefore assembled from a table NAME rather than
 * written out, so this file cannot become the offender it is looking for.
 *
 * It scans TEST files only, not `src/` whole. Production code deletes no store
 * at all (`schema/stores.ts` says so, and that is why the link's foreign key is
 * RESTRICT). `src/scripts/seed.ts` does — it wipes the marketplace and re-seeds
 * — and it is deliberately out of scope here: it deletes every store rather than
 * an owned set, so what it owes is a decision about whether a dev seed may clear
 * the canonical linkage table, not a fixture fix.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A direct deletion of the `stores` table, newline-tolerant.
 *
 * `\s*` throughout because the house spelling puts the call and its `where` on
 * separate lines wherever the statement runs long, and a line-based scan reads
 * that as clean.
 */
const DIRECT_STORE_DELETE = /\.\s*delete\s*\(\s*stores\s*\)/u;

/**
 * The only two files allowed to issue it, relative to `src/`, in sorted order.
 *
 * The helper, because it is the statement every fixture now goes through; and
 * the helper's own realdb case, which issues the bare deletion deliberately to
 * prove the foreign key refuses it. Both are named rather than pattern-matched:
 * an exact array cannot be widened by accident, where a prefix or a directory
 * rule could quietly cover a third file nobody looked at.
 */
const PERMITTED = [
  join('db', '__tests__', 'store-teardown.realdb.test.ts'),
  join('db', '__tests__', 'store-teardown.ts'),
];

/**
 * The two files the caller floor below must not count as callers.
 *
 * The helper, because it DEFINES the function. And this file, because the
 * predicate it uses to recognise a caller is a literal string sitting in its
 * own source — so a census that counted itself would have a floor one file of
 * the way to being met by something that calls nothing, which is the same
 * self-reference the probes above are assembled to avoid.
 */
const TEARDOWN_HELPER = join('db', '__tests__', 'store-teardown.ts');
const THIS_CENSUS = join('db', '__tests__', 'store-teardown-census.test.ts');

/**
 * Every `.ts` a test run loads: anything under a `__tests__` directory (which
 * catches the shared suites that are not named `*.test.ts`, the shape
 * `connector-contract-suite.ts` established) plus any `*.test.ts` elsewhere.
 */
function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...testSources(path));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    const isUnderTests = relative(SRC_ROOT, path).split(sep).includes('__tests__');
    if (isUnderTests || entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** `{relative path → source}` for every scanned file. */
function scannedSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of testSources(SRC_ROOT)) {
    sources.set(relative(SRC_ROOT, path), readFileSync(path, 'utf8'));
  }
  return sources;
}

describe('the store teardown census', () => {
  it('finds ONLY the shared helper and its own proof deleting stores directly', () => {
    const sources = scannedSources();

    // The vacuity floor. A broken walk, a moved directory or an extension
    // filter that stopped matching all report the same clean zero as a correct
    // scan, and the offender assertion below would pass on every one of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(300);

    const offenders = [...sources]
      .filter(([, source]) => DIRECT_STORE_DELETE.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may grow is the
    // gate switching itself off one defensible entry at a time. This assertion
    // is also its own positive control — it can only pass by having FOUND the
    // two real deletions in the tree, so a scan that read nothing, or a regex
    // that matched nothing, fails here rather than reporting a tidy zero.
    expect(
      offenders,
      'a fixture deletes stores directly; route it through deleteTestStores so a canonical link minted by the backfill cannot refuse it',
    ).toEqual(PERMITTED);
  });

  it('is used by every fixture that owns stores', () => {
    const sources = scannedSources();

    // Both exclusions have to NAME a file the walk actually read. A stale path
    // — a rename, a moved directory — excludes nothing and reads exactly like a
    // correct run, leaving the floor one file easier to clear than it looks.
    expect(sources.has(TEARDOWN_HELPER), 'the helper path is stale').toBe(true);
    expect(sources.has(THIS_CENSUS), 'this census path is stale').toBe(true);

    const callers = [...sources].filter(
      ([path, source]) =>
        path !== TEARDOWN_HELPER &&
        path !== THIS_CENSUS &&
        source.includes('deleteTestStores('),
    );

    // A floor rather than an exact count, because a file that stops owning
    // stores legitimately drops off. It retires when store-owning fixtures do:
    // if this ever has to come down, the commit that lowers it must name the
    // file that stopped creating stores and why.
    expect(callers.length, 'the fixtures stopped going through the helper').toBeGreaterThanOrEqual(
      20,
    );
  });

  it('detects both spellings and nothing that merely looks like one', () => {
    // The mutation self-test. A detector that matched nothing would satisfy the
    // offender assertion above by finding zero — except that assertion demands
    // exactly one hit, so a dead regex already fails it. What this adds is the
    // half that assertion cannot cover: that the MULTI-LINE spelling is seen,
    // since the tree happens to contain only single-line ones today.
    //
    // Assembled from the table name so the literals never appear in this file,
    // which is itself scanned.
    const table = 'stores';
    const positives = [
      `await db.delete(${table}).where(eq(${table}.id, storeId));`,
      `await db\n  .delete(${table})\n  .where(inArray(${table}.id, ids));`,
      `await tx.delete( ${table} );`,
    ];
    for (const probe of positives) {
      expect(DIRECT_STORE_DELETE.test(probe), `missed: ${probe}`).toBe(true);
    }

    const negatives = [
      `await db.delete(${table}Members).where(eq(storeMembers.storeId, id));`,
      `await db.delete(${table.slice(0, 5)}fronts).where(inArray(storefronts.id, ids));`,
      `await deleteTest${table.charAt(0).toUpperCase()}${table.slice(1)}(db, [storeId]);`,
    ];
    for (const probe of negatives) {
      expect(DIRECT_STORE_DELETE.test(probe), `false positive: ${probe}`).toBe(false);
    }
  });
});
