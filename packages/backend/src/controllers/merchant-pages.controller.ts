/**
 * Merchant page controller (THIN) — #73.
 *
 * Every handler delegates to `services/merchant-pages/`; nothing here decides
 * anything a service could disagree with, and in particular nothing here
 * decides what a page may show. The one thing it does own is the translation
 * from query parameters to a scope, which it performs by calling
 * `resolveCatalogScope` rather than by assembling a scope object itself — the
 * refusal for "every seller on a channel this merchant does not operate" is a
 * service decision that depends on a row, and a controller that built the scope
 * itself could route around it.
 */

import type { Request, Response } from 'express';
import type { ConditionGroup, OfferAvailability } from '@mercaria/shared-types';
import {
  getMerchantPage,
  resolveCatalogScope,
} from '../services/merchant-pages/merchant-page.service.js';
import {
  getMerchantCatalog,
  getMerchantOffers,
} from '../services/merchant-pages/merchant-catalog.service.js';
import { getMerchantPublic } from '../services/commerce-graph/merchant.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';

/** Page size when a caller states none. */
const DEFAULT_PAGE_LIMIT = 24;

/** The shape `merchantCatalogQuerySchema` guarantees by the time a handler runs. */
interface CatalogQuery {
  storefrontId?: string;
  sellers?: 'this_merchant' | 'all';
  categoryId?: string;
  brandId?: string;
  market?: string;
  conditionGroups?: ConditionGroup[];
  availability?: OfferAvailability[];
  limit?: number;
  cursor?: string;
}

/**
 * Resolve the merchant, the scope and the filters a browse runs under.
 *
 * The merchant is resolved through `getMerchantPublic`, which applies #54's
 * tombstone-redirect and suppression policy — so a browse of an old merchant
 * URL answers with the winner's catalogue rather than an empty page, exactly as
 * the page read does.
 */
async function resolveBrowse(req: Request): Promise<{
  merchantId: string;
  scope: Awaited<ReturnType<typeof resolveCatalogScope>>;
  filters: {
    categoryId?: string;
    brandId?: string;
    market?: string;
    conditionGroups?: readonly ConditionGroup[];
    availability?: readonly OfferAvailability[];
  };
  limit: number;
  cursor?: string;
}> {
  const query = req.query as CatalogQuery;
  const profile = await getMerchantPublic(routeParam(req, 'idOrSlug'));
  const scope = await resolveCatalogScope({
    merchantId: profile.merchant.id,
    ...(query.storefrontId === undefined ? {} : { storefrontId: query.storefrontId }),
    allSellers: query.sellers === 'all',
  });
  return {
    merchantId: profile.merchant.id,
    scope,
    filters: {
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.brandId === undefined ? {} : { brandId: query.brandId }),
      ...(query.market === undefined ? {} : { market: query.market }),
      ...(query.conditionGroups === undefined ? {} : { conditionGroups: query.conditionGroups }),
      ...(query.availability === undefined ? {} : { availability: query.availability }),
    },
    limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

/** GET /merchants/:idOrSlug/page — identity, channels, standing, brands, mix. */
export async function getMerchantPageHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getMerchantPage(routeParam(req, 'idOrSlug')));
  } catch (error) {
    respondWithError(res, error, 'Merchant page read failed');
  }
}

/** GET /merchants/:idOrSlug/catalog — deduplicated canonical-product cards. */
export async function getMerchantCatalogHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getMerchantCatalog(await resolveBrowse(req)));
  } catch (error) {
    respondWithError(res, error, 'Merchant catalogue read failed');
  }
}

/**
 * GET /merchants/:idOrSlug/offers — the offer-level view, not deduplicated.
 *
 * A brand or category filter is REFUSED here rather than accepted and ignored.
 * Both are facts about the canonical PRODUCT, so applying them would join two
 * more tables into the statement `offers_merchant_browse_idx` serves — and
 * accepting a parameter that changes nothing is the quiet failure a shopper
 * reads as "this merchant has no Apple products on this channel". The product
 * view takes them; this view's own question is which channel, which seller and
 * which market.
 */
export async function getMerchantOffersHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as CatalogQuery;
    if (query.brandId !== undefined || query.categoryId !== undefined) {
      throw validationError(
        'Brand and category are canonical product facts: filter them on ' +
          '/catalog. The offer view filters by channel, seller, market, ' +
          'condition and availability.',
      );
    }
    sendSuccess(res, await getMerchantOffers(await resolveBrowse(req)));
  } catch (error) {
    respondWithError(res, error, 'Merchant offer read failed');
  }
}
