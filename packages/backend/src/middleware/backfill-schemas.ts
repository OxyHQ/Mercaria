/**
 * Request schemas for the backfill operator surface (#60).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types` rather than being retyped, so a schema cannot accept
 * a value the database CHECK then refuses.
 *
 * `.strict()` is doing specific work here: **no schema in this file carries a
 * counter, an outcome, a cursor or a mapping version.** All four are the
 * runner's to compute or the code's to declare, and a request able to carry one
 * would be an HTTP route around the report's own integrity — an operator could
 * post `scanned: 1_000_000, failed: 0` and get exactly the clean-looking pass
 * over nothing that `catalog_backfill_runs_counters_total_check` exists to make
 * unrepresentable.
 *
 * Nor is there a schema for RESOLVING a consistency finding. A finding resolves
 * by being re-examined and found consistent; a route that closed one by hand
 * would let an operator silence a disagreement rather than fix it, and the
 * remedy for every kind is an idempotent path they can already drive.
 */

import { z } from 'zod';
import {
  CATALOG_BACKFILL_COHORT_KINDS,
  CATALOG_BACKFILL_MODES,
  CATALOG_BACKFILL_STAGES,
  CATALOG_BACKFILL_OUTCOMES,
  type CatalogBackfillCohortKind,
  type CatalogBackfillMode,
  type CatalogBackfillOutcome,
  type CatalogBackfillStage,
} from '@mercaria/shared-types';

const STAGE_VALUES = CATALOG_BACKFILL_STAGES as readonly [
  CatalogBackfillStage,
  ...CatalogBackfillStage[],
];
const MODE_VALUES = CATALOG_BACKFILL_MODES as readonly [
  CatalogBackfillMode,
  ...CatalogBackfillMode[],
];
const COHORT_KIND_VALUES = CATALOG_BACKFILL_COHORT_KINDS as readonly [
  CatalogBackfillCohortKind,
  ...CatalogBackfillCohortKind[],
];
const OUTCOME_VALUES = CATALOG_BACKFILL_OUTCOMES as readonly [
  CatalogBackfillOutcome,
  ...CatalogBackfillOutcome[],
];

/** A reason is MANDATORY on every write here, and an empty one is not a reason. */
const reason = z.string().trim().min(1).max(2_000);

/**
 * Open a run.
 *
 * `mode` is required and has no default, deliberately. Defaulting it either way
 * is wrong: defaulting to `apply` makes a mistyped request mutate the graph, and
 * defaulting to `dry_run` makes an operator who meant to migrate believe they
 * did. Making the caller say which is the only reading with no silent failure.
 */
export const openBackfillRunSchema = z
  .object({
    stage: z.enum(STAGE_VALUES),
    mode: z.enum(MODE_VALUES),
    cohortKind: z.enum(COHORT_KIND_VALUES).default('all'),
    /** Required for every cohort kind but `all` — checked by `parseCohort`. */
    cohortValue: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** Run one page now, instead of waiting for the dispatcher. */
export const runBackfillPageSchema = z
  .object({
    /** Bounded here AND by the runner, which clamps it against the config. */
    limit: z.number().int().min(1).max(2_000).optional(),
  })
  .strict();

/** Cancel an open run. */
export const cancelBackfillRunSchema = z.object({ reason }).strict();

/** Filter the per-record report. */
export const backfillRecordsQuerySchema = z
  .object({
    outcome: z.enum(OUTCOME_VALUES).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
