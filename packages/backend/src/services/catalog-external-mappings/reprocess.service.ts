/**
 * Reprocessing after a mapping change — idempotent, resumable, and a dry run
 * before anything is written (#367 Workstream 11).
 *
 * A mapping change re-interprets every token already observed under the old one.
 * Doing that safely is three properties, and each is held by a mechanism rather
 * than by care:
 *
 * - **Idempotent.** `UNIQUE(run_id, subject_key)` with `ON CONFLICT DO NOTHING`.
 *   A re-run of a page writes nothing for the subjects already recorded, and the
 *   empty result is the signal not to count them again — so a reclaimed run
 *   cannot double its own counters. `DO UPDATE` would lose exactly that.
 * - **Resumable.** The cursor is advanced by the LAST statement of a page, after
 *   every item of it has been written. A crash mid-page therefore leaves the
 *   cursor where the last COMPLETE page ended, so the next claim re-reads that
 *   page and the idempotency above absorbs the overlap. Note the mechanism:
 *   this is statement ORDER plus `ON CONFLICT DO NOTHING`, NOT atomicity — see
 *   the note on transactions below.
 * - **Previewed.** `mode` is part of the run's identity (#60), so a `dry_run`
 *   and the `apply` it predicted are two rows that can be compared. A dry run
 *   holds a `CanonicalGraphWriter`-shaped guarantee in the simplest possible
 *   form: {@link runReprocessPage} only calls the write in the `apply` branch,
 *   and the `dry_run` branch has no writer in scope at all.
 *
 * ## What an `apply` actually writes
 *
 * The observation's own resolution, plus a `reprocess_requested_at` stamp. The
 * ROW IS THE JOB (#48's `payment_provider_events`), so there is no outbox row
 * that could disagree with it. Nothing downstream drains that queue today — a
 * gated LOOP, never a gated record, and the seam is named in
 * `docs/catalog-external-mappings.md`.
 *
 * This module writes NOTHING outside its own five tables. It cannot mint a
 * canonical entity, re-point an offer or touch a source object, and
 * `external-mapping-isolation.test.ts` fails the build if that changes — which
 * is what makes "source records stay idempotent and must not create duplicate
 * canonical entities" a property of the import graph.
 */

import type {
  CatalogExternalMappingDimension,
  CatalogExternalReprocessMode,
  CatalogExternalReprocessOutcome,
} from '@mercaria/shared-types';
import { conflict, validationError } from '../../lib/errors/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  advanceExternalMappingRun,
  applyObservationResolution,
  findExternalMapping,
  findExternalMappingRun,
  finishExternalMappingRun,
  openExternalMappingRun,
  readObservationPage,
  recordExternalMappingRunItem,
  tallyRunItems,
  type ExternalMappingRunRow,
  type ExternalTokenObservationRow,
} from '../../db/catalogExternalMappings/externalMappingRepository.js';
import { computeResolution } from './resolution.service.js';

/** How many observations one page examines. Bounded so a run is many small transactions. */
const REPROCESS_PAGE_SIZE = 200;

/** A zeroed outcome tally — the shape `advanceExternalMappingRun` adds to the run. */
function emptyDelta(): Record<CatalogExternalReprocessOutcome, number> {
  return { unchanged: 0, retargeted: 0, newly_mapped: 0, unmapped_now: 0, refused: 0, skipped: 0 };
}

/**
 * Open a reprocessing run.
 *
 * A `dry_run` and an `apply` are separate runs with separate identities, and the
 * partial unique refuses a second live run of the same mode for one source. That
 * refusal is returned as a conflict rather than swallowed: two concurrent
 * applies would interleave their cursors and each would report a partial pass as
 * a whole one.
 */
export async function openReprocessRun(
  input: {
    readonly catalogSourceId: string;
    readonly dimension?: CatalogExternalMappingDimension;
    readonly mappingId?: string;
    readonly mode: CatalogExternalReprocessMode;
    readonly requestedByOxyUserId: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRunRow> {
  let mappingVersion: number | undefined;
  if (input.mappingId !== undefined) {
    const mapping = await findExternalMapping(input.mappingId, db);
    if (mapping === null) throw validationError('No such mapping.');
    mappingVersion = mapping.version;
  }

  const run = await openExternalMappingRun(
    {
      catalogSourceId: input.catalogSourceId,
      ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
      ...(input.mappingId === undefined ? {} : { mappingId: input.mappingId }),
      ...(mappingVersion === undefined ? {} : { mappingVersion }),
      mode: input.mode,
      requestedByOxyUserId: input.requestedByOxyUserId,
    },
    db,
  );
  if (run === null) {
    throw conflict(`A ${input.mode} run is already open for this source.`);
  }
  return run;
}

/** What one page did. Returned so a caller can loop until `done`. */
export interface ReprocessPageResult {
  readonly runId: string;
  readonly examined: number;
  readonly recorded: number;
  readonly delta: Readonly<Record<CatalogExternalReprocessOutcome, number>>;
  readonly cursorExternalKey: string | null;
  readonly done: boolean;
}

/**
 * Examine one page of a run.
 *
 * The page is read, every observation is RE-RESOLVED through the same
 * `computeResolution` the live read path uses — never a second implementation of
 * the rules, which would measure the re-implementation — and each subject gets
 * one item row. In `apply` mode, and only there, the observation's stored
 * resolution is updated and stamped for downstream reprocessing.
 *
 * ## Two facts about this module that its shape does not show (#551)
 *
 * **A page is NOT a transaction, despite the page-sized bound.** This function
 * opens none: `db` defaults to the root connection and no `db.transaction(...)`
 * appears anywhere in this file, so each item write and the cursor advance are
 * separate autocommitted statements. The resumability above still holds, by the
 * ordering described there — but a crash mid-page leaves items committed whose
 * outcomes were never added to the run's counters, because the advance carrying
 * that delta never ran. That is not unguarded: {@link readRunMetrics} exists to
 * report it, and its `countsAgree` is the signal. Wrapping a page in a
 * transaction would remove the gap rather than report it, and is a change to
 * make deliberately rather than by assuming it is already there.
 *
 * **Nothing calls this.** {@link runReprocessPage} has no importer anywhere in
 * the repository — no route (`internal-catalog-governance.ts` exposes no
 * reprocess endpoint), no worker, no test — and only this module calls
 * `advanceExternalMappingRun` and `finishExternalMappingRun`. The tables exist
 * and the service is unwired. Stated here because it is the first thing a future
 * implementer needs and the last thing the code shows: whoever reads this is
 * NOT correcting a live path. Whether it is an owed seam (#367 workstream 11)
 * or should be cut is recorded separately; it is a modelling decision, and
 * "nothing calls it" is a reason to ask rather than to delete.
 */
export async function runReprocessPage(
  runId: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReprocessPageResult> {
  const run = await findExternalMappingRun(runId, db);
  if (run === null) throw validationError('No such run.');
  if (run.state === 'completed' || run.state === 'failed') {
    throw conflict('That run has already finished.');
  }

  const page = await readObservationPage(
    {
      catalogSourceId: run.catalogSourceId,
      ...(run.dimension === null ? {} : { dimension: run.dimension }),
      afterExternalKey: run.cursorExternalKey,
      limit: REPROCESS_PAGE_SIZE,
    },
    db,
  );

  if (page.length === 0) {
    await finishExternalMappingRun({ id: runId, state: 'completed', at: now }, db);
    return {
      runId,
      examined: 0,
      recorded: 0,
      delta: emptyDelta(),
      cursorExternalKey: run.cursorExternalKey,
      done: true,
    };
  }

  const delta = emptyDelta();
  let recorded = 0;
  let cursor = run.cursorExternalKey;

  for (const observation of page) {
    const outcome = await examineObservation(run, observation, now, db);
    // The empty result of the `ON CONFLICT DO NOTHING` IS the "already counted
    // on a previous attempt" answer, so a resumed page cannot double the tally.
    const isNew = await recordExternalMappingRunItem(
      {
        runId,
        subjectKind: observation.subjectKind,
        subjectKey: observation.subjectKey,
        externalKey: observation.externalKey,
        outcome: outcome.outcome,
        previousMappingId: outcome.previousMappingId,
        nextMappingId: outcome.nextMappingId,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      },
      db,
    );
    if (isNew) {
      delta[outcome.outcome] += 1;
      recorded += 1;
    }
    cursor = observation.externalKeyNormalized;
  }

  await advanceExternalMappingRun({ id: runId, cursorExternalKey: cursor, delta, at: now }, db);

  return {
    runId,
    examined: page.length,
    recorded,
    delta,
    cursorExternalKey: cursor,
    done: page.length < REPROCESS_PAGE_SIZE,
  };
}

/** One subject's verdict, plus the pointers the run item's shape CHECK demands. */
interface ObservationVerdict {
  readonly outcome: CatalogExternalReprocessOutcome;
  readonly previousMappingId: string | null;
  readonly nextMappingId: string | null;
  readonly detail?: string;
}

/**
 * Re-resolve one observation and classify the difference.
 *
 * `unchanged` covers the case where nothing moved AND the case where it was
 * unresolved before and still is — both are `previous is not distinct from next`
 * with two NULLs, which is exactly what
 * `catalog_external_mapping_run_items_outcome_shape_check` permits. Reporting
 * the second as `refused` would put a token nobody has mapped yet into the
 * bucket that means "something went wrong", and the refusal count is what an
 * operator looks at first.
 */
async function examineObservation(
  run: ExternalMappingRunRow,
  observation: ExternalTokenObservationRow,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<ObservationVerdict> {
  const previous = observation.resolvedMappingId;

  const resolution = await computeResolution(
    {
      catalogSourceId: observation.catalogSourceId,
      dimension: observation.dimension,
      externalKey: observation.externalKey,
      ...(observation.observedRawValue === null
        ? {}
        : { rawValue: observation.observedRawValue }),
      at: now,
    },
    db,
  );

  // A `legacy_registry` answer is not a governed resolution: its id names no row
  // and counting it here would make the migration backlog invisible in the one
  // report that exists to size it.
  const next =
    resolution.outcome === 'unresolved'
      ? null
      : ((resolution.outcome === 'resolved'
          ? resolution.resolved
          : resolution.resolved[0]) ?? null);
  const nextMappingId = next !== null && next.origin === 'governed' ? next.mappingId : null;

  if (run.mode === 'apply') {
    await applyObservationResolution(
      {
        id: observation.id,
        resolvedMappingId: nextMappingId,
        resolutionOutcome: nextMappingId === null ? 'unresolved' : 'resolved',
        unresolvedReason:
          nextMappingId === null
            ? resolution.outcome === 'unresolved'
              ? resolution.reason
              : 'unmapped'
            : null,
        requestReprocessAt: now,
      },
      db,
    );
  }

  if (previous === nextMappingId) {
    return { outcome: 'unchanged', previousMappingId: previous, nextMappingId };
  }
  if (previous === null) {
    return { outcome: 'newly_mapped', previousMappingId: null, nextMappingId };
  }
  if (nextMappingId === null) {
    return { outcome: 'unmapped_now', previousMappingId: previous, nextMappingId: null };
  }
  return { outcome: 'retargeted', previousMappingId: previous, nextMappingId };
}

/**
 * A run's counters, beside the counts taken from its own ITEMS.
 *
 * #60's `scannedFromRecords` device. A counter that only ever agrees with itself
 * measures nothing, so the two are reported together with `countsAgree` between
 * them — and a disagreement is a real signal that a page committed items and
 * failed before advancing, or the reverse.
 */
export async function readRunMetrics(
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  readonly run: ExternalMappingRunRow;
  readonly fromItems: Readonly<Record<CatalogExternalReprocessOutcome, number>> & {
    readonly total: number;
  };
  readonly countsAgree: boolean;
}> {
  const run = await findExternalMappingRun(runId, db);
  if (run === null) throw validationError('No such run.');
  const fromItems = await tallyRunItems(runId, db);
  const countsAgree =
    run.scanned === fromItems.total &&
    run.unchanged === fromItems.unchanged &&
    run.retargeted === fromItems.retargeted &&
    run.newlyMapped === fromItems.newly_mapped &&
    run.unmappedNow === fromItems.unmapped_now &&
    run.refused === fromItems.refused &&
    run.skipped === fromItems.skipped;
  return { run, fromItems, countsAgree };
}
