/**
 * The claimant-facing merchant-claim controller (#83).
 *
 * Thin, like every controller here: the state machine, the scope rules and the
 * refusals live in `services/merchant-claims/`. Two things ARE this layer's
 * job and neither is cosmetic.
 *
 * **The claimant is read from the verified credential, never from the body.**
 * `getRequiredOxyUserId` is the only source of the actor on every route below,
 * so no field a client can send names who is claiming — the mass-assignment /
 * IDOR rule, applied to the one id that decides who ends up operating a
 * merchant.
 *
 * **A secret in a request body leaves in the service's frame.** The verify
 * handler forwards `token` and `channelKey` straight through and never logs
 * them; the error path is `respondWithError`, which emits the service's own
 * message and never the request.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { MerchantClaimMethod } from '@mercaria/shared-types';
import {
  contestClaim,
  getClaimForClaimant,
  issueChallenge,
  listClaimsForClaimant,
  openClaim,
  submitForReview,
  toMerchantClaimDTO,
  verifyClaim,
} from '../services/merchant-claims/merchant-claim.service.js';
import { findScopesForClaim } from '../db/merchant-claims/merchantClaimRepository.js';
import { getDb } from '../db/postgres.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
// Discovery analytics (#77) — the emitter only.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';

/** One evidence reference as the `.strict()` schemas admit it. */
interface EvidenceInput {
  oxyFileId?: string;
  sha256?: string;
  note?: string;
  url?: string;
}

/** POST /merchant-claims — open a claim on a merchant. */
export async function openClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      merchantId: string;
      method: MerchantClaimMethod;
      domain?: string;
      connectionId?: string;
      storefrontIds?: string[];
      nativeStoreId?: string;
    };
    const claim = await openClaim({
      merchantId: body.merchantId,
      claimantOxyUserId: getRequiredOxyUserId(req),
      method: body.method,
      ...(body.domain !== undefined ? { domain: body.domain } : {}),
      ...(body.connectionId !== undefined ? { connectionId: body.connectionId } : {}),
      ...(body.storefrontIds !== undefined ? { storefrontIds: body.storefrontIds } : {}),
      ...(body.nativeStoreId !== undefined ? { nativeStoreId: body.nativeStoreId } : {}),
    });
    // #77 discovery event 12. Emitted after `openClaim` returns, so a refusal
    // (an unavailable method, an ineligible merchant, a claim already in
    // progress) is not counted as an entry — the merchant-claim funnel's
    // denominator must be attempts that actually opened a claim.
    emitAnalyticsEvent(req, {
      eventType: 'merchant_claim_entry',
      entities: { merchantId: claim.merchantId },
    });
    sendSuccess(res, toMerchantClaimDTO(claim, await findScopesForClaim(getDb(), claim.id)), 201);
  } catch (error) {
    respondWithError(res, error, 'Opening the merchant claim failed');
  }
}

/**
 * POST /merchant-claims/:id/challenge — issue a challenge.
 *
 * The one-time token is in this response and in no other, ever. 201 rather
 * than 200 because a challenge is a resource that did not exist before.
 */
export async function issueChallengeHandler(req: Request, res: Response): Promise<void> {
  try {
    const instructions = await issueChallenge({
      claimId: routeParam(req, 'id'),
      claimantOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, instructions, 201);
  } catch (error) {
    respondWithError(res, error, 'Issuing the verification challenge failed');
  }
}

/** POST /merchant-claims/:id/verify — attempt the proof. */
export async function verifyClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { token?: string; channelKey?: string };
    const claim = await verifyClaim({
      claimId: routeParam(req, 'id'),
      claimantOxyUserId: getRequiredOxyUserId(req),
      ...(body.token !== undefined ? { token: body.token } : {}),
      ...(body.channelKey !== undefined ? { channelKey: body.channelKey } : {}),
    });
    sendSuccess(res, toMerchantClaimDTO(claim, await findScopesForClaim(getDb(), claim.id)));
  } catch (error) {
    respondWithError(res, error, 'Verifying the merchant claim failed');
  }
}

/** POST /merchant-claims/:id/submit — send a document claim to review. */
export async function submitClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { evidence: EvidenceInput[] };
    const claim = await submitForReview({
      claimId: routeParam(req, 'id'),
      claimantOxyUserId: getRequiredOxyUserId(req),
      evidence: body.evidence,
    });
    sendSuccess(res, toMerchantClaimDTO(claim, await findScopesForClaim(getDb(), claim.id)));
  } catch (error) {
    respondWithError(res, error, 'Submitting the merchant claim failed');
  }
}

/** POST /merchant-claims/contest — contest an incorrect existing claim. */
export async function contestClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { merchantId: string; reason: string; evidence?: EvidenceInput[] };
    const claim = await contestClaim({
      merchantId: body.merchantId,
      claimantOxyUserId: getRequiredOxyUserId(req),
      reason: body.reason,
      ...(body.evidence !== undefined ? { evidence: body.evidence } : {}),
    });
    sendSuccess(res, toMerchantClaimDTO(claim, await findScopesForClaim(getDb(), claim.id)), 201);
  } catch (error) {
    respondWithError(res, error, 'Contesting the merchant claim failed');
  }
}

/** GET /merchant-claims — the caller's own claims. */
export async function listMyClaimsHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listClaimsForClaimant(getRequiredOxyUserId(req)));
  } catch (error) {
    respondWithError(res, error, 'Listing your merchant claims failed');
  }
}

/** GET /merchant-claims/:id — state polling; no evidence, ever. */
export async function getMyClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await getClaimForClaimant(routeParam(req, 'id'), getRequiredOxyUserId(req)),
    );
  } catch (error) {
    respondWithError(res, error, 'Reading the merchant claim failed');
  }
}
