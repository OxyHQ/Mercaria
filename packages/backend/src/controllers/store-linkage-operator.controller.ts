/**
 * The operator-facing linkage controller (#84), behind the SAME
 * `CATALOG_OPERATOR_OXY_USER_IDS` gate #54, #55, #56 and #83 use.
 *
 * Deciding which native store a canonical merchant resolves to is the same power
 * as deciding who operates that merchant, over the same graph — so it belongs on
 * the same allow-list rather than on a fourth one to keep in step.
 *
 * ## The composition this file performs, and why it lives HERE
 *
 * {@link revokeClaimAndUnlinkHandler} does two audited things in a row: it
 * revokes the merchant claim (#83) and then removes the management linkage the
 * claim authorized (#84, revocation rule 1). It is composed at this layer and
 * not inside `revokeClaim` because `services/merchant-claims/` may not so much
 * as NAME `native_store_links` — `relationship-isolation.test.ts` fails the
 * build if it does, and that rule is right: a claim must not be able to grant or
 * withdraw operational access as a side effect of proving a domain.
 *
 * So the two acts stay two acts, each with its own record, its own actor and its
 * own reason, composed in the order a person would do them — and
 * `store-linkage-isolation.test.ts` asserts this handler still performs BOTH, so
 * a future refactor cannot quietly drop the second half.
 */

import type { Request, Response } from 'express';
import type { MerchantClaimRevokeReason } from '@mercaria/shared-types';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  decideLinkageRequest,
  getRequestDetail,
  listLinkageReviewQueue,
  openLinkageCorrection,
  proposeOperatorCandidate,
  toStoreLinkageAdoptionDTO,
  toStoreLinkageCandidateDTO,
  toStoreLinkageOverlapDTO,
  toStoreLinkageRequestDTO,
  unlinkOnClaimRevocation,
} from '../services/store-linkage/store-linkage.service.js';
import {
  revokeClaim,
  toMerchantClaimDTO,
} from '../services/merchant-claims/merchant-claim.service.js';
import { findClaimById } from '../db/merchant-claims/merchantClaimRepository.js';
import { getDb } from '../db/postgres.js';
import { hasCanonicalMatcher } from '../services/store-linkage/canonical-matcher.port.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';

/** GET /internal/commerce-graph/store-linkage/requests — what is waiting on a person. */
export async function listLinkageQueueHandler(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await listLinkageReviewQueue();
    sendSuccess(res, {
      requests: rows.map(toStoreLinkageRequestDTO),
      // Reported on the queue rather than buried in a log, because a deployment
      // where #58 has not landed links merchants whose catalogues then attach to
      // nothing — a fact an operator triaging "why is this shop's product page
      // empty" needs on the first screen.
      canonicalMatcherAvailable: hasCanonicalMatcher(),
    });
  } catch (error) {
    respondWithError(res, error, 'Listing the linkage queue failed');
  }
}

/** GET /internal/commerce-graph/store-linkage/requests/:id — one request in full. */
export async function getLinkageRequestForOperatorHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const detail = await getRequestDetail(routeParam(req, 'id'));
    sendSuccess(res, {
      request: toStoreLinkageRequestDTO(detail.request),
      candidates: detail.candidates.map(toStoreLinkageCandidateDTO),
      adoptions: detail.adoptions.map(toStoreLinkageAdoptionDTO),
      overlaps: detail.overlaps.map(toStoreLinkageOverlapDTO),
    });
  } catch (error) {
    respondWithError(res, error, 'Reading the linkage request failed');
  }
}

/** POST /internal/commerce-graph/store-linkage/requests/:id/decision — approve or reject. */
export async function decideLinkageRequestHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { approve: boolean; storeId?: string; reason: string };
    const decided = await decideLinkageRequest({
      requestId: routeParam(req, 'id'),
      approve: body.approve,
      ...(body.storeId !== undefined ? { storeId: body.storeId } : {}),
      reason: body.reason,
      operatorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toStoreLinkageRequestDTO(decided));
  } catch (error) {
    respondWithError(res, error, 'Deciding the linkage request failed');
  }
}

/**
 * POST /internal/commerce-graph/store-linkage/requests/:id/candidates — record a
 * store an operator believes is right.
 *
 * Its own endpoint rather than a field on the decision, because the candidate
 * rows are the BOUND on what a review may approve: widening that bound is a
 * different act from exercising it, and belongs on the record with its own
 * reason.
 */
export async function proposeLinkageCandidateHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { storeId: string; reason: string };
    await proposeOperatorCandidate({
      requestId: routeParam(req, 'id'),
      storeId: body.storeId,
      reason: body.reason,
      operatorOxyUserId: catalogOperatorId(req),
    });
    const detail = await getRequestDetail(routeParam(req, 'id'));
    sendSuccess(res, detail.candidates.map(toStoreLinkageCandidateDTO), 201);
  } catch (error) {
    respondWithError(res, error, 'Proposing the linkage candidate failed');
  }
}

/**
 * POST /internal/commerce-graph/store-linkage/corrections — correct or end a
 * linkage (issue case 7).
 *
 * The response carries the IMPACT PREVIEW the request stored before anything
 * moved (issue revocation rule 5: an operator action requires a reason AND a
 * preview). The correction itself is not applied here — it is opened, so the
 * operator sees the counts and then drives the same resumable apply every other
 * mode uses.
 */
export async function openLinkageCorrectionHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { storeId: string; intendedMerchantId?: string; reason: string };
    const request = await openLinkageCorrection({
      storeId: body.storeId,
      ...(body.intendedMerchantId !== undefined
        ? { intendedMerchantId: body.intendedMerchantId }
        : {}),
      reason: body.reason,
      operatorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toStoreLinkageRequestDTO(request), 201);
  } catch (error) {
    respondWithError(res, error, 'Opening the linkage correction failed');
  }
}

/**
 * POST /internal/commerce-graph/claims/:id/revoke-and-unlink — the two-act
 * revocation (issue revocation rule 1).
 *
 * The claim is revoked FIRST. If the unlink then failed, the merchant is
 * `unclaimed` with a stale link — visible, blocking (a stale active link blocks
 * new activation, revocation rule 6) and repairable by calling this again or by
 * opening a correction. The other order would leave a store unlinked under a
 * claim that still says somebody operates it, which reads as a working
 * configuration and is not one.
 *
 * The existing `/claims/:id/revoke` endpoint stays exactly as #83 shipped it:
 * revoking a claim WITHOUT touching linkage is a legitimate act (a merchant with
 * no native store has nothing to unlink), and changing its behaviour would make
 * #83's own tests describe something else.
 */
export async function revokeClaimAndUnlinkHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: MerchantClaimRevokeReason; note: string };
    const operatorOxyUserId = catalogOperatorId(req);
    const claimId = routeParam(req, 'id');

    // The merchant is read BEFORE the revocation, because revoking clears the
    // merchant's claimant and the unlink needs to know which merchant this was
    // about — a fact the revoked claim still carries, but which is clearer read
    // once than re-derived from a row two statements later.
    const claim = await findClaimById(getDb(), claimId);
    if (!claim) throw notFound('Claim not found');

    const revoked = await revokeClaim({
      claimId,
      reason: body.reason,
      note: body.note,
      operatorOxyUserId,
    });

    const { revokedLinkId } = await unlinkOnClaimRevocation({
      merchantId: claim.merchantId,
      operatorOxyUserId,
      reason: `${body.reason}: ${body.note}`,
    });

    sendSuccess(res, {
      claim: toMerchantClaimDTO(revoked, []),
      // NULL when the merchant had no native store — a normal outcome, not a
      // failure, and distinguishable from "a link was removed" by the caller.
      revokedNativeStoreLinkId: revokedLinkId,
    });
  } catch (error) {
    respondWithError(res, error, 'Revoking the claim and its linkage failed');
  }
}
