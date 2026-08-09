/**
 * The matching operator surface (#58 operations 5, match record 7 and 10).
 *
 * Reads, three policy actions, two review actions and two triggers. Every
 * TRIGGER drives a path that already exists and is already idempotent — the
 * dispatcher's own drain, the sweep's own page, the pipeline's own evaluation —
 * so this surface adds a button and no second way for a match to come into
 * being.
 *
 * What is deliberately absent, and why each absence is load-bearing:
 *
 * - **No "set outcome".** An operator cannot post a decision. They can REJECT a
 *   pair (which the pipeline then honours forever) and they can answer a review.
 *   A route that wrote an outcome would be a way to record a merge no evidence
 *   supports, and it would bypass every CHECK the decision row carries.
 * - **No "create canonical product".** `create_new` is a recommendation for #60.
 * - **No "clear the queue".** A dead-lettered row is a subject the pipeline
 *   cannot evaluate, and deleting it hides the problem rather than fixing it.
 */

import type { Request, Response } from 'express';
import type {
  MatchBlocker,
  MatchCandidateView,
  MatchDecisionView,
  MatchQueueMetrics,
  MatchReasonCode,
  MatchSubjectKind,
  MatchSweepJob,
} from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import {
  findMatchDecisionById,
  listMatchDecisionCandidates,
  listMatchDecisionsForSubject,
  listPendingMatchReviews,
  recordMatchReview,
  summarizeDecisions,
  type MatchDecisionCandidateRow,
  type MatchDecisionRow,
} from '../db/matching/matchDecisionRepository.js';
import {
  findActiveMatchPolicyVersion,
  findMatchPolicyVersionById,
  listCategoryGates,
  listMatchPolicyVersions,
} from '../db/matching/matchPolicyRepository.js';
import { listBlocksForSubject } from '../db/matching/matchBlockedPairRepository.js';
import { summarizeMatchQueue } from '../db/matching/matchQueueRepository.js';
import { listSweepCursors } from '../db/matching/matchSweepRepository.js';
import {
  listBenchmarkRuns,
  listBenchmarkSlices,
} from '../db/matching/matchBenchmarkRepository.js';
import {
  activateMatchPolicy,
  clearRejectedPair,
  closeGate,
  createMatchPolicyVersion,
  openCategoryGate,
  rejectMatchPair,
} from '../services/matching/match-policy.service.js';
import { drainMatchQueue } from '../services/matching/match-queue-dispatcher.js';
import { runMatchSweepPage } from '../services/matching/match-sweep.service.js';
import { runMatch } from '../services/matching/match.service.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** A stored candidate row as an operator reads it — NULLs preserved. */
function toCandidateView(row: MatchDecisionCandidateRow): MatchCandidateView {
  const features: Record<string, number> = {};
  // Every NULL stays ABSENT rather than becoming a zero. An operator has to be
  // able to tell "brand agreement was unknown" from "the brands disagreed",
  // because those two justify opposite corrections.
  if (row.identifierAgreement !== null) features.identifierAgreement = row.identifierAgreement;
  if (row.brandAgreement !== null) features.brandAgreement = row.brandAgreement;
  if (row.modelAgreement !== null) features.modelAgreement = row.modelAgreement;
  if (row.attributeAgreement !== null) features.attributeAgreement = row.attributeAgreement;
  if (row.titleSimilarity !== null) features.titleSimilarity = row.titleSimilarity;
  if (row.categoryAgreement !== null) features.categoryAgreement = row.categoryAgreement;
  if (row.semanticSimilarity !== null) features.semanticSimilarity = row.semanticSimilarity;

  return {
    canonicalProductId: row.canonicalProductId,
    canonicalVariantId: row.canonicalVariantId,
    rank: row.rank,
    score: row.score,
    selected: row.selected,
    rejection: row.rejection,
    features,
  };
}

function toDecisionView(
  row: MatchDecisionRow,
  policyVersionKey: string,
  candidates: readonly MatchDecisionCandidateRow[],
): MatchDecisionView {
  return {
    id: row.id,
    subjectKind: row.subjectKind,
    subjectKey: row.subjectKey,
    sourceRecordId: row.sourceRecordId,
    productVariantId: row.productVariantId,
    policyVersionId: row.policyVersionId,
    policyVersionKey,
    outcome: row.outcome,
    decidedStage: row.decidedStage,
    confidence: row.confidence,
    matchedCanonicalProductId: row.matchedCanonicalProductId,
    matchedCanonicalVariantId: row.matchedCanonicalVariantId,
    reasonCodes: row.reasonCodes as MatchReasonCode[],
    blockers: row.blockers as MatchBlocker[],
    positiveIdentifiers: row.positiveIdentifiers,
    conflictingIdentifiers: row.conflictingIdentifiers,
    normalizedBrand: row.normalizedBrand,
    normalizedModel: row.normalizedModel,
    normalizedTitle: row.normalizedTitle,
    categoryKey: row.categoryKey,
    reviewState: row.reviewState,
    reviewedByOxyUserId: row.reviewedByOxyUserId,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    evaluationCount: row.evaluationCount,
    createdAt: row.createdAt.toISOString(),
    lastEvaluatedAt: row.lastEvaluatedAt.toISOString(),
    candidates: candidates.map(toCandidateView),
  };
}

/**
 * GET /internal/matching/metrics — queue age and ambiguity rate (operations 5).
 *
 * Age rather than depth is the number that distinguishes "a bulk sweep is
 * running" from "the dispatcher stopped an hour ago": same depth, opposite
 * urgency. The ambiguity rate is measured against the ACTIVE policy only, since
 * comparing it across policies is comparing two different rules.
 */
export async function matchMetricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const queue = await summarizeMatchQueue(db);
    const policy = await findActiveMatchPolicyVersion(db);
    const decisions = policy
      ? await summarizeDecisions(db, policy.id)
      : { total: 0, ambiguous: 0, pendingReview: 0 };

    const metrics: MatchQueueMetrics = {
      pending: queue.pending,
      processing: queue.processing,
      done: queue.done,
      deadLetter: queue.deadLetter,
      oldestPendingAgeSeconds: queue.oldestPendingAgeSeconds,
      // A rate over zero decisions is NULL, never zero: "nothing has been
      // decided" and "nothing was ambiguous" are different facts, and an alert
      // that cannot tell them apart fires on an empty deployment.
      ambiguityRate: decisions.total === 0 ? null : decisions.ambiguous / decisions.total,
      manualReviewRate: decisions.total === 0 ? null : decisions.pendingReview / decisions.total,
      decisionsUnderActivePolicy: decisions.total,
    };
    sendSuccess(res, { metrics, sweeps: await listSweepCursors(db) });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read matching metrics');
  }
}

/** GET /internal/matching/decisions/:id — one decision, with every candidate. */
export async function traceMatchDecisionHandler(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const decision = await findMatchDecisionById(db, routeParam(req, 'id'));
    if (!decision) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Match decision not found', 404);
      return;
    }
    const policy = await findMatchPolicyVersionById(db, decision.policyVersionId);
    const candidates = await listMatchDecisionCandidates(db, decision.id);
    sendSuccess(res, {
      decision: toDecisionView(decision, policy?.versionKey ?? 'unknown', candidates),
      blocks: await listBlocksForSubject(db, decision.subjectKey),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace match decision');
  }
}

/**
 * GET /internal/matching/subjects/:subjectKey — every decision about one thing.
 *
 * The trace that survives re-observation: a source republishing a product mints
 * a new `source_records` row, and the STABLE subject key is what keeps the
 * history of decisions about that product together.
 */
export async function traceMatchSubjectHandler(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const subjectKey = routeParam(req, 'subjectKey');
    const decisions = await listMatchDecisionsForSubject(db, subjectKey);
    sendSuccess(res, {
      subjectKey,
      decisions,
      blocks: await listBlocksForSubject(db, subjectKey),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace match subject');
  }
}

/** GET /internal/matching/reviews — #59's inbox, oldest first. */
export async function listMatchReviewsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const policy = await findActiveMatchPolicyVersion(db);
    sendSuccess(res, {
      reviews: await listPendingMatchReviews(db, {
        ...(policy ? { policyVersionId: policy.id } : {}),
        limit: 100,
      }),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list match reviews');
  }
}

/** POST /internal/matching/decisions/:id/review — answer one review. */
export async function reviewMatchDecisionHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { verdict: 'approved' | 'rejected'; note: string };
    const updated = await recordMatchReview(getDb(), {
      id: routeParam(req, 'id'),
      state: body.verdict,
      reviewedByOxyUserId: catalogOperatorId(req),
      note: body.note,
      now: new Date(),
    });
    if (!updated) {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'That decision is not awaiting review; somebody may have answered it already.',
        409,
      );
      return;
    }
    sendSuccess(res, { decision: updated });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to record match review');
  }
}

/** GET /internal/matching/policies — every version, newest first. */
export async function listMatchPoliciesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const policies = await listMatchPolicyVersions(db);
    const active = policies.find((policy) => policy.status === 'active');
    sendSuccess(res, {
      policies,
      gates: active === undefined ? [] : await listCategoryGates(db, active.id),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list match policies');
  }
}

/** POST /internal/matching/policies — draft a version. Drafts are editable. */
export async function createMatchPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, number | string | boolean>;
    const policy = await createMatchPolicyVersion({
      versionKey: String(body.versionKey),
      description: String(body.description),
      autoMinConfidence: Number(body.autoMinConfidence),
      reviewMinConfidence: Number(body.reviewMinConfidence),
      minCandidateSeparation: Number(body.minCandidateSeparation),
      maxCandidates: Number(body.maxCandidates),
      minTitleSimilarity: Number(body.minTitleSimilarity),
      weightIdentifier: Number(body.weightIdentifier),
      weightBrand: Number(body.weightBrand),
      weightModel: Number(body.weightModel),
      weightAttribute: Number(body.weightAttribute),
      weightTitle: Number(body.weightTitle),
      weightCategory: Number(body.weightCategory),
      weightSemantic: body.weightSemantic === undefined ? 0 : Number(body.weightSemantic),
      semanticEnabled: body.semanticEnabled === true,
      minBenchmarkPrecision: Number(body.minBenchmarkPrecision),
      minBenchmarkSamples: Number(body.minBenchmarkSamples),
      createdByOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, { policy }, 201);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to create match policy version');
  }
}

/** POST /internal/matching/policies/:id/activate — freeze it and make it live. */
export async function activateMatchPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, { policy: await activateMatchPolicy(routeParam(req, 'id')) });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to activate match policy version');
  }
}

/** POST /internal/matching/gates — enable automatic matching for one category. */
export async function openCategoryGateHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      policyVersionId: string;
      categoryKey: string;
      benchmarkCategoryId: string;
      reason: string;
    };
    const gate = await openCategoryGate({
      policyVersionId: body.policyVersionId,
      categoryKey: body.categoryKey,
      benchmarkCategoryId: body.benchmarkCategoryId,
      enabledByOxyUserId: catalogOperatorId(req),
      reason: body.reason,
    });
    sendSuccess(res, { gate }, 201);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to open category gate');
  }
}

/** POST /internal/matching/gates/:id/close — disable it, attributably. */
export async function closeCategoryGateHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    await closeGate({
      gateId: routeParam(req, 'id'),
      disabledByOxyUserId: catalogOperatorId(req),
      reason: body.reason,
    });
    sendSuccess(res, { closed: true });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to close category gate');
  }
}

/** POST /internal/matching/blocked-pairs — this pair is wrong, forever. */
export async function rejectMatchPairHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      subjectKey: string;
      subjectKind: MatchSubjectKind;
      targetCanonicalProductId?: string;
      targetCanonicalVariantId?: string;
      decisionId: string;
      reason: string;
    };
    const blocked = await rejectMatchPair({
      subjectKey: body.subjectKey,
      subjectKind: body.subjectKind,
      targetCanonicalProductId: body.targetCanonicalProductId ?? null,
      targetCanonicalVariantId: body.targetCanonicalVariantId ?? null,
      decisionId: body.decisionId,
      blockedByOxyUserId: catalogOperatorId(req),
      reason: body.reason,
    });
    sendSuccess(res, { blockedPair: blocked }, 201);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to block match pair');
  }
}

/** POST /internal/matching/blocked-pairs/:id/clear — new evidence arrived. */
export async function clearBlockedPairHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const cleared = await clearRejectedPair({
      blockedPairId: routeParam(req, 'id'),
      clearedByOxyUserId: catalogOperatorId(req),
      reason: body.reason,
    });
    sendSuccess(res, { blockedPair: cleared });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to clear blocked pair');
  }
}

/** POST /internal/matching/evaluate — run ONE subject now. */
export async function evaluateSubjectHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { productVariantId?: string; sourceRecordId?: string };
    const result =
      body.productVariantId === undefined
        ? await runMatch({
            kind: 'source_record',
            sourceRecordId: body.sourceRecordId ?? '',
          })
        : await runMatch({ kind: 'native_variant', productVariantId: body.productVariantId });
    sendSuccess(res, {
      subjectKey: result.subjectKey,
      decision: result.decision,
      attached: result.attached,
      skipped: result.skipped,
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to evaluate subject');
  }
}

/** POST /internal/matching/drain — run one queue batch now. */
export async function drainMatchQueueHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await drainMatchQueue());
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to drain match queue');
  }
}

/** POST /internal/matching/sweep — enqueue ONE bounded page of a bulk pass. */
export async function runMatchSweepHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { job: MatchSweepJob; limit?: number };
    const page = await runMatchSweepPage(body.job, {
      ...(body.limit === undefined ? {} : { limit: body.limit }),
    });
    if (page === undefined) {
      // Not an error, and deliberately distinguishable from a completed pass:
      // "somebody else is sweeping" and "there was nothing left" are different
      // operational facts, and there may also be no active policy to sweep for.
      sendSuccess(res, { claimed: false });
      return;
    }
    sendSuccess(res, { claimed: true, ...page });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to run match sweep');
  }
}

/** GET /internal/matching/benchmarks — every recorded run and its slices. */
export async function listBenchmarkRunsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const runs = await listBenchmarkRuns(db);
    const newest = runs[0];
    sendSuccess(res, {
      runs,
      slices: newest === undefined ? [] : await listBenchmarkSlices(db, newest.id),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list benchmark runs');
  }
}
