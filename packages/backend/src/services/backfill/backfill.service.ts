/**
 * The staged migration runner (#60 job behaviour 1–5).
 *
 * Opens runs, claims a lease, runs ONE bounded page, checkpoints, releases.
 * Everything specific to a stage lives in `stages/`; this file owns the parts
 * every stage shares and must not each implement:
 *
 * - the lease, so two ECS tasks cannot page one run;
 * - the cursor, made durable BEFORE the lease goes back;
 * - the counters, ADDED and never assigned;
 * - the writer, chosen once from the mode and the publication lever;
 * - the vacuity floor, which is where the honesty of the whole report comes
 *   from.
 *
 * ## The vacuity floor, and why it is not just a comment
 *
 * A migration report's worst failure is a clean-looking pass over nothing: a
 * cohort that matches no rows, a keyset that never advanced, a traversal whose
 * predicate silently excluded everything. All three produce `0 scanned, 0
 * failed` — indistinguishable from a healthy catalogue with nothing left to do.
 *
 * Three things stand between that and a report somebody trusts:
 *
 * 1. `catalog_backfill_runs_counters_total_check` — the outcome counters must
 *    SUM to `scanned`, so a page that swallowed a record cannot write a row.
 * 2. {@link assertCohortIsNotEmpty} — a run over a cohort that selects no
 *    listings at all is refused when it is OPENED, naming the cohort, rather
 *    than completing instantly and reporting success.
 * 3. {@link summarizeBackfill}'s `scannedFromRecords`, which counts the evidence
 *    rows independently of the counters the runner maintains. Two numbers from
 *    two sources; a broken runner can fake one of them.
 */

import { randomUUID } from 'node:crypto';
import type {
  CatalogBackfillMode,
  CatalogBackfillPageResult,
  CatalogBackfillStage,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import {
  advanceBackfillRun,
  claimBackfillRun,
  recordBackfillPageFailure,
  findBackfillRunById,
  listResumableBackfillRuns,
  openBackfillRun,
  releaseBackfillRun,
  type CatalogBackfillRunRow,
} from '../../db/backfill/backfillRunRepository.js';
import { cohortColumns, cohortListingPredicate, parseCohort, type BackfillCohort } from './cohort.js';
import { createGraphWriter } from './graph-writer.js';
import { CATALOG_BACKFILL_MAPPING_VERSION } from './mapping-version.js';
import type { StageContext, StagePageResult, StageRunner } from './stage-context.js';
import { runStoreMerchantsPage } from './stages/store-merchants.js';
import { runVendorBrandCandidatesPage } from './stages/vendor-brands.js';
import { runVariantMatchingPage } from './stages/variant-matching.js';
import { runProvisionalProductsPage } from './stages/provisional-products.js';
import { runNativeOffersPage } from './stages/native-offers.js';
import { runRebuildProjectionsPage, runSearchReindexPage } from './stages/projections.js';
import { runConsistencyPage } from './stages/consistency.js';

/**
 * Every stage's page function, as a TABLE.
 *
 * A `Record` keyed by the stage tuple rather than a `switch`, so adding a stage
 * to `CATALOG_BACKFILL_STAGES` without writing its runner is a compile error
 * here — the alternative is a default branch that silently completes a pass
 * having done nothing, which is the exact shape of report this domain refuses.
 */
const STAGE_RUNNERS: Readonly<Record<CatalogBackfillStage, StageRunner>> = {
  store_merchants: runStoreMerchantsPage,
  vendor_brand_candidates: runVendorBrandCandidatesPage,
  variant_matching: runVariantMatchingPage,
  provisional_products: runProvisionalProductsPage,
  native_offers: runNativeOffersPage,
  rebuild_projections: runRebuildProjectionsPage,
  search_reindex: runSearchReindexPage,
  consistency: runConsistencyPage,
};

/**
 * Stages whose subject set is NOT the `listings` table, and which therefore
 * accept only the `all` cohort.
 *
 * `store_merchants` pages over stores; the projection and reindex stages page
 * over canonical products; `consistency` pages over attachments and offers. A
 * cohort on any of them would silently mean "every row" — a lever that reads as
 * a restriction and applies none is worse than no lever.
 *
 * `vendor_brand_candidates` is here for a different and stronger reason: it is
 * an AGGREGATE, and a cohort-scoped aggregate produces groups that are not the
 * real groups. See that stage's docblock.
 */
const WHOLE_CATALOGUE_STAGES: ReadonlySet<CatalogBackfillStage> = new Set([
  'store_merchants',
  'vendor_brand_candidates',
  'rebuild_projections',
  'search_reindex',
  'consistency',
]);

/** How long one page's lease is held. */
const LEASE_MS = 5 * 60 * 1_000;

/** This process's identity for the lease — per PROCESS, the dispatcher rule. */
const LEASE_OWNER = `catalog-backfill-${randomUUID()}`;

export interface OpenRunInput {
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly cohort: BackfillCohort;
  readonly requestedByOxyUserId: string;
}

/**
 * Refuse a cohort that selects nothing, BEFORE a run exists to report on it.
 *
 * An empty cohort and a finished cohort produce identical reports, and the
 * difference between them is the difference between "the migration is done" and
 * "the migration never looked at anything". The check is a bounded existence
 * probe (`LIMIT 1`), not a count: how many rows there are is not the question.
 */
async function assertCohortIsNotEmpty(cohort: BackfillCohort): Promise<void> {
  if (cohort.kind === 'all') return;
  const predicate = cohortListingPredicate(cohort);
  const rows = await getDb().select({ id: listings.id }).from(listings).where(predicate).limit(1);
  if (rows.length === 0) {
    throw validationError(
      `Cohort ${cohort.kind}:${cohort.value} selects no listings. A run over it would report a clean pass over nothing.`,
    );
  }
}

/** Open a run, or return the open one already covering the same work. */
export async function openCatalogBackfillRun(
  input: OpenRunInput,
): Promise<{ run: CatalogBackfillRunRow; created: boolean }> {
  if (input.cohort.kind !== 'all' && WHOLE_CATALOGUE_STAGES.has(input.stage)) {
    throw validationError(
      `Stage '${input.stage}' does not operate on listings, so a cohort would not restrict it. Run it with cohort 'all'.`,
    );
  }
  await assertCohortIsNotEmpty(input.cohort);

  const columns = cohortColumns(input.cohort);
  return openBackfillRun({
    stage: input.stage,
    mode: input.mode,
    mappingVersion: CATALOG_BACKFILL_MAPPING_VERSION,
    cohortKind: columns.cohortKind,
    cohortValue: columns.cohortValue,
    requestedByOxyUserId: input.requestedByOxyUserId,
  });
}

/**
 * Run ONE bounded page of one run.
 *
 * @returns `undefined` when another task holds the lease — not an error, and
 *   deliberately distinguishable from a completed pass, because "somebody else
 *   is running this" and "there was nothing left" are different operational
 *   facts (`match-sweep.service`'s rule).
 */
export async function runCatalogBackfillPage(
  runId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<CatalogBackfillPageResult | undefined> {
  const now = options.now ?? new Date();
  const opened = await findBackfillRunById(runId);
  if (opened === undefined) throw notFound(`Backfill run ${runId} does not exist.`);
  if (opened.status === 'completed') {
    throw conflict(`Backfill run ${runId} is complete; open a new run to page again.`);
  }

  const claimed = await claimBackfillRun({ runId, leaseOwner: LEASE_OWNER, leaseMs: LEASE_MS, now });
  if (claimed === undefined) return undefined;

  const cohort = parseCohort(claimed.cohortKind, claimed.cohortValue);
  const context: StageContext = {
    runId: claimed.id,
    stage: claimed.stage,
    mode: claimed.mode,
    mappingVersion: claimed.mappingVersion,
    cohort,
    actorOxyUserId: claimed.requestedByOxyUserId,
    // The ONE place the writer is chosen. An `apply` run with the publication
    // lever off gets the dry-run writer and does not know it — see
    // `graph-writer.ts`.
    writer: createGraphWriter(claimed.mode),
    limit: Math.max(1, options.limit ?? config.canonicalRollout.backfillBatchSize),
    cursor: claimed.cursor,
    now,
  };

  let page: StagePageResult;
  try {
    page = await STAGE_RUNNERS[claimed.stage](context);
  } catch (error: unknown) {
    /**
     * A page-level failure, which is a different thing from a record-level one:
     * `examineSubject` has already absorbed every per-record error, so reaching
     * here means the page itself could not run (the query failed, the cohort
     * became unresolvable). The cursor is NOT moved, which is what makes the
     * failure resumable rather than a skipped page.
     *
     * #367 W16 line 759: it is COUNTED before it is terminal. Until this, one
     * dropped connection released the run `failed` — which `RESUMABLE` excludes,
     * so a pass holding a perfectly good cursor stopped on its first transient
     * error and waited for a person. `recordBackfillPageFailure` decides between
     * `paused` (the dispatcher re-reads this same page on its next tick) and
     * `failed` (terminal, and the dead-letter this domain always had).
     */
    const settled = await recordBackfillPageFailure({
      runId: claimed.id,
      leaseOwner: LEASE_OWNER,
      maxAttempts: config.canonicalRollout.backfillMaxAttempts,
      error: error instanceof Error ? error.message : String(error),
      now,
    });
    log.general.error(
      { err: error, runId, stage: claimed.stage, settled: settled ?? 'lease_lost' },
      settled === 'failed'
        ? '[Backfill] page failed; attempts exhausted, run is terminal'
        : '[Backfill] page failed; run will be retried',
    );
    throw error;
  }

  // The cursor and the counters are durable BEFORE the lease goes back, so a
  // crash between the two resumes at the next page rather than repeating this
  // one — which for `provisional_products` would mean minting twice.
  const advanced = await advanceBackfillRun({
    runId: claimed.id,
    leaseOwner: LEASE_OWNER,
    cursor: page.nextCursor,
    counters: page.counters,
  });
  if (!advanced) {
    // The lease was reclaimed mid-page. The page's writes are already committed
    // and every one of them is idempotent, so nothing is lost — but this task is
    // no longer authoritative for the row and must not write its counters over
    // the new owner's.
    log.general.warn({ runId, stage: claimed.stage }, '[Backfill] lease was reclaimed mid-page');
    return undefined;
  }

  await releaseBackfillRun({
    runId: claimed.id,
    leaseOwner: LEASE_OWNER,
    outcome: page.nextCursor === null ? 'completed' : 'paused',
    now,
  });

  const result: CatalogBackfillPageResult = {
    runId: claimed.id,
    stage: claimed.stage,
    mode: claimed.mode,
    ...page.counters,
    nextCursor: page.nextCursor,
  };
  log.general.info(result, '[Backfill] page complete');
  return result;
}

/**
 * Run one page of every resumable run — the dispatcher's tick, exported so a
 * test and the operator surface can drive it deterministically instead of
 * waiting for a timer (`dispatchModerationOutbox`'s seam).
 */
export async function drainCatalogBackfill(
  options: { limit?: number; runs?: number; now?: Date } = {},
): Promise<CatalogBackfillPageResult[]> {
  const now = options.now ?? new Date();
  const resumable = await listResumableBackfillRuns({ limit: options.runs ?? 5, now });
  const results: CatalogBackfillPageResult[] = [];
  for (const run of resumable) {
    const page = await runCatalogBackfillPage(run.id, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      now,
    });
    if (page !== undefined) results.push(page);
  }
  return results;
}

/**
 * Cancel an open run.
 *
 * `failed` rather than a `cancelled` status, deliberately: the run stopped
 * before its pass ended and its cursor is where it stopped, which is exactly
 * what `failed` already means to every reader of this table. A sixth status
 * whose only difference is who decided would be a second representation of "this
 * pass did not finish" — and the reason IS recorded, in `last_error`, with the
 * operator's own words.
 */
export async function cancelCatalogBackfillRun(
  runId: string,
  input: { actorOxyUserId: string; reason: string },
): Promise<CatalogBackfillRunRow> {
  if (input.reason.trim() === '') {
    throw validationError('Cancelling a backfill run requires a reason.');
  }
  const run = await findBackfillRunById(runId);
  if (run === undefined) throw notFound(`Backfill run ${runId} does not exist.`);
  if (run.status === 'completed') throw conflict(`Backfill run ${runId} is already complete.`);
  if (run.leaseOwner !== null) {
    throw conflict(`Backfill run ${runId} is running; wait for its lease to expire.`);
  }

  const cancelled = await getDb().transaction(async (tx) => {
    const claimed = await claimBackfillRun(
      { runId, leaseOwner: `cancel:${input.actorOxyUserId}`, leaseMs: 1_000 },
      tx,
    );
    if (claimed === undefined) return undefined;
    await releaseBackfillRun(
      {
        runId,
        leaseOwner: `cancel:${input.actorOxyUserId}`,
        outcome: 'failed',
        // The OTHER producer of `failed`, and the reason the cause is a column.
        // An operator stopping a run is not a dead letter: nothing was
        // exhausted and nothing is owed a retry. Counting it as one would
        // report a person's decision as a system failure, which is the number
        // `backfill_dead_letter_count` exists to keep clean.
        terminalCause: 'operator_cancelled',
        error: `cancelled by ${input.actorOxyUserId}: ${input.reason}`,
      },
      tx,
    );
    return findBackfillRunById(runId, tx);
  });

  if (cancelled === undefined) throw conflict(`Backfill run ${runId} raced a concurrent claim.`);
  return cancelled;
}
