/**
 * Brand and product-family page controller (THIN) — #72.
 *
 * Every handler delegates to `services/catalog-pages/`. Nothing here decides
 * anything a service could disagree with: the relationship lists come from
 * #55's public resolver, the offer summaries from #68's derivation, the
 * indexability and structured data from one pure module over the projection
 * this handler is about to send.
 *
 * The ONE thing this layer owns is which OFFER lever is in force. #60 keeps
 * `CANONICAL_READS` and `CANONICAL_OFFER_COMPARISON` separate so that
 * withdrawing price comparison during an incident does not take the brand and
 * product identity pages down with it — its own words — so the mount is gated by
 * the first and the offer half is read HERE from the second.
 */

import type { Request, Response } from 'express';
import type {
  CatalogBrowseFilters,
  CatalogCorrectionField,
  CatalogCorrectionSubject,
  CatalogOfferContextState,
  ConditionGroup,
  CurrencyCode,
  OfferAvailability,
} from '@mercaria/shared-types';
import { DEFAULT_PRESENTMENT_CURRENCY } from '../services/user-preference.service.js';
import { resolveOfferComparisonMode } from '../services/backfill/read-mode.js';
import { readBrandPage, readBrandProducts } from '../services/catalog-pages/brand-page.service.js';
import {
  readProductFamilyPage,
  readProductFamilyProducts,
} from '../services/catalog-pages/family-page.service.js';
import { submitCatalogCorrection } from '../services/catalog-pages/correction.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * Whether the offer half of a page may be computed at all.
 *
 * `shadow` counts as WITHDRAWN here. In that mode a shopper must see exactly
 * what they saw before the canonical surface existed (#60's own definition),
 * and a brand page carrying canonical offer summaries would not be that — so
 * the identity half serves and the prices do not.
 */
function offerContextState(): CatalogOfferContextState {
  return resolveOfferComparisonMode() === 'on' ? 'included' : 'withdrawn';
}

/** The browse filters a validated query carries. */
function browseFilters(query: {
  categories?: string[];
  families?: string[];
  conditionGroups?: ConditionGroup[];
  availability?: OfferAvailability[];
  market?: string;
  attributes?: { key: string; value?: string; minNumber?: number; maxNumber?: number }[];
}): CatalogBrowseFilters {
  return {
    ...(query.categories === undefined ? {} : { categorySlugs: query.categories }),
    ...(query.families === undefined ? {} : { familyIds: query.families }),
    ...(query.conditionGroups === undefined ? {} : { conditionGroups: query.conditionGroups }),
    ...(query.availability === undefined ? {} : { availability: query.availability }),
    ...(query.market === undefined ? {} : { market: query.market.toUpperCase() }),
    ...(query.attributes === undefined ? {} : { attributes: query.attributes }),
  };
}

/** GET /catalog-pages/brands/:handle — id, slug or alias; tombstones redirect. */
export async function getBrandPageHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { market?: string };
    const page = await readBrandPage({
      handle: routeParam(req, 'handle'),
      ...(query.market === undefined ? {} : { market: query.market.toUpperCase() }),
      offerContext: offerContextState(),
    });
    if (!page) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Brand not found', 404);
      return;
    }
    sendSuccess(res, page);
  } catch (error) {
    respondWithError(res, error, 'Brand page read failed');
  }
}

/** GET /catalog-pages/brands/:handle/products — the brand's canonical products. */
export async function listBrandPageProductsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as Parameters<typeof browseFilters>[0] & {
      limit?: number;
      cursor?: string;
    };
    const page = await readBrandProducts({
      handle: routeParam(req, 'handle'),
      filters: browseFilters(query),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      offerContext: offerContextState(),
    });
    if (!page) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Brand not found', 404);
      return;
    }
    sendSuccess(res, page);
  } catch (error) {
    respondWithError(res, error, 'Brand product browse failed');
  }
}

/** GET /catalog-pages/families/:handle — the family page. */
export async function getProductFamilyPageHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { market?: string; currency?: CurrencyCode };
    const page = await readProductFamilyPage({
      handle: routeParam(req, 'handle'),
      ...(query.market === undefined ? {} : { market: query.market.toUpperCase() }),
      // The deployment's preferred presentment currency when the caller names
      // none. The RESPONSE always states which was used, so a range is never a
      // number whose unit a reader has to assume (#72 family rule 4).
      currency: query.currency ?? DEFAULT_PRESENTMENT_CURRENCY,
      offerContext: offerContextState(),
    });
    if (!page) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Product family not found', 404);
      return;
    }
    sendSuccess(res, page);
  } catch (error) {
    respondWithError(res, error, 'Product family page read failed');
  }
}

/** GET /catalog-pages/families/:handle/products — the family's generations. */
export async function listProductFamilyPageProductsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const query = req.query as Parameters<typeof browseFilters>[0] & {
      limit?: number;
      cursor?: string;
    };
    const page = await readProductFamilyProducts({
      handle: routeParam(req, 'handle'),
      filters: browseFilters(query),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      offerContext: offerContextState(),
    });
    if (!page) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Product family not found', 404);
      return;
    }
    sendSuccess(res, page);
  } catch (error) {
    respondWithError(res, error, 'Product family browse failed');
  }
}

/**
 * POST /catalog-pages/corrections — dispute a published fact.
 *
 * A 202, never a 201: the row created is a queue item for a person, and a 201
 * with a location would read as "your correction has been made". `converged`
 * says the dispute was already open, which is the honest answer to a second
 * submission and not an error.
 */
export async function submitCatalogCorrectionHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      subject: CatalogCorrectionSubject;
      handle: string;
      field: CatalogCorrectionField;
    };
    const receipt = await submitCatalogCorrection(body);
    if (!receipt) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Subject not found', 404);
      return;
    }
    sendSuccess(res, receipt, 202);
  } catch (error) {
    respondWithError(res, error, 'Submitting the correction failed');
  }
}
