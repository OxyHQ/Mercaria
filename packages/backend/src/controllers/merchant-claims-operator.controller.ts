/**
 * The operator review controller for merchant claims (#83).
 *
 * Lives behind `/internal/commerce-graph/claims/*` and therefore behind
 * `requireCatalogOperator` — the canonical-graph allow-list, not the payments
 * one, because who may decide who operates a merchant and who may repair
 * payments are different powers (ADR 0002 D17/D24).
 *
 * The operator is read from the verified credential through
 * `catalogOperatorId`, never from a body field: every decision, revocation and
 * evidence access stamps that id as the ACTOR, and an audit trail naming the
 * wrong person is worse than one that failed to be written.
 */

import type { Request, Response } from 'express';
import type { MerchantClaimRevokeReason, MerchantClaimState } from '@mercaria/shared-types';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  decideClaim,
  getClaimForOperator,
  listClaimsForReview,
  revokeClaim,
  toMerchantClaimDTO,
} from '../services/merchant-claims/merchant-claim.service.js';
import { findScopesForClaim } from '../db/merchant-claims/merchantClaimRepository.js';
import { getDb } from '../db/postgres.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * The states an operator queue can be filtered to. Both are "waiting on a
 * person"; a queue that could be filtered to `verified` would be a directory
 * of every merchant's operator rather than a work list.
 */
const QUEUE_STATES: readonly MerchantClaimState[] = ['review_pending', 'disputed'];

/** GET /internal/commerce-graph/claims — the review queue, oldest first. */
export async function listClaimQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const requested = typeof req.query.state === 'string' ? req.query.state : undefined;
    const states = QUEUE_STATES.filter((state) => requested === undefined || state === requested);
    sendSuccess(res, await listClaimsForReview(states));
  } catch (error) {
    respondWithError(res, error, 'Listing the merchant claim queue failed');
  }
}

/**
 * GET /internal/commerce-graph/claims/:id — the full review view.
 *
 * Reading this writes an `evidence_accessed` audit row before the evidence is
 * returned (issue security control 6): the trace must not depend on the
 * request finishing.
 */
export async function getClaimForOperatorHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await getClaimForOperator(routeParam(req, 'id'), catalogOperatorId(req)),
    );
  } catch (error) {
    respondWithError(res, error, 'Reading the merchant claim failed');
  }
}

/** POST /internal/commerce-graph/claims/:id/decision — verify or reject. */
export async function decideClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { decision: 'verify' | 'reject'; reason: string };
    const claim = await decideClaim({
      claimId: routeParam(req, 'id'),
      decision: body.decision,
      reason: body.reason,
      operatorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toMerchantClaimDTO(claim, await findScopesForClaim(getDb(), claim.id)));
  } catch (error) {
    respondWithError(res, error, 'Deciding the merchant claim failed');
  }
}

/** POST /internal/commerce-graph/claims/:id/revoke — withdraw a verification. */
export async function revokeClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: MerchantClaimRevokeReason; note: string };
    const claim = await revokeClaim({
      claimId: routeParam(req, 'id'),
      reason: body.reason,
      note: body.note,
      operatorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toMerchantClaimDTO(claim, await findScopesForClaim(getDb(), claim.id)));
  } catch (error) {
    respondWithError(res, error, 'Revoking the merchant claim failed');
  }
}
