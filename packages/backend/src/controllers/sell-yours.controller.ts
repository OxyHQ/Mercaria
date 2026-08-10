/**
 * The "Sell yours" controller (THIN) — #91.
 *
 * Ownership is not checked here and is not missing: every service function takes
 * the caller's own Oxy id from `getRequiredOxyUserId` and every repository read
 * carries it in the `WHERE`, so a draft id belonging to somebody else answers
 * 404 rather than 403. A distinguishable answer would be an oracle over which
 * draft ids exist.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CurrencyCode } from '@mercaria/shared-types';
import {
  discardSellerDraft,
  listOwnSellerDrafts,
  patchSellerDraft,
  previewSellerDraft,
  startSellerDraft,
  toSellerDraftDTO,
} from '../services/sell-yours/draft.service.js';
import { publishSellerDraft } from '../services/sell-yours/publish.service.js';
import {
  findCandidatesByIdentifier,
  findCandidatesByText,
} from '../services/sell-yours/candidates.service.js';
import { findSellerDraftWithChildren } from '../db/sellYours/draftRepository.js';
import { buildCanonicalPrefill } from '../services/sell-yours/prefill.service.js';
import { findCategoryById } from '../db/catalog/categoryRepository.js';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';

/** POST /seller/drafts — start or resume a flow. */
export async function startDraft(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const draft = await startSellerDraft(oxyUserId, req.body);
    const loaded = await findSellerDraftWithChildren(draft.id, oxyUserId);
    if (!loaded) throw notFound('Draft not found');
    const prefill = await buildCanonicalPrefill({
      canonicalProductId: draft.canonicalProductId,
      canonicalVariantId: draft.canonicalVariantId,
    });
    sendSuccess(res, toSellerDraftDTO(loaded, prefill), 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to start the listing draft');
  }
}

/** GET /seller/drafts — the caller's own unfinished flows. */
export async function listDrafts(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const drafts = await listOwnSellerDrafts(oxyUserId);
    const dtos = [];
    for (const draft of drafts) {
      const loaded = await findSellerDraftWithChildren(draft.id, oxyUserId);
      if (!loaded) continue;
      const [prefill, category] = await Promise.all([
        buildCanonicalPrefill({
          canonicalProductId: draft.canonicalProductId,
          canonicalVariantId: draft.canonicalVariantId,
        }),
        draft.categoryId ? findCategoryById(draft.categoryId) : Promise.resolve(null),
      ]);
      dtos.push(toSellerDraftDTO(loaded, prefill, category?.slug));
    }
    sendSuccess(res, dtos);
  } catch (err) {
    respondWithError(res, err, 'Failed to load your listing drafts');
  }
}

/** GET /seller/drafts/:id — the preview a review step renders. */
export async function getDraftPreview(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const query = req.query as { currency?: CurrencyCode; market?: string };
    const preview = await previewSellerDraft(oxyUserId, routeParam(req, 'id'), {
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.market ? { market: query.market.toUpperCase() } : {}),
    });
    sendSuccess(res, preview);
  } catch (err) {
    respondWithError(res, err, 'Failed to load the listing draft');
  }
}

/** PATCH /seller/drafts/:id — one step's worth of edits. */
export async function patchDraft(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const draftId = routeParam(req, 'id');
    const loaded = await patchSellerDraft(oxyUserId, draftId, req.body);
    const [prefill, category] = await Promise.all([
      buildCanonicalPrefill({
        canonicalProductId: loaded.draft.canonicalProductId,
        canonicalVariantId: loaded.draft.canonicalVariantId,
      }),
      loaded.draft.categoryId
        ? findCategoryById(loaded.draft.categoryId)
        : Promise.resolve(null),
    ]);
    sendSuccess(res, toSellerDraftDTO(loaded, prefill, category?.slug));
  } catch (err) {
    respondWithError(res, err, 'Failed to save the listing draft');
  }
}

/** DELETE /seller/drafts/:id — abandon a flow. Its assertions survive it. */
export async function deleteDraft(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await discardSellerDraft(oxyUserId, routeParam(req, 'id'));
    sendSuccess(res, { discarded: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to discard the listing draft');
  }
}

/**
 * POST /seller/drafts/:id/publish — publish, idempotently.
 *
 * `created` tells a retrying client whether this call made the listing or found
 * one already there, which is the difference between "your item is live" and
 * "your item was already live" — the same answer either way, and the client
 * shows the same screen.
 */
export async function publishDraft(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const result = await publishSellerDraft(oxyUserId, routeParam(req, 'id'));
    sendSuccess(res, result, result.created ? 201 : 200);
  } catch (err) {
    respondWithError(res, err, 'Failed to publish the listing');
  }
}

/** GET /seller/drafts/candidates — the identify step's scan and search. */
export async function listMatchCandidates(req: Request, res: Response): Promise<void> {
  try {
    getRequiredOxyUserId(req);
    const query = req.query as { identifier?: string; q?: string };
    if ((query.identifier ? 1 : 0) + (query.q ? 1 : 0) !== 1) {
      throw validationError('Provide exactly one of `identifier` or `q`');
    }
    const candidates = query.identifier
      ? await findCandidatesByIdentifier(query.identifier)
      : await findCandidatesByText(query.q ?? '');
    sendSuccess(res, candidates);
  } catch (err) {
    respondWithError(res, err, 'Failed to find matching products');
  }
}
