/**
 * What every backfill stage is handed, and the two helpers that make per-record
 * error isolation and the counter invariant impossible to get wrong (#60 job
 * behaviour 2 and 4).
 *
 * ## The contract a stage signs by taking a {@link StageContext}
 *
 * A stage gets a cursor, a bound, a cohort, a clock and a
 * {@link CanonicalGraphWriter}. It does NOT get a database handle for writing to
 * anything but its own report rows, and it does not get the canonical write
 * services — see `graph-writer.ts` for why that is a shape rather than a rule.
 *
 * ## Why {@link examineSubject} exists rather than a `try` in each stage
 *
 * "Source and matching errors are isolated per record" is a property of every
 * loop in the domain, and every loop writing its own `try/catch` is how one loop
 * ends up without one — at which point a single poison listing stops a whole
 * migration and the report says the pass simply ended early. Routing every
 * subject through one helper makes the isolation, the `failed` counter and the
 * `record_error` evidence row the SAME act, so a stage cannot have one without
 * the others.
 *
 * It also closes the quieter half: a caught error that produced no record row
 * would leave `scanned` ahead of the outcome counters, and
 * `catalog_backfill_runs_counters_total_check` refuses that sum outright. The
 * database is what turns "somebody forgot to count a failure" into a failed
 * write rather than an optimistic report.
 */

import type {
  CatalogBackfillMode,
  CatalogBackfillOutcome,
  CatalogBackfillReasonCode,
  CatalogBackfillStage,
} from '@mercaria/shared-types';
import { CATALOG_BACKFILL_REASON_OUTCOMES } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  addCounters,
  EMPTY_COUNTERS,
  type BackfillCounterDelta,
} from '../../db/backfill/backfillRunRepository.js';
import { recordBackfillOutcome } from '../../db/backfill/backfillRecordRepository.js';
import type { BackfillCohort } from './cohort.js';
import type { CanonicalGraphWriter } from './graph-writer.js';
import { backfillSubjectKey, type BackfillSubject } from './mapping-version.js';

/** Everything one page of one stage is allowed to know. */
export interface StageContext {
  readonly runId: string;
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly mappingVersion: number;
  readonly cohort: BackfillCohort;
  /** The operator who opened the run — the actor on every write it makes. */
  readonly actorOxyUserId: string;
  readonly writer: CanonicalGraphWriter;
  /** How many subjects this page may examine. */
  readonly limit: number;
  /** Where this page starts. `null` at the beginning of a pass. */
  readonly cursor: string | null;
  readonly now: Date;
}

/** What one page produced. */
export interface StagePageResult {
  readonly counters: BackfillCounterDelta;
  /** `null` when the pass is complete. */
  readonly nextCursor: string | null;
}

/** One stage's page function. */
export type StageRunner = (context: StageContext) => Promise<StagePageResult>;

/** The verdict a stage returns for one subject. */
export interface SubjectVerdict {
  readonly reasonCode: CatalogBackfillReasonCode;
  readonly detail?: string;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
}

/**
 * The outcome a reason code implies, when the map names exactly one.
 *
 * Deriving it rather than making every stage repeat it is what stops a stage
 * writing `record_error` beside `unchanged`: there is one map, the database
 * checks it, and the caller never gets to disagree with it. The two-member entry
 * (`projection_*` are singletons today, so there is none) would need the stage to
 * state the outcome explicitly — which is why this throws rather than guessing.
 */
function outcomeFor(reasonCode: CatalogBackfillReasonCode): CatalogBackfillOutcome {
  const outcomes = CATALOG_BACKFILL_REASON_OUTCOMES[reasonCode];
  const only = outcomes.length === 1 ? outcomes[0] : undefined;
  if (only === undefined) {
    throw new Error(
      `Backfill reason '${reasonCode}' allows ${String(outcomes.length)} outcomes; a stage must state which.`,
    );
  }
  return only;
}

/**
 * The counter delta one outcome contributes. Always `scanned: 1`.
 *
 * A `switch` rather than a computed key, so a new outcome is a compile error
 * here instead of a silently uncounted one — and an uncounted outcome is exactly
 * what `catalog_backfill_runs_counters_total_check` refuses to store, which
 * would surface as a failed page long after the omission.
 */
function counterFor(outcome: CatalogBackfillOutcome): BackfillCounterDelta {
  const base = { ...EMPTY_COUNTERS, scanned: 1 };
  switch (outcome) {
    case 'unchanged':
      return { ...base, unchanged: 1 };
    case 'matched':
      return { ...base, matched: 1 };
    case 'created':
      return { ...base, created: 1 };
    case 'enqueued':
      return { ...base, enqueued: 1 };
    case 'review_required':
      return { ...base, reviewRequired: 1 };
    case 'unmatched':
      return { ...base, unmatched: 1 };
    case 'skipped':
      return { ...base, skipped: 1 };
    case 'failed':
      return { ...base, failed: 1 };
  }
}

/**
 * Examine ONE subject: run the stage's logic, record what happened, and count it.
 *
 * A throw is caught, logged, recorded as `record_error`/`failed`, and the page
 * continues — which is the whole of issue job behaviour 4. Nothing rethrows: a
 * page that aborted on the first bad listing would make the cursor unable to
 * advance past it, and the migration would stop at its worst record forever.
 *
 * @param db Pass a transaction when the stage's write and its evidence must
 *   commit together; omit it when the stage only reads.
 */
export async function examineSubject(
  context: StageContext,
  subject: BackfillSubject,
  decide: () => Promise<SubjectVerdict>,
  db?: DatabaseOrTransaction,
): Promise<BackfillCounterDelta> {
  const subjectKey = backfillSubjectKey(subject);
  let verdict: SubjectVerdict;
  try {
    verdict = await decide();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.general.warn(
      { err: error, stage: context.stage, subjectKey, runId: context.runId },
      '[Backfill] record failed; isolated and recorded',
    );
    await recordBackfillOutcome(
      {
        runId: context.runId,
        stage: context.stage,
        mode: context.mode,
        mappingVersion: context.mappingVersion,
        subjectKind: subject.kind,
        subjectKey,
        outcome: 'failed',
        reasonCode: 'record_error',
        detail: message,
      },
      getDb(),
    );
    return counterFor('failed');
  }

  const outcome = outcomeFor(verdict.reasonCode);
  await recordBackfillOutcome(
    {
      runId: context.runId,
      stage: context.stage,
      mode: context.mode,
      mappingVersion: context.mappingVersion,
      subjectKind: subject.kind,
      subjectKey,
      outcome,
      reasonCode: verdict.reasonCode,
      detail: verdict.detail ?? null,
      canonicalProductId: verdict.canonicalProductId ?? null,
      canonicalVariantId: verdict.canonicalVariantId ?? null,
    },
    db ?? getDb(),
  );
  return counterFor(outcome);
}

/**
 * Examine a whole page's worth of subjects, summing their counters.
 *
 * The failure of one subject never reaches another: `examineSubject` has already
 * absorbed it, so this loop has nothing to guard.
 */
export async function examineAll<T>(
  context: StageContext,
  items: readonly T[],
  subjectOf: (item: T) => BackfillSubject,
  decide: (item: T) => Promise<SubjectVerdict>,
): Promise<BackfillCounterDelta> {
  let counters = EMPTY_COUNTERS;
  for (const item of items) {
    counters = addCounters(
      counters,
      await examineSubject(context, subjectOf(item), () => decide(item)),
    );
  }
  return counters;
}

/**
 * The cursor a keyset page hands back.
 *
 * A SHORT page ends the pass. Comparing against the limit rather than looking
 * for an empty page saves a whole round trip per pass and, more importantly,
 * cannot loop forever on a page that is exactly empty — `match-sweep.service`'s
 * rule, and the same trap it names.
 */
export function nextKeysetCursor(rows: readonly { id: string }[], limit: number): string | null {
  if (rows.length < limit) return null;
  return rows[rows.length - 1]?.id ?? null;
}
