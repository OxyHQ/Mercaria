/**
 * `categories` and its three satellite tables are written by
 * `db/taxonomy/taxonomyRepository.ts` and by two named exceptions, and by
 * nothing else.
 *
 * ## What this protects, and why a runtime test cannot
 *
 * ADR 0007 D2 gives the taxonomy three properties the DATABASE does not hold,
 * because each is a derivation rather than a constraint:
 *
 *  - `is_active` is `lifecycle = 'published'`. The cross-column CHECK that would
 *    state it at the row breaks a write the previously serving image performs,
 *    so it is a `post`-phase statement named in `0087`'s header and not yet
 *    applied.
 *  - `ancestor_ids` is the parent's own array plus the parent.
 *  - `ancestor_slugs` is the same path spelled in slugs, and is the v1 read
 *    contract five services still filter on (D13).
 *
 * A second writer therefore does not FAIL. It writes a row that looks entirely
 * ordinary, and the disagreement surfaces months later as a category that is
 * live and invisible, or a subtree that no `descendants of X` read returns. A
 * writer nobody has written yet also runs in no test at all, so the durable half
 * of the property is a census.
 *
 * The three invariants the database DOES hold need no entry here, and are worth
 * naming so the next reader does not add a redundant gate for them: `key` is
 * frozen by `mercaria_category_key_frozen`; cycles, self-parenting, merging into
 * oneself and merging into a descendant are refused by two CHECKs and
 * `mercaria_category_hierarchy_guard`; and a non-selectable node cannot take a
 * product assignment because of `mercaria_category_assignment_selectable`.
 * `taxonomy.realdb.test.ts` drives all of those against a real server.
 *
 * ## Two things this deliberately does not do
 *
 * It does NOT strip comments, following `listing-publication-chokepoint.test.ts`
 * and `store-teardown-census.test.ts`: the failure direction of scanning raw
 * source is a false POSITIVE, corrected in one line, while comment stripping
 * truncates at a `//` inside a string literal and can hide a real call. The
 * probe is assembled from table NAMES rather than written out, so this file
 * cannot become the offender it looks for.
 *
 * It scans PRODUCTION source only. Fixtures write `categories` directly all over
 * the suite and are supposed to — several of them need a category whose slug,
 * ancestry or lifecycle is deliberately unusual.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tables whose writers are being counted, assembled from rather than quoted. */
const TABLES = [
  'categories',
  'category_aliases',
  'category_redirects',
  'category_external_mappings',
] as const;

/**
 * A drizzle or raw write against any of them.
 *
 * `\s*` throughout because the house spelling puts `.update(...)` and its `.set`
 * on separate lines wherever the statement runs long, and a line-based scan
 * reads that as clean. The raw-SQL spellings are here too: `db.execute` bypasses
 * the query builder entirely, so a scan for the builder alone would report clean
 * on the one shape that also bypasses the column mappers.
 *
 * The TypeScript identifiers are the camelCase forms, because that is what a
 * call site names; the raw spellings are the snake_case SQL names.
 */
const TAXONOMY_WRITE = new RegExp(
  TABLES.flatMap((table) => {
    const identifier = table.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase());
    return [
      `\\.\\s*insert\\s*\\(\\s*${identifier}\\s*\\)`,
      `\\.\\s*update\\s*\\(\\s*${identifier}\\s*\\)`,
      `\\.\\s*delete\\s*\\(\\s*${identifier}\\s*\\)`,
      `insert\\s+into\\s+"?${table}"?`,
      `update\\s+"?${table}"?\\s+(?:as\\s+\\w+\\s+)?set`,
      `delete\\s+from\\s+"?${table}"?`,
    ];
  }).join('|'),
  'iu',
);

/**
 * Every production file that may write the taxonomy, and what it does about the
 * three derivations. Relative to `src/`, sorted.
 *
 * Named rather than pattern-matched: an exact array cannot be widened by
 * accident, where a directory rule could quietly cover a second file nobody
 * looked at.
 */
const PERMITTED_WRITERS: readonly { readonly path: string; readonly disposition: string }[] = [
  {
    path: join('db', 'taxonomy', 'taxonomyRepository.ts'),
    disposition:
      'the OWNER — `insertCategory` derives both ancestry arrays from the parent and `is_active` from the lifecycle, `moveCategory` and `updateCategoryPresentation` rewrite the subtree, and `setCategoryLifecycle`/`mergeCategory` keep `is_active` in step',
  },
  {
    path: join('scripts', 'seed.ts'),
    disposition:
      'not applicable — the DEV seed, whose only statement against these tables is `clearMarketplace`’s unqualified DELETE. It creates categories through `insertCategory`, so the derivations hold for every row it writes; a delete has none to get wrong',
  },
  {
    path: join('services', 'graph-benchmark', 'dataset.ts'),
    disposition:
      'not applicable — the opt-in benchmark seed (`GRAPH_BENCHMARK=1` plus a `bench` database, which it TRUNCATES) bulk-inserts a synthetic tree whose shape the measured plans depend on, and its rows are never read by a lifecycle- or ancestry-sensitive path',
  },
];

/** `{relative path → source}` for every production `.ts` under `src/`. */
function productionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const rel = relative(SRC_ROOT, path);
      if (rel.split(sep).includes('__tests__')) continue;
      sources.set(rel, readFileSync(path, 'utf8'));
    }
  };
  walk(SRC_ROOT);
  return sources;
}

describe('the taxonomy write census', () => {
  it('finds ONLY the repository and its two named exceptions writing the taxonomy', () => {
    const sources = productionSources();

    // The vacuity floor. A broken walk, a moved directory or an extension filter
    // that stopped matching all report the same clean zero as a correct scan, and
    // the assertion below would pass on every one of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      400,
    );

    const writers = [...sources]
      .filter(([, source]) => TAXONOMY_WRITE.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may only grow is the
    // gate switching itself off one defensible entry at a time. It is also its
    // own positive control — it can only pass by having FOUND the real writers,
    // so a scan that read nothing, or a probe that matched nothing, fails here
    // instead of reporting a tidy zero.
    expect(
      writers,
      'a new module writes the taxonomy directly. `is_active`, `ancestor_ids` and `ancestor_slugs` are DERIVED with no database-side counterpart, so a second writer disagrees silently — route it through db/taxonomy/taxonomyRepository.ts, or add it here with a disposition (ADR 0007 D2)',
    ).toEqual([...PERMITTED_WRITERS].map((writer) => writer.path).sort());
  });

  it('names writers whose paths the walk actually read', () => {
    const sources = productionSources();

    // Every permitted path must NAME a file the walk read. A stale path — a
    // rename, a moved directory — permits nothing and reads exactly like a
    // correct run, which would leave the assertion above comparing two lists
    // that agree about a file neither of them found.
    for (const { path } of PERMITTED_WRITERS) {
      expect(sources.has(path), `permitted writer path is stale: ${path}`).toBe(true);
    }

    // The exact count, beside the floor the list excuses. A list that only ever
    // grows is the same erosion as a decremented floor in a different shape.
    expect(PERMITTED_WRITERS).toHaveLength(3);
  });

  it('finds every one of the owner’s write statements', () => {
    const owner = productionSources().get(join('db', 'taxonomy', 'taxonomyRepository.ts'));
    expect(owner, 'the owner path is stale').toBeDefined();

    // The floor on what was FOUND, not on what was absent. Without it, a probe
    // that had stopped matching the builder spelling would make the census above
    // pass by finding nothing anywhere — including in the file that certainly
    // does write these tables.
    //
    // Seven: the category insert, the presentation patch, the move, the
    // lifecycle set, the merge, the alias insert and delete, the redirect
    // insert, and the mapping's close and open.
    const statements = owner.match(new RegExp(TAXONOMY_WRITE.source, 'giu')) ?? [];
    expect(
      statements.length,
      'the owner should carry every taxonomy write statement',
    ).toBeGreaterThanOrEqual(7);
  });

  it('has a probe that matches the shapes it claims to, and not the rest', () => {
    // The mutation self-test. Each of these is a real spelling a second writer
    // could take, and a probe that had lost one would go on reporting clean.
    for (const positive of [
      'await db.insert(categories).values({});',
      'await tx\n  .update(categoryRedirects)\n  .set({ reason: "merged" });',
      'await db.delete(categoryAliases).where(eq(categoryAliases.id, id));',
      'await db.execute(sql`update categories as d set ancestor_slugs = x`);',
      'await db.execute(sql`insert into category_external_mappings (id) values (1)`);',
      'await db.execute(sql`delete from category_redirects where id = $1`);',
    ]) {
      expect(TAXONOMY_WRITE.test(positive), `probe missed: ${positive}`).toBe(true);
    }

    // The negative controls. A probe that matched a plain READ would name every
    // consumer of the taxonomy and the allow-list would have to hold them all,
    // which is the gate eroding into a directory listing.
    for (const negative of [
      'const rows = await db.select().from(categories);',
      'const [row] = await db.select().from(categoryAliases).where(eq(x, y));',
      'import { categories } from "../schema/catalog.js";',
      'await db.insert(listings).values({ categoryId });',
    ]) {
      expect(TAXONOMY_WRITE.test(negative), `probe over-matched: ${negative}`).toBe(false);
    }
  });
});
