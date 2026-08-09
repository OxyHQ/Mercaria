/**
 * Storefronts controller (THIN) — public reads over the canonical graph (#54).
 */

import type { Request, Response } from 'express';
import {
  getStorefrontPublic,
  lookupStorefrontBySource,
  lookupStorefrontsByDomain,
} from '../services/commerce-graph/storefront.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';

/** GET /storefronts/lookup?provider=&externalShopId= | ?domain= (issue API rule 1). */
export async function lookupStorefronts(req: Request, res: Response): Promise<void> {
  try {
    const { provider, externalShopId, domain } = req.query as {
      provider?: string;
      externalShopId?: string;
      domain?: string;
    };
    if (domain !== undefined) {
      sendSuccess(res, await lookupStorefrontsByDomain(domain));
      return;
    }
    // The schema guarantees the source-identity arm has both halves.
    const storefront = await lookupStorefrontBySource(provider ?? '', externalShopId ?? '');
    if (!storefront) {
      throw notFound('No storefront with that source identity.');
    }
    sendSuccess(res, storefront);
  } catch (error) {
    respondWithError(res, error, 'Storefront lookup failed');
  }
}

/** GET /storefronts/:idOrSlug — the public read, redirecting tombstones. */
export async function getStorefront(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getStorefrontPublic(routeParam(req, 'idOrSlug')));
  } catch (error) {
    respondWithError(res, error, 'Storefront read failed');
  }
}
