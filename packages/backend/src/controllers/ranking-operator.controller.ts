/**
 * Ranking operator controller (#74) — publish a policy, ramp it, promote it,
 * roll it back, and compare two versions over one input.
 *
 * Every write DRIVES an existing idempotent path, and there is deliberately no
 * "set this offer's rank", no "boost this merchant", no "pin this offer" and no
 * "hide this offer from the comparison". Those are the four shapes a
 * sponsored-placement surface takes, and #74 states that sponsored placement, if
 * it is ever introduced, is a SEPARATE surface that cannot alter this score —
 * so the way to keep that true is for this one to have no route that could.
 * A route test asserts each of those paths 404s.
 *
 * Withdrawing an offer is `/internal/offers/:id/retire` (#57) and suppressing a
 * merchant is the canonical graph's, both already audited. Neither belongs here:
 * they change what EXISTS, and this surface changes only what order the existing
 * things are shown in.
 */

import type { Request, Response } from 'express';
import type { CurrencyCode, OfferComparisonIntent } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import {
  activateRankingPolicyVersion,
  archiveRankingPolicyVersion,
  insertRankingPolicyVersion,
  listRankingPolicyVersions,
  setRankingPolicyCanary,
  stopRankingPolicyCanary,
  type RankingPolicyVersionRow,
} from '../db/ranking/rankingPolicyRepository.js';
import { compareRankings } from '../services/ranking/dominance.js';
import { rankOfferComparison } from '../services/ranking/comparison.service.js';
import { BUILTIN_RANKING_POLICY, OFFER_COMPARISON_POLICY_KEY } from '../services/ranking/policy.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { log } from '../lib/logger.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * A version, as an operator reads it.
 *
 * Names every field explicitly — the `provider_accounts` projection discipline
 * — so a column added later does not reach an operator response by default.
 */
function toPolicyView(row: RankingPolicyVersionRow) {
  return {
    id: row.id,
    policyKey: row.policyKey,
    version: row.version,
    status: row.status,
    description: row.description,
    weights: {
      item_price: row.weightItemPrice,
      delivery_cost: row.weightDeliveryCost,
      tax_inclusion: row.weightTaxInclusion,
      delivery_speed: row.weightDeliverySpeed,
      condition: row.weightCondition,
      merchant_rating: row.weightMerchantRating,
      return_policy: row.weightReturnPolicy,
      availability_confidence: row.weightAvailabilityConfidence,
      observation_freshness: row.weightObservationFreshness,
      verified_relationship: row.weightVerifiedRelationship,
      pickup_proximity: row.weightPickupProximity,
    },
    minReviewCount: row.minReviewCount,
    dominanceWindow: row.dominanceWindow,
    dominanceShare: row.dominanceShare,
    canaryShareBps: row.canaryShareBps,
    objectiveMetricKeys: row.objectiveMetricKeys,
    guardrailMetricKeys: row.guardrailMetricKeys,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdByOxyUserId: row.createdByOxyUserId,
    approvedByOxyUserId: row.approvedByOxyUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /internal/ranking/policies — the key's versions, newest first, with the
 * BUILT-IN one named beside them.
 *
 * The built-in is included because it is a real version an impression can name,
 * and a list that omitted it would leave an operator holding a
 * `ranking_policy_version` no row explains.
 */
export async function listRankingPoliciesHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listRankingPolicyVersions(OFFER_COMPARISON_POLICY_KEY, 100);
    sendSuccess(res, {
      builtin: BUILTIN_RANKING_POLICY,
      canaryEnabled: config.ranking.canaryEnabled,
      versions: rows.map(toPolicyView),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list ranking policy versions');
  }
}

/** POST /internal/ranking/policies — publish a DRAFT. It serves nobody yet. */
export async function createRankingPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      version: string;
      description: string;
      weights: Record<string, number>;
      minReviewCount: number;
      dominanceWindow: number;
      dominanceShare: number;
      objectiveMetricKeys: string[];
      guardrailMetricKeys: string[];
    };
    const actor = catalogOperatorId(req);
    const row = await insertRankingPolicyVersion({
      policyKey: OFFER_COMPARISON_POLICY_KEY,
      version: body.version,
      description: body.description,
      weightItemPrice: body.weights.item_price ?? 0,
      weightDeliveryCost: body.weights.delivery_cost ?? 0,
      weightTaxInclusion: body.weights.tax_inclusion ?? 0,
      weightDeliverySpeed: body.weights.delivery_speed ?? 0,
      weightCondition: body.weights.condition ?? 0,
      weightMerchantRating: body.weights.merchant_rating ?? 0,
      weightReturnPolicy: body.weights.return_policy ?? 0,
      weightAvailabilityConfidence: body.weights.availability_confidence ?? 0,
      weightObservationFreshness: body.weights.observation_freshness ?? 0,
      weightVerifiedRelationship: body.weights.verified_relationship ?? 0,
      weightPickupProximity: body.weights.pickup_proximity ?? 0,
      minReviewCount: body.minReviewCount,
      dominanceWindow: body.dominanceWindow,
      dominanceShare: body.dominanceShare,
      objectiveMetricKeys: body.objectiveMetricKeys,
      guardrailMetricKeys: body.guardrailMetricKeys,
      createdByOxyUserId: actor,
    });
    log.general.info(
      { rankingPolicyVersion: row.version, actor },
      '[Ranking] policy version drafted',
    );
    sendSuccess(res, toPolicyView(row), 201);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to create ranking policy version');
  }
}

/**
 * POST /internal/ranking/policies/:id/canary — start or ramp a canary.
 *
 * One route for both, because the write is one write and the ramp is monotone
 * over subjects: raising the share only ADDS subjects to the canary, so a
 * shopper mid-ramp never watches a product move back to the old order.
 */
export async function canaryRankingPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { shareBps: number };
    const actor = catalogOperatorId(req);
    const row = await setRankingPolicyCanary({
      id: routeParam(req, 'id'),
      shareBps: body.shareBps,
      actorOxyUserId: actor,
    });
    if (row === null) {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'Only a draft or an existing canary can be ramped',
        409,
      );
      return;
    }
    log.general.info(
      { rankingPolicyVersion: row.version, shareBps: body.shareBps, actor },
      '[Ranking] canary share set',
    );
    sendSuccess(res, toPolicyView(row));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to set the ranking canary');
  }
}

/** DELETE /internal/ranking/policies/:id/canary — stop it without promoting it. */
export async function stopRankingCanaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await stopRankingPolicyCanary(routeParam(req, 'id'));
    if (row === null) {
      sendError(res, ErrorCodes.CONFLICT, 'That version is not a canary', 409);
      return;
    }
    log.general.info(
      { rankingPolicyVersion: row.version, actor: catalogOperatorId(req) },
      '[Ranking] canary stopped',
    );
    sendSuccess(res, toPolicyView(row));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to stop the ranking canary');
  }
}

/**
 * POST /internal/ranking/policies/:id/activate — promote, or ROLL BACK.
 *
 * One route for both directions, because they are the same act: activating an
 * earlier version supersedes the current one, and the ordering that results is
 * computed from offers nothing re-ingested. That is acceptance 7 in one call.
 */
export async function activateRankingPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const actor = catalogOperatorId(req);
    const row = await activateRankingPolicyVersion({
      id: routeParam(req, 'id'),
      policyKey: OFFER_COMPARISON_POLICY_KEY,
      actorOxyUserId: actor,
    });
    if (row === null) {
      sendError(res, ErrorCodes.CONFLICT, 'That version cannot be activated', 409);
      return;
    }
    log.general.info(
      { rankingPolicyVersion: row.version, actor },
      '[Ranking] policy version activated',
    );
    sendSuccess(res, toPolicyView(row));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to activate the ranking policy version');
  }
}

/** POST /internal/ranking/policies/:id/archive — retire a draft or a superseded row. */
export async function archiveRankingPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await archiveRankingPolicyVersion(routeParam(req, 'id'));
    if (row === null) {
      sendError(res, ErrorCodes.CONFLICT, 'Only a draft or superseded version can be archived', 409);
      return;
    }
    sendSuccess(res, toPolicyView(row));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to archive the ranking policy version');
  }
}

/**
 * GET /internal/ranking/trace — one comparison in full, exclusions included.
 *
 * `diagnostic` is set, so an offer a freshness contract already retired appears
 * in `excluded` with its reason instead of being dropped by the SQL pre-filter.
 * The public surface deliberately does not do this: a shopper's page budget must
 * not be spent on rows nothing will show.
 */
export async function traceRankingHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      canonicalVariantId?: string;
      canonicalProductId?: string;
      // Optional in the CAST though the schema makes them required: `req.query`
      // is `ParsedQs`, and asserting a required property onto it is the
      // insufficient-overlap error TypeScript raises rather than a fact about
      // the request. `validateQuery` has already run, so the values are there.
      currency?: CurrencyCode;
      intent?: OfferComparisonIntent;
      market?: string;
      policyVersion?: string;
      limit?: number;
    };
    const { comparison } = await rankOfferComparison({
      ...(query.canonicalVariantId ? { canonicalVariantId: query.canonicalVariantId } : {}),
      ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
      comparisonCurrency: query.currency,
      ...(query.intent ? { intent: query.intent } : {}),
      ...(query.market ? { market: query.market.toUpperCase() } : {}),
      ...(query.policyVersion ? { policyVersion: query.policyVersion } : {}),
      diagnostic: true,
      limit: Math.min(query.limit ?? 50, config.pagination.maxPageSize),
    });
    sendSuccess(res, comparison);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace the comparison');
  }
}

/**
 * GET /internal/ranking/compare — two versions, ONE eligible set.
 *
 * The two rankings are computed over the same input, so the diff is caused by
 * the weights and nothing else: no re-ingestion, no second fetch, and no window
 * in which the catalogue could move between them. That is what makes acceptance
 * 7's "compared" a property of the method rather than a caveat on the reading.
 */
export async function compareRankingPoliciesHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      canonicalVariantId?: string;
      canonicalProductId?: string;
      // Optional in the CAST for the reason above; the schema requires all three.
      baselineVersion?: string;
      candidateVersion?: string;
      currency?: CurrencyCode;
      intent?: OfferComparisonIntent;
      market?: string;
      limit?: number;
    };
    const shared = {
      ...(query.canonicalVariantId ? { canonicalVariantId: query.canonicalVariantId } : {}),
      ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
      comparisonCurrency: query.currency,
      ...(query.intent ? { intent: query.intent } : {}),
      ...(query.market ? { market: query.market.toUpperCase() } : {}),
      limit: Math.min(query.limit ?? 50, config.pagination.maxPageSize),
    };

    const baseline = await rankOfferComparison({ ...shared, policyVersion: query.baselineVersion });
    const candidate = await rankOfferComparison({
      ...shared,
      policyVersion: query.candidateVersion,
    });

    // Each side's dominance was already measured against ITS OWN policy's window
    // and threshold, inside the comparison that produced it. Recomputing one
    // side under the other's numbers would hide exactly the change worth seeing
    // — a candidate that widened the window is measuring a different thing, and
    // `newDominance` is what surfaces that.
    sendSuccess(res, {
      baseline: baseline.comparison,
      candidate: candidate.comparison,
      diff: compareRankings({
        baseline: baseline.comparison.offers,
        baselineVersion: baseline.comparison.policy.version,
        candidate: candidate.comparison.offers,
        candidateVersion: candidate.comparison.policy.version,
        baselineDominance: baseline.comparison.dominance,
        candidateDominance: candidate.comparison.dominance,
      }),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to compare ranking policy versions');
  }
}
