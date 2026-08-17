/**
 * `listings.status` is written by `db/catalog/listingRepository.ts` and by two
 * named exceptions, and by nothing else.
 *
 * ## What this protects, and why a runtime test cannot
 *
 * #261 made `published_at` mean the FIRST activation, derived from the status in
 * the three statements that can write it — the create, the patch and the CAS. The
 * derivation holds for every caller precisely because there is no fourth
 * statement: `listing-publication.realdb.test.ts` drives all three, and a writer
 * nobody has written yet runs in no test at all. So the durable half of the
 * property is a census, and its failure mode is the interesting one — a new
 * `.update(listings).set({ status: 'active' })` somewhere else would leave
 * `published_at` NULL on a listing that is on sale, with no error, no log line
 * and every catalogue read still working (they filter on `status`). It would
 * surface as a listing missing from the tail of a newest-first feed.
 *
 * A fourth writer therefore fails THIS test until somebody decides what it does
 * with `published_at` — which is the point. A gate that skips what is missing from
 * its own map is not a gate, so every hit must be either the owner or a named
 * exception with a stated disposition; being in neither fails.
 *
 * ## Two things this deliberately does not do
 *
 * It does NOT strip comments, following `store-teardown-census.test.ts`: the
 * failure direction of scanning raw source is a false POSITIVE, corrected in one
 * line, while comment stripping truncates at a `//` inside a string literal and
 * can hide a real call. The probe is therefore assembled from a table NAME rather
 * than written out, so this file cannot become the offender it looks for.
 *
 * It scans PRODUCTION source only. Fixtures write `listings` directly all over
 * the suite and are supposed to — `catalog.realdb.test.ts` writes specific
 * `published_at` values, including NULLs, to exercise the keyset cursor's three
 * branches, which is exactly the deliberate override `insertListing` keeps
 * available.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The table whose writers are being counted, assembled from rather than quoted. */
const TABLE = 'listings';

/**
 * A drizzle write against it, newline-tolerant.
 *
 * `\s*` throughout because the house spelling puts `.update(...)` and its `.set`
 * on separate lines wherever the statement runs long, and a line-based scan reads
 * that as clean. The raw-SQL spellings are here too: `db.execute` bypasses the
 * query builder entirely, so a scan for the builder alone would report clean on
 * the one shape that also bypasses the column mappers.
 *
 * The INTERPOLATED raw spelling — `update ${listings} set …` inside a `sql`
 * template — is a fourth branch, added by #427, which wrote the first one. It is
 * the spelling this census was most blind to: the table name never appears as
 * text, so `update\s+"?listings"?\s+set` matched nothing at all and a `status`
 * write in any file would have read as clean. Its first author happened to be
 * the OWNER, so the gate's verdict was right by luck rather than by measurement,
 * which is not a state to leave a census in.
 */
const LISTING_WRITE = new RegExp(
  [
    `\\.\\s*insert\\s*\\(\\s*${TABLE}\\s*\\)`,
    `\\.\\s*update\\s*\\(\\s*${TABLE}\\s*\\)`,
    `update\\s+"?${TABLE}"?\\s+set`,
    `update\\s+\\$\\{\\s*${TABLE}\\s*\\}`,
  ].join('|'),
  'iu',
);

/**
 * Every production file that may write `listings`, and what it does about
 * `published_at`. Relative to `src/`, sorted.
 *
 * The owner derives the column from the status in all three of its statements.
 * The two exceptions are named rather than pattern-matched: an exact array cannot
 * be widened by accident, where a directory rule could quietly cover a fourth
 * file nobody looked at.
 */
const PERMITTED_WRITERS: readonly { readonly path: string; readonly disposition: string }[] = [
  {
    path: join('db', 'catalog', 'listingRepository.ts'),
    disposition:
      'the OWNER — `insertListing`, `updateListingColumns` and `setListingStatusIfIn` each derive `published_at` from the status they write, and #427’s `releasePinnedFields` writes `overridden_fields` alone, touching neither column',
  },
  {
    path: join('db', 'productSaves', 'productSaveAggregateRepository.ts'),
    disposition:
      'not applicable — rebuilds `favorite_count` from `favorites` and writes neither `status` nor `published_at`',
  },
  {
    path: join('services', 'graph-benchmark', 'dataset.ts'),
    disposition:
      'not applicable — the opt-in benchmark seed (`GRAPH_BENCHMARK=1` plus a `bench` database, which it TRUNCATES) states `status` and `published_at` together on purpose, so its rows carry the distribution the measured plans need',
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

describe('the listings write census', () => {
  it('finds ONLY the repository and its two named exceptions writing `listings`', () => {
    const sources = productionSources();

    // The vacuity floor. A broken walk, a moved directory or an extension filter
    // that stopped matching all report the same clean zero as a correct scan, and
    // the offender assertion below would pass on every one of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      400,
    );

    const writers = [...sources]
      .filter(([, source]) => LISTING_WRITE.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may only grow is the
    // gate switching itself off one defensible entry at a time. It is also its own
    // positive control — it can only pass by having FOUND the three real writers,
    // so a scan that read nothing, or a probe that matched nothing, fails here
    // instead of reporting a tidy zero.
    expect(
      writers,
      'a new module writes `listings` directly. If it can set `status`, `published_at` is now its problem too — route it through listingRepository, or add it here with a disposition (#261)',
    ).toEqual([...PERMITTED_WRITERS].map((writer) => writer.path).sort());
  });

  it('names three writers whose paths the walk actually read', () => {
    const sources = productionSources();

    // Every permitted path must NAME a file the walk read. A stale path — a
    // rename, a moved directory — permits nothing and reads exactly like a correct
    // run, which would leave the assertion above comparing two lists that agree
    // about a file neither of them found.
    for (const { path } of PERMITTED_WRITERS) {
      expect(sources.has(path), `permitted writer path is stale: ${path}`).toBe(true);
    }

    // The exact count, beside the floor the list excuses. A list that only ever
    // grows is the same erosion as a decremented floor in a different shape, so
    // adding a fourth entry has to be a deliberate edit here as well as there.
    expect(PERMITTED_WRITERS).toHaveLength(3);
  });

  it('finds all four of the owner’s write statements', () => {
    const owner = productionSources().get(join('db', 'catalog', 'listingRepository.ts'));
    expect(owner, 'the owner path is stale').toBeDefined();

    // The floor on what was FOUND, not on what was absent. Without it, a probe
    // that had stopped matching the builder spelling would make the census above
    // pass by finding nothing anywhere — including in the file that certainly does
    // write this table.
    //
    // FOUR since #427, and the fourth is what makes the interpolated branch a
    // measured thing rather than a hopeful one: `releasePinnedFields` is the only
    // `update ${listings}` in the tree, so deleting that branch from the pattern
    // drops this count to three and fails HERE, naming it.
    const statements = owner.match(new RegExp(LISTING_WRITE.source, 'giu')) ?? [];
    expect(
      statements.length,
      'the owner should carry the insert, the column patch, the status CAS and the pin release',
    ).toBeGreaterThanOrEqual(4);
  });

  it('matches the interpolated raw spelling that the table-name branch cannot see', () => {
    // The detector self-test, against text held in memory. The two halves are the
    // point: the interpolated form is CAUGHT, and the branch that reads a literal
    // table name genuinely does not catch it — so this is a fourth branch rather
    // than a second spelling of an existing one.
    const interpolated = 'update ${listings}\n    set overridden_fields = 1';
    expect(LISTING_WRITE.test(interpolated)).toBe(true);
    expect(new RegExp(`update\\s+"?${TABLE}"?\\s+set`, 'iu').test(interpolated)).toBe(false);
    expect(LISTING_WRITE.test('select ${listings.id} from ${listings}')).toBe(false);
  });
});
