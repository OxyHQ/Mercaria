/**
 * Operator controller for `/internal/commerce-graph/*` (#54).
 *
 * Every action stamps the authenticated operator as the ACTOR onto the link
 * row itself — the row is the audit record (method, actor, time, note/reason
 * on both creation and revocation), backed by a structured log line from the
 * service. MERGE endpoints are deliberately absent: an operator merge is
 * #59's tooling, defined by ADR 0002 D16 as a single transaction that also
 * writes a `catalog_revisions` row — a table #59 owns and this branch must
 * not anticipate. The merge SUBSTRATE (status, merged_into_id, tombstone
 * redirect) ships here; the operation that moves it ships with its audit
 * ledger.
 */

import type { Request, Response } from 'express';
import type { NativeStoreLinkMethod } from '@mercaria/shared-types';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  linkNativeStore,
  revokeLink,
  toNativeStoreLinkDTO,
} from '../services/commerce-graph/native-store-link.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** POST /internal/commerce-graph/native-store-links — create the verified link. */
export async function createNativeStoreLinkHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      merchantId: string;
      storeId: string;
      method: NativeStoreLinkMethod;
      note?: string;
      reason: string;
    };
    const link = await linkNativeStore({
      merchantId: body.merchantId,
      storeId: body.storeId,
      method: body.method,
      note: body.note,
      reason: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toNativeStoreLinkDTO(link), 201);
  } catch (error) {
    respondWithError(res, error, 'Linking the native store failed');
  }
}

/** POST /internal/commerce-graph/native-store-links/:id/revoke — reverse it. */
export async function revokeNativeStoreLinkHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const link = await revokeLink({
      linkId: routeParam(req, 'id'),
      reason: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toNativeStoreLinkDTO(link));
  } catch (error) {
    respondWithError(res, error, 'Revoking the native store link failed');
  }
}
