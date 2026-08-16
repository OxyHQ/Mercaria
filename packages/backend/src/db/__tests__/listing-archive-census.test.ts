/**
 * Who may archive a listing, and what each of them does about a RESTRICTION.
 *
 * ## What this protects, and why the behavioural tests cannot
 *
 * #402: archiving was a one-way door against a moderation restriction.
 * `restoreSubject` restored only from `['restricted', 'draft']`, so a restricted
 * listing moved to `archived` could never be relisted by an accepted appeal — and
 * because `updateListing`'s escape guard reads the listing's CURRENT status, once
 * the column said `archived` there was no longer a restriction for it to refuse,
 * so the accused seller could `DELETE` and then `PATCH {status:'active'}` and put
 * the listing back on sale.
 *
 * Both halves are now pinned by `moderation-decision.realdb.test.ts`, which drives
 * the real decision pipeline and the real archive paths. What a behavioural test
 * cannot cover is the writer nobody has written yet: a new module that archives a
 * listing runs in no test at all, and it would rebuild exactly this dead end while
 * every existing assertion stayed green.
 *
 * So the durable half is a census, and it fails on a fifth archiver until somebody
 * states what it does about `restricted`. A gate that skips what is missing from
 * its own map is not a gate, so being in neither the map nor a stated exception
 * FAILS — the `listing-publication-chokepoint.test.ts` convention, one column over.
 *
 * ## It deliberately over-matches
 *
 * The probe finds a file that both calls a listing-status writer AND names
 * `'archived'`, rather than trying to parse which argument reached which
 * parameter. A file that merely COMPARES against `'archived'` beside an unrelated
 * write is therefore implicated, and that is the safe direction: the cost of a
 * false positive is one line here with a reason attached, and the cost of a false
 * negative is the dead end coming back.
 *
 * It does NOT strip comments, following the publication chokepoint: scanning raw
 * source fails toward a false positive, while comment stripping truncates at a
 * `//` inside a string literal and can hide a real call. The probe is assembled
 * from its parts rather than written out, so this file cannot become the offender
 * it looks for.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_LISTING_STATUSES,
  MERCHANT_ARCHIVABLE_LISTING_STATUSES,
  MODERATION_HELD_LISTING_STATUSES,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The status a listing is soft-deleted into, assembled from rather than quoted. */
const ARCHIVED = ['arch', 'ived'].join('');

/** The repository functions that can write `listings.status`. */
const STATUS_WRITERS = ['setListingStatusIfIn', 'updateListingColumns', 'insertListing'] as const;

/**
 * Every production file that can archive a listing, and what it does about a
 * moderation restriction.
 *
 * Named rather than pattern-matched: an exact array cannot be widened by accident,
 * where a directory rule could quietly cover a fifth file nobody looked at.
 */
const PERMITTED_ARCHIVERS: readonly { readonly path: string; readonly disposition: string }[] = [
  {
    path: join('services', 'catalog-write.service.ts'),
    disposition:
      'REFUSES a restricted listing — `archiveListing` is the seller/admin DELETE funnel and archives only from `MERCHANT_ARCHIVABLE_LISTING_STATUSES` (#402)',
  },
  {
    path: join('services', 'channels', 'channel-disconnect.service.ts'),
    disposition:
      'REFUSES a restricted listing — `POLICY_MOVABLE_STATUSES` is `[draft, active]`, so a merchant cannot disconnect a channel to get a restricted listing archived and re-imported as active',
  },
  {
    path: join('services', 'connector-sync.service.ts'),
    disposition:
      'PARTLY refuses, deliberately — the unpublish callers pass `sparePendingModeration` (#387), while the `product_delete` webhook and the post-backfill delete reconciliation still archive from any status, because a product genuinely gone upstream is gone whatever Mercaria decided. Safe only because a restore can reach an archived listing (#402)',
  },
  {
    path: join('services', 'moderation', 'enforcement.service.ts'),
    disposition:
      'the MODERATION domain itself — the only writer that may move a listing into and out of `restricted`, and whose `restore` reaches an archived listing so the carve-out above stays recoverable (#402)',
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

/** Whether `source` both names the archived status and calls a status writer. */
function canArchive(source: string, path: string): boolean {
  // The repository OWNS the writers; it is the callers this census is about.
  if (path === join('db', 'catalog', 'listingRepository.ts')) return false;
  if (!source.includes(`'${ARCHIVED}'`)) return false;
  return STATUS_WRITERS.some((writer) => source.includes(writer));
}

describe('the listing archive census', () => {
  it('finds ONLY writers whose handling of a restriction is stated', () => {
    const sources = productionSources();

    // The vacuity floor. A broken walk, a moved directory or an extension filter
    // that stopped matching all report the same clean zero as a correct scan, and
    // the identity assertion below would pass on every one of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      400,
    );

    const archivers = [...sources]
      .filter(([path, source]) => canArchive(source, path))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may only grow is the
    // gate switching itself off one defensible entry at a time. It is also its own
    // positive control — it can only pass by having FOUND the four real archivers,
    // so a probe that matched nothing fails here rather than reporting a tidy zero.
    expect(
      archivers,
      'a new module can archive a listing. Decide what it does when the listing is `restricted` — archiving one is a one-way door unless a restore can reach it (#402) — then add it here with a disposition',
    ).toEqual([...PERMITTED_ARCHIVERS].map((archiver) => archiver.path).sort());
  });

  it('names four archivers whose paths the walk actually read', () => {
    const sources = productionSources();

    // Every permitted path must NAME a file the walk read. A stale path — a
    // rename, a moved directory — permits nothing and reads exactly like a correct
    // run, which would leave the assertion above comparing two lists that agree
    // about a file neither of them found.
    for (const { path } of PERMITTED_ARCHIVERS) {
      expect(sources.has(path), `permitted archiver path is stale: ${path}`).toBe(true);
    }

    // The exact count, beside the floor the list excuses.
    expect(PERMITTED_ARCHIVERS).toHaveLength(4);
  });

  it('partitions every listing status into held-by-moderation or merchant-archivable', () => {
    /**
     * The two lists are derived from one another by subtraction, so this cannot
     * fail today — but it fails the moment somebody adds a sixth `ListingStatus`
     * and hand-edits either list instead, which is the drift
     * `ALL_LISTING_STATUSES` exists to prevent one layer down.
     */
    const held = [...MODERATION_HELD_LISTING_STATUSES];
    const archivable = [...MERCHANT_ARCHIVABLE_LISTING_STATUSES];

    expect(held.filter((status) => archivable.includes(status))).toEqual([]);
    expect([...held, ...archivable].sort()).toEqual([...ALL_LISTING_STATUSES].sort());

    // The floor: a `MODERATION_HELD_LISTING_STATUSES` that had been emptied would
    // satisfy both assertions above while permitting every archive this gate
    // exists to refuse.
    expect(held, 'a restriction must be held by SOMETHING').toContain('restricted');
  });
});
