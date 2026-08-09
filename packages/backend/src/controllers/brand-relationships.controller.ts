/**
 * The PUBLIC relationship reads (#55) — the two questions a product page and a
 * brand page ask, and nothing else.
 *
 * Every response body here comes from `relationship-resolution.ts`'s public
 * projection, which has no field for evidence, reviewer notes, actor ids or
 * confidence. A handler cannot leak private review material by forgetting to
 * strip it, because there is nothing to strip.
 */

import type { Request, Response } from 'express';
import {
  listBrandChannels,
  listMerchantBrandRelationships,
  resolveOfficialChannel,
} from '../services/commerce-graph/relationship-resolution.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * GET /brand-relationships/official-channel?merchantId=&brandId=&market=
 *
 * The answer for a merchant with no relationship is a 200 with `badge: null` —
 * not a 404. Selling a brand without an official relationship is the NORMAL
 * state (ADR 0002 D10), and a 404 would read as "something is missing here".
 */
export async function getOfficialChannelVerdict(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { merchantId: string; brandId: string; market?: string };
    sendSuccess(
      res,
      await resolveOfficialChannel({
        merchantId: query.merchantId,
        brandId: query.brandId,
        market: query.market,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Resolving the official-channel status failed');
  }
}

/** GET /brand-relationships/brands/:brandId/channels?market= — two SEPARATE lists. */
export async function getBrandChannels(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { market?: string };
    sendSuccess(
      res,
      await listBrandChannels({ brandId: routeParam(req, 'brandId'), market: query.market }),
    );
  } catch (error) {
    respondWithError(res, error, 'Listing the brand channels failed');
  }
}

/** GET /brand-relationships/merchants/:merchantId/brands?market=. */
export async function getMerchantBrandRelationships(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { market?: string };
    sendSuccess(
      res,
      await listMerchantBrandRelationships({
        merchantId: routeParam(req, 'merchantId'),
        market: query.market,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Listing the merchant brand relationships failed');
  }
}
