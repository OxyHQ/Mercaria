/**
 * The claimant-facing linkage controller (#84).
 *
 * Thin, like every controller here: the state machine, the conflict rules and
 * the refusals live in `services/store-linkage/`. Two things ARE this layer's
 * job and neither is cosmetic.
 *
 * **The claimant is read from the verified credential, never from the body.**
 * `getRequiredOxyUserId` is the only source of the actor on every route below,
 * so no field a client can send names who is linking — the mass-assignment /
 * IDOR rule, applied to the one id that decides who ends up operating a store.
 *
 * **The diff endpoint checks the caller's permission on the STORE before it
 * reads anything.** It compares a private store profile against a public
 * canonical record, so without that check it would be a way to read any store's
 * name and description by id, and to confirm which store ids exist. The refusal
 * is a 404, not a 403, for the same reason: a 403 confirms the store.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { StoreLinkageProfileField } from '@mercaria/shared-types';
import {
  applyLinkageRequest,
  claimantMayLinkStore,
  getLinkageDiff,
  getRequestDetail,
  getRequestForClaimant,
  listRequestsForUser,
  openLinkageRequest,
  toStoreLinkageAdoptionDTO,
  toStoreLinkageCandidateDTO,
  toStoreLinkageOverlapDTO,
  toStoreLinkageRequestDTO,
} from '../services/store-linkage/store-linkage.service.js';
import { findStoreById } from '../db/stores/storeRepository.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';

/** POST /store-linkage/requests — open (or converge on) a linkage request. */
export async function openLinkageRequestHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      claimId: string;
      mode: 'create_store' | 'link_existing';
      storeId?: string;
      reason: string;
    };
    const request = await openLinkageRequest({
      claimId: body.claimId,
      claimantOxyUserId: getRequiredOxyUserId(req),
      mode: body.mode,
      ...(body.storeId !== undefined ? { storeId: body.storeId } : {}),
      reason: body.reason,
    });
    sendSuccess(res, toStoreLinkageRequestDTO(request), 201);
  } catch (error) {
    respondWithError(res, error, 'Opening the linkage request failed');
  }
}

/** GET /store-linkage/requests — the caller's own requests, newest first. */
export async function listLinkageRequestsHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listRequestsForUser(getRequiredOxyUserId(req));
    sendSuccess(res, rows.map(toStoreLinkageRequestDTO));
  } catch (error) {
    respondWithError(res, error, 'Listing linkage requests failed');
  }
}

/**
 * GET /store-linkage/requests/:id — one request in full.
 *
 * The candidates, the adoptions and the overlap findings ride along, because a
 * claimant looking at a request in review needs to see WHICH of their stores
 * were proposed and on what evidence — which is the whole content of the
 * decision they are waiting on.
 */
export async function getLinkageRequestHandler(req: Request, res: Response): Promise<void> {
  try {
    // Ownership FIRST: the detail read is unscoped by design (the operator
    // surface uses it too), so the scoped read is what stands between a caller
    // and somebody else's request.
    const scoped = await getRequestForClaimant(routeParam(req, 'id'), getRequiredOxyUserId(req));
    const detail = await getRequestDetail(scoped.id);
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

/**
 * POST /store-linkage/requests/:id/apply — apply it.
 *
 * Retrying a timed-out apply is safe and expected: the service returns the
 * finished request unchanged when it has already applied, and resumes from the
 * furthest recorded step when a previous attempt died part way.
 */
export async function applyLinkageRequestHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { adoptFields?: StoreLinkageProfileField[] };
    const actorOxyUserId = getRequiredOxyUserId(req);
    const scoped = await getRequestForClaimant(routeParam(req, 'id'), actorOxyUserId);

    const applied = await applyLinkageRequest({
      requestId: scoped.id,
      actorOxyUserId,
      ...(body.adoptFields !== undefined ? { adoptFields: body.adoptFields } : {}),
    });
    const detail = await getRequestDetail(applied.id);
    const store =
      applied.resolvedStoreId !== null ? await findStoreById(applied.resolvedStoreId) : null;

    sendSuccess(res, {
      request: toStoreLinkageRequestDTO(applied),
      storeId: applied.resolvedStoreId,
      // The handle rides back so a client can route to the new store without a
      // second round trip. It is READ here and never written — issue
      // existing-store rule 7 keeps `/m/<handle>` stable, and this endpoint is
      // the one a reviewer would check for a handle change.
      storeHandle: store?.handle ?? null,
      adoptions: detail.adoptions.map(toStoreLinkageAdoptionDTO),
      overlaps: detail.overlaps.map(toStoreLinkageOverlapDTO),
    });
  } catch (error) {
    respondWithError(res, error, 'Applying the linkage request failed');
  }
}

/**
 * GET /store-linkage/diff?storeId=&merchantId= — the three-sided comparison.
 *
 * Read-only and it opens nothing: comparing a store against a canonical record
 * is a question, and an endpoint that created a workflow row to answer one would
 * make browsing an act.
 */
export async function getLinkageDiffHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { storeId: string; merchantId: string };
    const mayLink = await claimantMayLinkStore(query.storeId, getRequiredOxyUserId(req));
    if (!mayLink) {
      // 404 rather than 403: a 403 confirms the store exists, which is exactly
      // what an unauthorized caller learns nothing else from.
      throw notFound('Store not found');
    }
    sendSuccess(res, await getLinkageDiff(query));
  } catch (error) {
    respondWithError(res, error, 'Building the linkage diff failed');
  }
}
