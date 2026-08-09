/**
 * Public seller controller (THIN) — #92.
 *
 * Every handler delegates to `services/sellers/`. Nothing here derives
 * anything: visibility, indexability and the field-by-field projection are all
 * computed in the service, so a controller cannot produce a second answer to
 * any of them, and no response shape here can widen what the projection emits.
 */

import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import {
  getPublicSellerProfile,
  listPublicSellerListings,
  type SellerProfileViewer,
} from '../services/sellers/public-seller-profile.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';

/**
 * The signed-in caller, when there is one.
 *
 * BOTH halves are required. A viewer with an id but no bearer cannot be used to
 * ask Oxy a viewer-scoped question, so treating them as a viewer would silently
 * downgrade the block check to "no block found" while the code read as though
 * it had run. Requiring the token makes the anonymous path and the
 * partially-authenticated path the same path, which is the honest one.
 */
function viewerFromRequest(req: Request): SellerProfileViewer | null {
  const oxyUserId = req.user?.id;
  const accessToken = req.accessToken;
  if (!oxyUserId || !accessToken) return null;
  return { oxyUserId, accessToken };
}

/** GET /sellers/:oxyUserId — the public P2P seller profile. */
export async function getPublicSellerHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getPublicSellerProfile(routeParam(req, 'oxyUserId'), viewerFromRequest(req)));
  } catch (error: unknown) {
    // A refusal is already the uniform 404 the service raises; the fallback
    // message never names the seller, so an internal failure discloses no more
    // than an unknown id would.
    respondWithError(res, error, 'Failed to load seller');
  }
}

/** GET /sellers/:oxyUserId/listings — one keyset page of their public inventory. */
export async function listPublicSellerListingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { limit?: number; cursor?: string };
    sendSuccess(
      res,
      await listPublicSellerListings(routeParam(req, 'oxyUserId'), {
        limit: Math.min(
          query.limit ?? config.pagination.defaultPageSize,
          config.pagination.maxPageSize,
        ),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        viewer: viewerFromRequest(req),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to load seller listings');
  }
}
