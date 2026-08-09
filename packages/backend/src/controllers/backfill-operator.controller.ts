/**
 * The backfill operator surface (#60 job behaviour 2–7).
 *
 * Reads, one open, one page trigger, one cancel. Every WRITE drives a path that
 * already exists and is already idempotent — the runner's own page, the run
 * repository's own lease — so this surface adds buttons and no second way for
 * the migration to happen.
 *
 * What is deliberately absent, and why each absence is load-bearing:
 *
 * - **No "resolve finding".** A consistency finding resolves by being
 *   re-examined and found consistent. A route that closed one by hand would let
 *   an operator silence a disagreement instead of fixing it, and every kind
 *   already has an idempotent remedy they can drive (re-run `native_offers`,
 *   re-run `provisional_products`) — or is a moderation restriction, where the
 *   correct action is none.
 * - **No "delete run" and no "delete record".** Issue job behaviour 7: rollback
 *   disables reads and offer publication WITHOUT deleting migration evidence.
 *   Neither repository offers a delete, and this surface could not call one.
 * - **No flag WRITE.** The levers are environment variables read at boot, and a
 *   route that changed one at runtime would make "what was this deployment doing
 *   at 14:00" unanswerable from configuration. `GET /flags` reports them.
 * - **No "mint a canonical product for this listing".** That is the
 *   `provisional_products` stage, with its matcher-verdict precondition. A
 *   direct route would be the duplicate-product path that precondition exists to
 *   close.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CatalogBackfillMode, CatalogBackfillOutcome } from '@mercaria/shared-types';
import { CATALOG_BACKFILL_MODES } from '@mercaria/shared-types';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import {
  findBackfillRunById,
  listBackfillRuns,
} from '../db/backfill/backfillRunRepository.js';
import {
  listBackfillRecordsForRun,
  listBackfillRecordsForSubject,
  tallyBackfillRecords,
} from '../db/backfill/backfillRecordRepository.js';
import { listOpenConsistencyFindings } from '../db/backfill/consistencyFindingRepository.js';
import {
  cancelCatalogBackfillRun,
  openCatalogBackfillRun,
  runCatalogBackfillPage,
} from '../services/backfill/backfill.service.js';
import { parseCohort } from '../services/backfill/cohort.js';
import {
  toBackfillRecordDTO,
  toBackfillRunDTO,
  toConsistencyFindingDTO,
} from '../services/backfill/dto.js';
import { summarizeBackfill } from '../services/backfill/metrics.js';
import {
  canonicalRolloutFlags,
  readCanonicalShadowReads,
} from '../services/backfill/read-mode.js';
import {
  openBackfillRunSchema,
  runBackfillPageSchema,
  cancelBackfillRunSchema,
  backfillRecordsQuerySchema,
} from '../middleware/backfill-schemas.js';

/** GET `/internal/backfill/flags` — every rollout lever's current value. */
export function backfillFlagsHandler(_req: Request, res: Response): void {
  sendSuccess(res, { flags: canonicalRolloutFlags(), shadowReads: readCanonicalShadowReads() });
}

/** GET `/internal/backfill/runs` — every run of the current mapping version. */
export async function listBackfillRunsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const runs = await listBackfillRuns({ limit: 200 });
    sendSuccess(res, { runs: runs.map(toBackfillRunDTO) });
  } catch (err) {
    respondWithError(res, err, 'Failed to list backfill runs');
  }
}

/**
 * GET `/internal/backfill/metrics` — throughput, ambiguity, unmatched rate,
 * orphaned offers, and the DRY-RUN comparison beside the apply figures.
 *
 * Both modes in one response on purpose: the question a rollout actually asks is
 * "did the apply do what the rehearsal predicted", and a surface that answered
 * one at a time would make an operator do the comparison in their head.
 */
export async function backfillMetricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const [dryRun, apply] = await Promise.all(
      CATALOG_BACKFILL_MODES.map((mode) => summarizeBackfill({ mode })),
    );
    sendSuccess(res, { dryRun, apply });
  } catch (err) {
    respondWithError(res, err, 'Failed to summarize the backfill');
  }
}

/** POST `/internal/backfill/runs` — open a run, or return the open one. */
export async function openBackfillRunHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = openBackfillRunSchema.parse(req.body);
    const cohort = parseCohort(body.cohortKind, body.cohortValue ?? null);
    const { run, created } = await openCatalogBackfillRun({
      stage: body.stage,
      mode: body.mode,
      cohort,
      requestedByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { run: toBackfillRunDTO(run), created }, created ? 201 : 200);
  } catch (err) {
    respondWithError(res, err, 'Failed to open a backfill run');
  }
}

/**
 * POST `/internal/backfill/runs/:id/page` — run ONE bounded page now.
 *
 * The canary's own button. A 409 means another task holds the lease, which is a
 * different answer from "the pass finished" and is reported as such: an operator
 * pacing a rollout by hand needs to know which of the two happened before they
 * decide whether to widen the cohort.
 */
export async function runBackfillPageHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = runBackfillPageSchema.parse(req.body ?? {});
    const runId = routeParam(req, 'id');
    const page = await runCatalogBackfillPage(runId, {
      ...(body.limit === undefined ? {} : { limit: body.limit }),
    });
    if (page === undefined) {
      sendError(res, ErrorCodes.CONFLICT, 'Another task is running this backfill page', 409);
      return;
    }
    const run = await findBackfillRunById(runId);
    sendSuccess(res, { page, run: run === undefined ? null : toBackfillRunDTO(run) });
  } catch (err) {
    respondWithError(res, err, 'Failed to run a backfill page');
  }
}

/** POST `/internal/backfill/runs/:id/cancel` — stop an open run, with a reason. */
export async function cancelBackfillRunHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = cancelBackfillRunSchema.parse(req.body);
    const run = await cancelCatalogBackfillRun(routeParam(req, 'id'), {
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: body.reason,
    });
    sendSuccess(res, { run: toBackfillRunDTO(run) });
  } catch (err) {
    respondWithError(res, err, 'Failed to cancel the backfill run');
  }
}

/**
 * GET `/internal/backfill/runs/:id/records` — one run's per-record report.
 *
 * The tally is returned BESIDE the rows, and it counts the evidence rather than
 * reading the run's counters, so an operator paging through failures can see
 * that the two agree without doing the arithmetic.
 */
export async function listBackfillRecordsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = backfillRecordsQuerySchema.parse(req.query);
    const runId = routeParam(req, 'id');
    const run = await findBackfillRunById(runId);
    if (run === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Backfill run not found', 404);
      return;
    }
    const outcome: CatalogBackfillOutcome | undefined = query.outcome;
    const records = await listBackfillRecordsForRun({
      runId,
      ...(outcome === undefined ? {} : { outcome }),
      limit: query.limit ?? 100,
    });
    const mode: CatalogBackfillMode = run.mode;
    const tally = await tallyBackfillRecords({
      mappingVersion: run.mappingVersion,
      mode,
      stage: run.stage,
    });
    sendSuccess(res, {
      run: toBackfillRunDTO(run),
      records: records.map(toBackfillRecordDTO),
      tally,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list backfill records');
  }
}

/**
 * GET `/internal/backfill/subjects/:subjectKey` — every stage's verdict on one
 * subject.
 *
 * The trace opens from a SUBJECT KEY and nothing else — `listing:<id>`,
 * `store:<id>`, `product_variant:<id>`. There is deliberately no lookup by
 * seller, by email or by anything about a person: this surface answers "what did
 * the migration do to this row", and a handle that could answer "what did it do
 * to this user's catalogue" is a different question with different privacy
 * consequences (`tracePayment`'s five-handle rule, applied here).
 */
export async function traceBackfillSubjectHandler(req: Request, res: Response): Promise<void> {
  try {
    const subjectKey = routeParam(req, 'subjectKey');
    if (subjectKey.trim() === '') {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A subject key is required', 400);
      return;
    }
    const records = await listBackfillRecordsForSubject(subjectKey);
    sendSuccess(res, { subjectKey, records: records.map(toBackfillRecordDTO) });
  } catch (err) {
    respondWithError(res, err, 'Failed to trace the backfill subject');
  }
}

/** GET `/internal/backfill/findings` — the open consistency findings. */
export async function listConsistencyFindingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;
    const findings = await listOpenConsistencyFindings({ limit });
    sendSuccess(res, { findings: findings.map(toConsistencyFindingDTO) });
  } catch (err) {
    respondWithError(res, err, 'Failed to list consistency findings');
  }
}
