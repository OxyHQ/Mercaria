/**
 * Every ordering behind a CACHEABLE catalog read is total (#367 Workstream 1,
 * "Add ETags/cache keys and deterministic ordering").
 *
 * ## The two halves of that checkbox are ONE property
 *
 * An ETag here is a hash of the composed payload. A payload composed from rows
 * the database returned in an arbitrary order is a payload that can serialize
 * two ways for identical data — so the validator flips between two values, every
 * revalidation misses, and every client re-downloads the whole tree. That is
 * `services/navigation/etag.ts`'s own stated failure ("a cache that has stopped
 * working while reporting success") arriving through the ordering rather than
 * through the hash. Deterministic ordering is not a second, tidier requirement
 * beside the ETag; it is what makes the ETag mean anything.
 *
 * It also fails in the ordinary paginated way — a page repeating one row and
 * dropping another — but that half at least has a chance of being noticed.
 *
 * ## The population is DERIVED, twice over
 *
 * The entry points are not a list of route files somebody kept up to date. They
 * are the route modules of the catalog surfaces that serve a validator, and the
 * repositories are everything under `db/` in their IMPORT CLOSURE. So a new read
 * added to one of these surfaces is inside this gate on the commit that adds it,
 * and a repository that stops being reachable leaves without an edit here.
 *
 * ## Totality is read from the SCHEMA, never from the clause
 *
 * This is the part a text survey of `ORDER BY` clauses cannot do, and the reason
 * this gate exists rather than a review checklist. `ORDER BY created_at DESC`
 * reads as perfectly well-formed and is non-deterministic the moment two rows
 * share a timestamp — which, for every `created_at` in this schema, is every row
 * a bulk insert writes, because the default is `now()` and `now()` is the
 * TRANSACTION timestamp. Whether an ordering is total lives in the table's
 * constraints, so that is where `orderingIsTotal` looks.
 *
 * ## An unresolved site FAILS
 *
 * `~/Oxy/AGENTS.md`: a gate that SKIPS what a hand-maintained map omits is not a
 * gate. A `.orderBy()` this census cannot parse, or one naming a table it cannot
 * resolve, is a FAILURE — never a quiet exclusion. The shape that keeps being
 * found in this repository is an analyzer that resolves six of nine sites and
 * reports "all total".
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgTable } from 'drizzle-orm/pg-core';
import { importSpecifiersOf } from '../../__tests__/route-reachability/analyze.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';
import * as schema from '../schema/index.js';
import { orderingIsTotal, orderingSitesIn, type OrderingSite } from './ordering-census.js';
import { ORDERING_DISPOSITIONS, orderingDispositionKey } from './ordering-dispositions.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The catalog surfaces that serve a cache validator.
 *
 * Route modules rather than controllers, so the closure includes the middleware
 * and schemas a read actually runs through. These three are the surfaces whose
 * controllers set an `ETag`; `routes/categories.ts` is deliberately absent — it
 * serves the v1 tree, carries no validator, and is covered by the disposition
 * census in `catalog-read-cacheability.test.ts` instead.
 */
const CACHEABLE_SURFACES = ['routes/taxonomy.ts', 'routes/navigation.ts'] as const;

function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every first-party module reachable from `entries` by relative import. */
function importClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importSpecifiersOf(file)) {
      const resolved = resolveRelative(specifier, file);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

/** The drizzle table a local identifier refers to, or `undefined`. */
function tableFor(localName: string): PgTable | undefined {
  const candidate = (schema as Record<string, unknown>)[localName];
  return candidate === undefined ? undefined : (candidate as PgTable);
}

interface CensusEntry {
  readonly key: string;
  readonly site: OrderingSite;
  readonly relative: string;
}

function census(): { entries: CensusEntry[]; files: string[]; dbFiles: string[] } {
  const entryFiles = CACHEABLE_SURFACES.map((surface) => join(SRC_ROOT, surface));
  for (const file of entryFiles) {
    expect(existsSync(file), `${relative(SRC_ROOT, file)} exists`).toBe(true);
  }
  const closure = importClosure(entryFiles);
  const dbFiles = closure.filter((file) => relative(SRC_ROOT, file).startsWith(`db${'/'}`));
  const entries: CensusEntry[] = [];
  for (const file of dbFiles) {
    const rel = relative(SRC_ROOT, file);
    for (const site of orderingSitesIn(file)) {
      entries.push({ key: orderingDispositionKey(rel, site.enclosing), site, relative: rel });
    }
  }
  return { entries, files: closure, dbFiles };
}

describe('the census reaches what it claims to reach', () => {
  const { entries, files, dbFiles } = census();

  // Three independent floors. The closure could collapse (a resolver that
  // stopped resolving), the db slice could collapse (a path prefix that stopped
  // matching), or the parse could collapse (an AST walk that stopped matching
  // `.orderBy`) — and each failure presents as "nothing to report", which is
  // indistinguishable from "everything is fine". Measured at the time of
  // writing: 124 modules, 93 under db/, 10 ordering sites.
  it('reaches the module closure of every cacheable surface', () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
  });

  it('reaches the repositories inside that closure', () => {
    expect(dbFiles.length).toBeGreaterThanOrEqual(75);
  });

  it('finds the ordering sites inside those repositories', () => {
    expect(entries.length).toBeGreaterThanOrEqual(9);
  });

  it('reaches the taxonomy repository specifically, which is the surface this epic line is about', () => {
    // A named anchor beside the counts. A closure that silently stopped
    // following one edge still clears three floors while having lost the one
    // file the checkbox is about.
    const taxonomy = entries.filter((entry) =>
      entry.relative.endsWith('db/taxonomy/taxonomyRepository.ts'),
    );
    expect(taxonomy.map((entry) => entry.site.enclosing).sort()).toEqual([
      'findCategoriesByNameMatch',
      'findCategoryDescendants',
      'findChildCategories',
      'findRootCategories',
    ]);
  });
});

describe('every ordering behind a cacheable catalog read is total', () => {
  const { entries } = census();

  it('parses every ordering site — an unreadable one is a failure, not a skip', () => {
    const unreadable = entries
      .filter((entry) => entry.site.terms === null)
      .map((entry) => `${entry.relative}:${entry.site.line} (${entry.site.enclosing}) — ${entry.site.text}`);
    expect(
      unreadable,
      'this census could not read these `.orderBy(...)` calls, so it cannot say whether they ' +
        'are deterministic. Either express the ordering as `asc(table.column)` terms, or give ' +
        'it a disposition in ordering-dispositions.ts saying why it cannot be one.',
    ).toEqual([]);
  });

  it('resolves every ordering to a real drizzle table', () => {
    const unresolved: string[] = [];
    for (const entry of entries) {
      for (const term of entry.site.terms ?? []) {
        if (tableFor(term.table) === undefined) {
          unresolved.push(`${entry.relative}:${entry.site.line} — no schema export \`${term.table}\``);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('finds no ordering that can tie, except the ones explicitly dispositioned', () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      const terms = entry.site.terms;
      if (terms === null || terms.length === 0) continue;
      const table = tableFor(terms[0]?.table ?? '');
      if (table === undefined) continue;
      // Every term must name the same table for the coverage argument to hold;
      // a join ordering across two tables is dispositioned rather than guessed at.
      if (terms.some((term) => term.table !== terms[0]?.table)) {
        if (ORDERING_DISPOSITIONS[entry.key] === undefined) {
          offenders.push(`${entry.key} — orders across more than one table and has no disposition`);
        }
        continue;
      }
      const verdict = orderingIsTotal(
        table,
        terms.map((term) => term.property),
      );
      if (verdict.total) continue;
      if (ORDERING_DISPOSITIONS[entry.key] !== undefined) continue;
      offenders.push(
        `${entry.key} (line ${entry.site.line}) orders by ` +
          `${terms.map((term) => term.property).join(', ')} — ${verdict.because}`,
      );
    }
    expect(
      offenders,
      'these orderings can return two rows in either order. Behind a hashed ETag that makes the ' +
        'validator unstable and every revalidation miss; behind a page it repeats one row and ' +
        'drops another. Add a tie-break that completes a NON-PARTIAL unique, or record a ' +
        'disposition in ordering-dispositions.ts.',
    ).toEqual([]);
  });
});

describe('the disposition list shrinks, and cannot hide a regression', () => {
  const { entries } = census();
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  it('every disposition names a site that still exists', () => {
    // A disposition for a function that was renamed or deleted is a stale
    // excuse, and it would silently cover nothing while reading as a decision.
    const orphans = Object.keys(ORDERING_DISPOSITIONS).filter((key) => !byKey.has(key));
    expect(orphans, 'these dispositions name orderings that no longer exist').toEqual([]);
  });

  it('every disposition names a site that is still NOT total', () => {
    // The `ROUTE_DISPOSITIONS` device: an entry whose subject has since been
    // fixed must be REMOVED in the same change that fixed it, so the list can
    // only shrink and a stale excuse cannot sit behind a solved problem.
    const solved: string[] = [];
    for (const key of Object.keys(ORDERING_DISPOSITIONS)) {
      const entry = byKey.get(key);
      const terms = entry?.site.terms;
      if (!entry || !terms || terms.length === 0) continue;
      const table = tableFor(terms[0]?.table ?? '');
      if (table === undefined) continue;
      if (terms.some((term) => term.table !== terms[0]?.table)) continue;
      if (
        orderingIsTotal(
          table,
          terms.map((term) => term.property),
        ).total
      ) {
        solved.push(key);
      }
    }
    expect(
      solved,
      'these orderings are now total by coverage, so their dispositions are obsolete — delete them',
    ).toEqual([]);
  });

  it('the list is asserted EXACTLY, so a new excuse is a visible decision', () => {
    // A ceiling would let the list grow one defensible line at a time, which is
    // the gate switching itself off. Today: exactly one.
    expect(Object.keys(ORDERING_DISPOSITIONS).sort()).toEqual([
      'db/navigation/navigationRepository.ts#findLiveNavigationTrees',
    ]);
  });

  it('every disposition carries a reason somebody can check', () => {
    assertEachOf(Object.entries(ORDERING_DISPOSITIONS), 1, ([key, disposition]) => {
      expect(disposition.reason.length, `${key} states a reason`).toBeGreaterThan(80);
      expect(disposition.pinnedByEquality.length, `${key} names what pins it`).toBeGreaterThan(0);
    });
  });
});
