/**
 * Which backfill stage the autopilot opens next — a pure function of the
 * newest run of each stage.
 *
 * The autopilot repeats one CYCLE: every stage of {@link AUTOPILOT_STAGE_SEQUENCE}
 * once, in dependency order (`docs/backfill.md`), each opened only after the
 * previous one finished. The state of a cycle is entirely in
 * `catalog_backfill_runs`, so the plan needs no table of its own, survives a
 * restart, and two tasks reading the same rows plan the same stage —
 * `openCatalogBackfillRun` then converges both on one run.
 *
 * A FAILED run counts as finished: the cycle moves on and the next cycle
 * retries that stage. Stopping the whole pipeline on one stage would freeze
 * every price on the site behind, say, a consistency finding.
 */

import type { CatalogBackfillRunStatus, CatalogBackfillStage } from '@mercaria/shared-types';

/**
 * Every whole-catalogue stage, in dependency order. `search_reindex` is left out
 * on purpose: it only enqueues requests for #61's consumer while
 * `CANONICAL_SEARCH_INDEXING_ENABLED` is on, and `/search` reads the canonical
 * tables directly.
 */
export const AUTOPILOT_STAGE_SEQUENCE: readonly CatalogBackfillStage[] = [
  'store_merchants',
  'vendor_brand_candidates',
  'variant_matching',
  'provisional_products',
  'native_offers',
  'reference_products',
  'source_readvance',
  'reference_promotion',
  'rebuild_projections',
  'consistency',
];

/** How long after a cycle STARTED the next one may start. */
export const AUTOPILOT_CYCLE_INTERVAL_MS = 30 * 60 * 1_000;

/** The facts the plan reads about one stage's newest run. */
export interface StageRunFacts {
  readonly status: CatalogBackfillRunStatus;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly lastRunAt: Date | null;
}

const OPEN_STATUSES: ReadonlySet<CatalogBackfillRunStatus> = new Set([
  'pending',
  'running',
  'paused',
]);

/** When a closed run stopped: its completion, else its last page, else its opening. */
function finishedAt(run: StageRunFacts): Date {
  return run.completedAt ?? run.lastRunAt ?? run.createdAt;
}

/**
 * The stage to open now, or `null` to wait — because a stage is still running,
 * or because the last cycle finished less than the interval ago.
 */
export function planNextStage(
  latest: ReadonlyMap<CatalogBackfillStage, StageRunFacts>,
  now: Date,
  sequence: readonly CatalogBackfillStage[] = AUTOPILOT_STAGE_SEQUENCE,
  cycleIntervalMs: number = AUTOPILOT_CYCLE_INTERVAL_MS,
): CatalogBackfillStage | null {
  const first = sequence[0];
  if (first === undefined) return null;
  if (
    sequence.some((stage) => {
      const run = latest.get(stage);
      return run !== undefined && OPEN_STATUSES.has(run.status);
    })
  ) {
    return null;
  }

  // Walk the cycle: a stage belongs to it when it was opened after its
  // predecessor finished. The first that does not is the one to open.
  let previous: StageRunFacts | undefined;
  for (const stage of sequence) {
    const run = latest.get(stage);
    if (run === undefined) return stage;
    if (previous !== undefined && run.createdAt < finishedAt(previous)) return stage;
    previous = run;
  }

  const cycleStart = latest.get(first)?.createdAt;
  if (cycleStart === undefined) return first;
  return now.getTime() - cycleStart.getTime() >= cycleIntervalMs ? first : null;
}
