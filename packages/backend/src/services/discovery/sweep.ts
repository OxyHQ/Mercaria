/**
 * The discovery sweep — the counting passes that populate `discovery_signals`
 * (`schema/discovery.ts`'s own docblock owns the WHY; this owns the HOW).
 *
 * ## The lease, `analytics/rollup.ts`'s shape
 *
 * Leased per RUN on `discovery_sweep_cursors`, an upsert whose conflict branch
 * takes the lease only when it is free or expired
 * (`discoverySignalRepository.ts`'s `claimDiscoverySweepRun`). Unlike the
 * analytics rollup there is no day to advance: the window is ROLLING, so every
 * run recomputes the whole of it. A failed run therefore has nothing to
 * resume — the lease is released, `lastError` is stamped, and the next tick
 * starts over rather than replaying a partial day. A lost lease costs a
 * duplicate computation and nothing else: the sweep moves no money and no
 * state.
 *
 * ## One row per ANCESTOR, read off `categories.ancestor_ids`
 *
 * A listing's OWN scopes are its leaf category, every ancestor of it, and the
 * root (`''`). `categories.ancestor_ids` (root-first, excluding the row
 * itself) is already the taxonomy's authority for that chain — written by the
 * one taxonomy chokepoint from the parent's own arrays — so this file reads it
 * rather than re-walking `parent_id` in memory. Re-deriving the walk here
 * would be a second implementation of a tree traversal the taxonomy write side
 * already owns, and the two could only ever agree by construction or by luck.
 *
 * ## Every write is deduplicated before `replaceWindow`
 *
 * `replaceWindow`'s target is `(subject_type, subject_id, category_id,
 * window)`, and two different things can produce the same key:
 *
 *  - the sales pass and the views pass counting the SAME listing into the
 *    SAME scope (a listing can be selected for a scope by units sold, by view
 *    count, or both) — solved by keeping exactly one candidate per
 *    `(scope, listingId)` in a `Map`, carrying both counts together, rather
 *    than two independent lists that get concatenated;
 *  - several listings of the SAME store landing in the SAME scope — a store
 *    subject is one row per scope, not one per contributing listing, so their
 *    counts are SUMMED into one aggregate per `(scope, storeId)` rather than
 *    each becoming its own row.
 *
 * Both are `Map`s keyed on the unique-index columns, so a duplicate can only
 * ever overwrite the same key rather than append a second row for it.
 *
 * ## The status filter here is an OPTIMISATION, not a defence
 *
 * A listing is skipped from counting when it is not `active` AT SWEEP TIME.
 * This is never the thing that keeps a restricted or archived listing off a
 * shelf — `discoveryReadRepository.ts` joins `listings` and filters
 * `status = 'active'` on every read, and THAT is the authority, because status
 * is mutable and this sweep's count is a snapshot: a listing active when it
 * sold can be put under a moderation hold a week later, long after this row
 * was written. Filtering here exists only so a listing already known to be
 * off-shelf at counting time does not occupy one of the `topNPerCategory`
 * slots a currently-active listing could use instead.
 */

import { randomUUID } from 'node:crypto';
import { DISCOVERY_WINDOWS } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { findActiveCategories, type CategoryRecord } from '../../db/catalog/categoryRepository.js';
import { findListingsByIds } from '../../db/catalog/listingRepository.js';
import {
  countListingSales,
  countListingViews,
} from '../../db/discovery/discoveryCountRepository.js';
import {
  claimDiscoverySweepRun,
  completeDiscoverySweepRun,
  replaceWindow,
  type DiscoverySignalInput,
} from '../../db/discovery/discoverySignalRepository.js';

/** The single sweep job name — one row in `discovery_sweep_cursors`. */
export const DISCOVERY_SWEEP_JOB = 'discovery:signals';

/** The one counting window this sweep writes. See `DISCOVERY_WINDOWS`. */
const WINDOW = DISCOVERY_WINDOWS[0];

/** One counted listing, carrying enough to be scoped and rolled up. */
interface CountedListing {
  listingId: string;
  storeId: string | null;
  unitsSold: number;
  orderCount: number;
  viewCount: number;
}

/**
 * Every scope a listing's own category places it in: the category itself,
 * every one of its ancestors, and the root. `''` is unconditional — every
 * counted subject belongs to the root scope whether or not it has a category
 * at all.
 */
function ancestorScopesFor(
  categoryId: string | null,
  categoryById: ReadonlyMap<string, CategoryRecord>,
): string[] {
  const scopes = new Set<string>(['']);
  if (categoryId !== null) {
    scopes.add(categoryId);
    const category = categoryById.get(categoryId);
    // Absent when the listing's category is no longer in the ACTIVE set this
    // sweep read — its own id is still a real scope (added above); only the
    // ancestors above it are unknown for this run.
    if (category) {
      for (const ancestorId of category.ancestorIds) {
        scopes.add(ancestorId);
      }
    }
  }
  return [...scopes];
}

/**
 * Top `topN` by `unitsSold`, unioned with top `topN` by `viewCount` — the
 * bounded set a scope keeps. Ties break on `listingId` so the selection is
 * deterministic rather than however the counting query happened to order rows.
 */
function selectTopByUnion(
  candidates: ReadonlyMap<string, CountedListing>,
  topN: number,
): CountedListing[] {
  const all = [...candidates.values()];
  const byUnitsSold = [...all]
    .sort((a, b) => b.unitsSold - a.unitsSold || a.listingId.localeCompare(b.listingId))
    .slice(0, topN);
  const byViewCount = [...all]
    .sort((a, b) => b.viewCount - a.viewCount || a.listingId.localeCompare(b.listingId))
    .slice(0, topN);

  const selected = new Map<string, CountedListing>();
  for (const candidate of byUnitsSold) selected.set(candidate.listingId, candidate);
  for (const candidate of byViewCount) selected.set(candidate.listingId, candidate);
  return [...selected.values()];
}

/**
 * Run the two counting passes and replace every scope they touch.
 *
 * @returns how many rows `replaceWindow` inserted.
 */
async function computeAndReplaceSignals(now: Date): Promise<number> {
  const since = new Date(now.getTime() - config.discovery.windowDays * 86_400_000);
  const [salesRows, viewRows] = await Promise.all([
    countListingSales(since),
    countListingViews(since),
  ]);

  // Merge the two passes by listing id BEFORE scoping — the first half of
  // dedup: a listing counted by both passes gets one entry carrying both
  // figures, never two.
  const countsByListing = new Map<
    string,
    { unitsSold: number; orderCount: number; viewCount: number }
  >();
  for (const row of salesRows) {
    countsByListing.set(row.listingId, {
      unitsSold: row.unitsSold,
      orderCount: row.orderCount,
      viewCount: 0,
    });
  }
  for (const row of viewRows) {
    const existing = countsByListing.get(row.listingId);
    if (existing) {
      existing.viewCount = row.viewCount;
    } else {
      countsByListing.set(row.listingId, { unitsSold: 0, orderCount: 0, viewCount: row.viewCount });
    }
  }

  const listingIds = [...countsByListing.keys()];
  if (listingIds.length === 0) {
    return replaceWindow({ window: WINDOW, scopeCategoryIds: [], rows: [], computedAt: now });
  }

  const [listingRecords, categoryRecords] = await Promise.all([
    findListingsByIds(listingIds),
    findActiveCategories(),
  ]);
  const categoryById = new Map(categoryRecords.map((category) => [category.id, category]));

  // scope categoryId -> listingId -> counted candidate.
  const scopeCandidates = new Map<string, Map<string, CountedListing>>();

  for (const listing of listingRecords) {
    const counts = countsByListing.get(listing.id);
    if (!counts) continue;
    // See the file docblock: an optimisation, never the defence.
    if (listing.status !== 'active') continue;

    for (const scopeId of ancestorScopesFor(listing.categoryId, categoryById)) {
      let candidates = scopeCandidates.get(scopeId);
      if (!candidates) {
        candidates = new Map();
        scopeCandidates.set(scopeId, candidates);
      }
      candidates.set(listing.id, {
        listingId: listing.id,
        storeId: listing.storeId,
        unitsSold: counts.unitsSold,
        orderCount: counts.orderCount,
        viewCount: counts.viewCount,
      });
    }
  }

  const rows: DiscoverySignalInput[] = [];
  for (const [scopeId, candidates] of scopeCandidates) {
    const selected = selectTopByUnion(candidates, config.discovery.topNPerCategory);

    // Roll the SELECTED listings up one level into store subjects — the
    // second half of dedup: several listings of one store in one scope sum
    // into ONE row for that `(store, scope)`, never one row each.
    const storeAggregates = new Map<
      string,
      { unitsSold: number; orderCount: number; viewCount: number }
    >();

    for (const candidate of selected) {
      rows.push({
        subjectType: 'listing',
        subjectId: candidate.listingId,
        categoryId: scopeId,
        unitsSold: candidate.unitsSold,
        orderCount: candidate.orderCount,
        viewCount: candidate.viewCount,
      });

      if (candidate.storeId !== null) {
        const aggregate = storeAggregates.get(candidate.storeId) ?? {
          unitsSold: 0,
          orderCount: 0,
          viewCount: 0,
        };
        aggregate.unitsSold += candidate.unitsSold;
        aggregate.orderCount += candidate.orderCount;
        aggregate.viewCount += candidate.viewCount;
        storeAggregates.set(candidate.storeId, aggregate);
      }
    }

    for (const [storeId, aggregate] of storeAggregates) {
      rows.push({
        subjectType: 'store',
        subjectId: storeId,
        categoryId: scopeId,
        unitsSold: aggregate.unitsSold,
        orderCount: aggregate.orderCount,
        viewCount: aggregate.viewCount,
      });
    }
  }

  return replaceWindow({
    window: WINDOW,
    scopeCategoryIds: [...scopeCandidates.keys()],
    rows,
    computedAt: now,
  });
}

/**
 * Count sales and views over the rolling window and replace every scope they
 * touch, if this task can take the lease.
 *
 * @returns How many rows were written, or `undefined` when another task holds
 *   the lease.
 */
export async function runDiscoverySweepOnce(
  now = new Date(),
): Promise<{ rowsWritten: number } | undefined> {
  const leaseOwner = `discovery-sweep:${String(process.pid)}:${randomUUID()}`;
  const cursor = await claimDiscoverySweepRun({
    job: DISCOVERY_SWEEP_JOB,
    leaseOwner,
    leaseMs: config.discovery.leaseMs,
    now,
  });
  if (!cursor) return undefined;

  try {
    const rowsWritten = await computeAndReplaceSignals(now);
    await completeDiscoverySweepRun({ job: DISCOVERY_SWEEP_JOB, leaseOwner, now });
    return { rowsWritten };
  } catch (error: unknown) {
    // The lease is released and nothing else is recorded — there is no
    // partial-progress cursor to protect, because the next tick recomputes
    // the whole rolling window regardless of where this run got to.
    await completeDiscoverySweepRun({
      job: DISCOVERY_SWEEP_JOB,
      leaseOwner,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      now,
    });
    log.general.error({ err: error }, '[Discovery] sweep failed');
    throw error;
  }
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const outcome = await runDiscoverySweepOnce();
    if (outcome) {
      log.general.info({ ...outcome }, '[Discovery] sweep wrote signals');
    }
  } catch (error: unknown) {
    // Already logged with the failure inside `runDiscoverySweepOnce`;
    // swallowed here so one bad run does not stop the timer.
    log.general.error({ err: error }, '[Discovery] sweep tick failed; continuing');
  } finally {
    running = false;
  }
}

/** Start the sweep loop. Idempotent. */
export function startDiscoverySweep(): void {
  if (timer !== undefined) return;

  timer = setInterval(() => {
    void tick();
  }, config.discovery.sweepIntervalMs);
  // Never hold the event loop open for a poll — `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    { intervalMs: config.discovery.sweepIntervalMs },
    '[Discovery] signal sweep started',
  );
}

/** Stop the sweep loop. The run already in flight finishes. */
export function stopDiscoverySweep(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
