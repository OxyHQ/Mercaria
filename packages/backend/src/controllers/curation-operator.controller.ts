/**
 * The catalogue-curation operator surface (#59).
 *
 * The review queue, the merge and split jobs, the corrections and the timeline,
 * behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54, #55, #56, #57
 * and #83 use — deciding that two things are one thing is the same power over
 * the same graph as linking a merchant to a store, and a sixth list would be a
 * sixth thing to keep in step for a separation it does not have.
 *
 * What is deliberately absent, and why each absence is load-bearing:
 *
 * - **No "force" on anything.** A merge cannot skip its conflict gate, a phase
 *   cannot be marked done, a job cannot be moved to a phase. Every one of those
 *   is a way to reach a half-merged entity from an HTTP request.
 * - **No delete, anywhere.** A wrong merge is undone by a SPLIT and a wrong
 *   suppression by a LIFT; both leave the record of what happened. There is no
 *   endpoint whose effect is that a row stops existing.
 * - **No impact figure the caller supplies.** The four-eyes threshold reads the
 *   stored estimate, and the estimate is computed from the graph — a caller who
 *   could post one could approve their own large merge as a small one.
 */

import type { Request, Response } from 'express';
import { estimateMergeImpact, impactFromColumns } from '../services/curation/impact.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import {
  findMergeJobById,
  findSplitJobById,
  listConflicts,
  listMergeJobs,
  listMergePhases,
  listSplitAssignments,
  listSplitJobs,
} from '../db/curation/jobRepository.js';
import {
  findRevisionsForEntity,
  findRevisionsForJob,
} from '../db/curation/curationRepository.js';
import {
  approveMerge,
  mergeJobBlockingState,
  requestMerge,
  resolveMergeConflict,
} from '../services/curation/merge.service.js';
import { approveSplit, requestSplit } from '../services/curation/split.service.js';
import {
  claimItem,
  getItemWithContext,
  listQueue,
  queueSummary,
  raiseReviewItem,
  releaseItem,
  resolveItem,
  runAllDetectors,
} from '../services/curation/review-queue.service.js';
import {
  liftEntitySuppression,
  reassignIdentifier,
  selectAttributeValue,
  suppressEntity,
  suppressionHistory,
} from '../services/curation/correction.service.js';
import { recordCompensation } from '../services/curation/revision.js';
import { drainCurationJobs } from '../services/curation/curation-dispatcher.js';
import type {
  CatalogSuppressibleType,
  CatalogSuppressionReason,
  CurationResolution,
  CurationReviewKind,
  CurationReviewState,
  CurationSubjectType,
  MergeableEntityType,
  SplittableEntityType,
} from '@mercaria/shared-types';
import type { CatalogMergeJobRow, CatalogSplitJobRow } from '../db/schema/curation.js';

/**
 * The typed body every handler reads.
 *
 * `validateBody` has already parsed the request against a `.strict()` schema, so
 * these casts describe what the middleware guaranteed rather than what the
 * client sent — the pattern every operator controller in this codebase uses.
 */
function body<T>(req: Request): T {
  return req.body as T;
}

/** A merge job as the operator surface projects it. */
function toMergeJobView(row: CatalogMergeJobRow) {
  return {
    id: row.id,
    entityType: row.entityType,
    loserId: row.loserId,
    winnerId: row.winnerId,
    status: row.status,
    phase: row.phase,
    attempts: row.attempts,
    reason: row.reason,
    requestedByOxyUserId: row.requestedByOxyUserId,
    approvedByOxyUserId: row.approvedByOxyUserId,
    requiresSecondApproval: row.requiresSecondApproval,
    parentJobId: row.parentJobId,
    impact: impactFromColumns(row),
    lastError: row.lastError,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** A split job as the operator surface projects it. */
function toSplitJobView(row: CatalogSplitJobRow) {
  return {
    id: row.id,
    entityType: row.entityType,
    sourceEntityId: row.sourceEntityId,
    targetMode: row.targetMode,
    targetEntityId: row.targetEntityId,
    targetSlug: row.targetSlug,
    status: row.status,
    phase: row.phase,
    attempts: row.attempts,
    reason: row.reason,
    requestedByOxyUserId: row.requestedByOxyUserId,
    approvedByOxyUserId: row.approvedByOxyUserId,
    requiresSecondApproval: row.requiresSecondApproval,
    reversesMergeJobId: row.reversesMergeJobId,
    impact: impactFromColumns(row),
    lastError: row.lastError,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

// ── The review queue ───────────────────────────────────────────────────────

export async function listReviewQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      kind?: CurationReviewKind;
      state?: CurationReviewState;
      assignedToOxyUserId?: string;
      limit?: number;
    };
    const items = await listQueue({
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.assignedToOxyUserId ? { assignedToOxyUserId: query.assignedToOxyUserId } : {}),
      limit: query.limit ?? 50,
    });
    sendSuccess(res, { items, summary: await queueSummary() });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the review queue');
  }
}

export async function getReviewItemHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getItemWithContext(routeParam(req, 'id')));
  } catch (err) {
    respondWithError(res, err, 'Failed to read the review item');
  }
}

export async function raiseReviewItemHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{
      kind: CurationReviewKind;
      subjectType: CurationSubjectType;
      subjectId: string;
      counterpartType?: CurationSubjectType;
      counterpartId?: string;
      note: string;
    }>(req);
    sendSuccess(
      res,
      await raiseReviewItem({ ...input, actorOxyUserId: catalogOperatorId(req) }),
      201,
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to raise the review item');
  }
}

export async function claimReviewItemHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await claimItem(routeParam(req, 'id'), catalogOperatorId(req)));
  } catch (err) {
    respondWithError(res, err, 'Failed to claim the review item');
  }
}

export async function releaseReviewItemHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await releaseItem(routeParam(req, 'id'), catalogOperatorId(req)));
  } catch (err) {
    respondWithError(res, err, 'Failed to release the review item');
  }
}

export async function resolveReviewItemHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ resolution: CurationResolution; reason: string }>(req);
    sendSuccess(
      res,
      await resolveItem({
        id: routeParam(req, 'id'),
        resolution: input.resolution,
        reason: input.reason,
        actorOxyUserId: catalogOperatorId(req),
      }),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to resolve the review item');
  }
}

/** Run every detector once. The same code path the schedule takes. */
export async function runDetectorsHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ limit?: number }>(req);
    sendSuccess(res, { scans: await runAllDetectors(input.limit) });
  } catch (err) {
    respondWithError(res, err, 'Failed to run the curation detectors');
  }
}

// ── Merge ──────────────────────────────────────────────────────────────────

/**
 * The IMPACT PREVIEW (#59 security 2).
 *
 * A read, deliberately: an operator sees the size of what they are about to do
 * BEFORE a job exists, so deciding not to proceed leaves nothing behind.
 */
export async function previewMergeImpactHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as { entityType: MergeableEntityType; entityId: string };
    sendSuccess(res, {
      entityType: query.entityType,
      entityId: query.entityId,
      impact: await estimateMergeImpact(query.entityType, query.entityId),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to estimate the merge impact');
  }
}

export async function requestMergeHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{
      entityType: MergeableEntityType;
      loserId: string;
      winnerId: string;
      reason: string;
      reviewItemId?: string;
    }>(req);
    const job = await requestMerge({
      entityType: input.entityType,
      loserId: input.loserId,
      winnerId: input.winnerId,
      reason: input.reason,
      reviewItemId: input.reviewItemId ?? null,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toMergeJobView(job), 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to open the merge job');
  }
}

export async function listMergeJobsHandler(req: Request, res: Response): Promise<void> {
  try {
    const jobs = await listMergeJobs({ limit: 100 }, getDb());
    sendSuccess(res, { jobs: jobs.map(toMergeJobView) });
  } catch (err) {
    respondWithError(res, err, 'Failed to list merge jobs');
  }
}

/** One job, its conflicts, its phase progress and every revision it wrote. */
export async function getMergeJobHandler(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const id = routeParam(req, 'id');
    const job = await findMergeJobById(id, db);
    if (!job) {
      sendSuccess(res, null, 404);
      return;
    }
    sendSuccess(res, {
      job: toMergeJobView(job),
      /**
       * What this job is waiting on RIGHT NOW, derived (#663).
       *
       * `lastError` is what was true when the job blocked and is not refreshed
       * afterwards, so on its own it cannot tell an operator whether the thing
       * they are looking at will resume by itself on the next dispatcher pass
       * or is waiting on them. This is the same predicate the sweep evaluates,
       * so what it reports is exactly what will happen.
       *
       * It is deliberately a READ and there is no route beside it that acts on
       * the answer: when the state is `clear` the sweep has already scheduled
       * the resume, and when it is `blocked` a "resume" control could only
       * re-block, which is a button that teaches an operator they fixed
       * something they did not.
       */
      blocking: job.status === 'blocked' ? await mergeJobBlockingState(job, db) : null,
      conflicts: await listConflicts(id, db),
      phases: await listMergePhases(id, db),
      revisions: await findRevisionsForJob({ mergeJobId: id }, db),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the merge job');
  }
}

export async function approveMergeHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ reason: string }>(req);
    sendSuccess(
      res,
      toMergeJobView(await approveMerge(routeParam(req, 'id'), catalogOperatorId(req), input.reason)),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to approve the merge job');
  }
}

export async function resolveConflictHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ resolution: 'keep_winner' | 'keep_loser' | 'merge_pair'; reason: string }>(req);
    sendSuccess(
      res,
      await resolveMergeConflict({
        conflictId: routeParam(req, 'conflictId'),
        resolution: input.resolution,
        reason: input.reason,
        actorOxyUserId: catalogOperatorId(req),
      }),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to resolve the merge conflict');
  }
}

// ── Split ──────────────────────────────────────────────────────────────────

export async function requestSplitHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{
      entityType: SplittableEntityType;
      sourceEntityId: string;
      targetMode: 'revive_tombstone' | 'new_entity';
      targetEntityId?: string;
      targetSlug?: string;
      targetName?: string;
      reason: string;
      reversesMergeJobId?: string;
      reviewItemId?: string;
      items: { itemType: never; itemRef: string }[];
    }>(req);
    const job = await requestSplit({
      entityType: input.entityType,
      sourceEntityId: input.sourceEntityId,
      targetMode: input.targetMode,
      targetEntityId: input.targetEntityId ?? null,
      targetSlug: input.targetSlug ?? null,
      targetName: input.targetName ?? null,
      reason: input.reason,
      reversesMergeJobId: input.reversesMergeJobId ?? null,
      reviewItemId: input.reviewItemId ?? null,
      items: input.items,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toSplitJobView(job), 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to open the split job');
  }
}

export async function listSplitJobsHandler(req: Request, res: Response): Promise<void> {
  try {
    const jobs = await listSplitJobs({ limit: 100 }, getDb());
    sendSuccess(res, { jobs: jobs.map(toSplitJobView) });
  } catch (err) {
    respondWithError(res, err, 'Failed to list split jobs');
  }
}

export async function getSplitJobHandler(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const id = routeParam(req, 'id');
    const job = await findSplitJobById(id, db);
    if (!job) {
      sendSuccess(res, null, 404);
      return;
    }
    sendSuccess(res, {
      job: toSplitJobView(job),
      assignments: await listSplitAssignments(id, db),
      revisions: await findRevisionsForJob({ splitJobId: id }, db),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the split job');
  }
}

export async function approveSplitHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ reason: string }>(req);
    sendSuccess(
      res,
      toSplitJobView(await approveSplit(routeParam(req, 'id'), catalogOperatorId(req), input.reason)),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to approve the split job');
  }
}

/** Run one batch of jobs now. The dispatcher's own drain, on demand. */
export async function drainCurationJobsHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ batchSize?: number }>(req);
    sendSuccess(res, await drainCurationJobs(input.batchSize ?? 5));
  } catch (err) {
    respondWithError(res, err, 'Failed to drain the curation jobs');
  }
}

// ── Corrections ────────────────────────────────────────────────────────────

export async function reassignIdentifierHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ targetProductId?: string; targetVariantId?: string; reason: string }>(req);
    await reassignIdentifier({
      identifierId: routeParam(req, 'id'),
      targetProductId: input.targetProductId ?? null,
      targetVariantId: input.targetVariantId ?? null,
      reason: input.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, { reassigned: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to reassign the identifier');
  }
}

export async function selectAttributeValueHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ reason: string }>(req);
    await selectAttributeValue({
      valueId: routeParam(req, 'id'),
      reason: input.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, { selected: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to select the attribute value');
  }
}

export async function suppressEntityHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{
      entityType: CatalogSuppressibleType;
      entityId: string;
      reason: CatalogSuppressionReason;
      note?: string;
    }>(req);
    await suppressEntity({
      entityType: input.entityType,
      entityId: input.entityId,
      reason: input.reason,
      note: input.note ?? null,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, { suppressed: true }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to suppress the entity');
  }
}

export async function liftSuppressionHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ entityType: CatalogSuppressibleType; entityId: string; reason: string }>(req);
    await liftEntitySuppression({ ...input, actorOxyUserId: catalogOperatorId(req) });
    sendSuccess(res, { lifted: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to lift the suppression');
  }
}

// ── The timeline ───────────────────────────────────────────────────────────

/** Every action ever taken on one entity, newest first (#59 acceptance 4). */
export async function listRevisionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      entityType: CurationSubjectType;
      entityId: string;
      limit?: number;
    };
    const db = getDb();
    sendSuccess(res, {
      revisions: await findRevisionsForEntity(query.entityType, query.entityId, query.limit ?? 100, db),
      suppressions:
        query.entityType === 'offer' ||
        query.entityType === 'organization' ||
        query.entityType === 'brand' ||
        query.entityType === 'merchant' ||
        query.entityType === 'storefront' ||
        query.entityType === 'canonical_product_family' ||
        query.entityType === 'canonical_product' ||
        query.entityType === 'canonical_variant'
          ? await suppressionHistory(query.entityType, query.entityId)
          : [],
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the revision timeline');
  }
}

/** Record a compensating correction against one revision (#59 operator action 10). */
export async function compensateRevisionHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<{ reason: string; note?: string }>(req);
    sendSuccess(
      res,
      await recordCompensation({
        revisionId: routeParam(req, 'id'),
        reason: input.reason,
        ...(input.note === undefined ? {} : { note: input.note }),
        actorOxyUserId: catalogOperatorId(req),
      }),
      201,
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to record the compensating correction');
  }
}
