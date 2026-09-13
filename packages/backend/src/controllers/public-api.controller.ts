/**
 * Public integration surface controller (THIN) — `/public/v1` (#1017).
 *
 * Parses the query with the strict schemas in `middleware/public-api-schemas.ts`,
 * delegates to `services/public-api/public-api.service.ts`, and emits the
 * contract's envelope: `{ success: true, data }` or
 * `{ success: false, error: <MercariaPublicErrorCode>, message }`.
 *
 * EVERY handler catches everything. An unexpected error is `INTERNAL_ERROR` with
 * a generic message, so no handler can fall through to the global error
 * handler's non-contract body, and no internal message reaches a foreign app.
 */

import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
  type MercariaProductSort,
} from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import {
  isMercariaError,
  respondWithError,
  validationError,
} from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import {
  publicNoQuerySchema,
  publicPageQuerySchema,
  publicProductSearchQuerySchema,
  publicStoreLookupQuerySchema,
  publicStoreProductsQuerySchema,
} from '../middleware/public-api-schemas.js';
import {
  getPublicCollection,
  getPublicProduct,
  getPublicStore,
  listPublicCollectionProducts,
  listPublicStoreCollections,
  listPublicStoreProducts,
  lookupPublicStore,
  searchPublicProducts,
  type PublicPageParams,
  type PublicProductListParams,
} from '../services/public-api/public-api.service.js';

/** Parse a request query, or throw the 400 naming every issue. */
function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
        )
        .join('; '),
    );
  }
  return parsed.data;
}

/**
 * The schema's output, restated as the service's parameter types — and the ONE
 * place the defaults are applied: `limit` to `MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT`,
 * `sort` to `relevance` with a query and `newest` without.
 *
 * Field by field rather than a cast: the backend compiles `strict: false`, under
 * which zod infers every key optional, so an `as` would assert a default nobody
 * applied.
 */
function pageParams(parsed: { limit?: number; cursor?: string }): PublicPageParams {
  return {
    limit: parsed.limit ?? MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

function productListParams(parsed: {
  limit?: number;
  cursor?: string;
  q?: string;
  locale?: string;
  inStock?: boolean;
  sort?: MercariaProductSort;
}): PublicProductListParams {
  return {
    ...pageParams(parsed),
    ...(parsed.q === undefined ? {} : { q: parsed.q }),
    ...(parsed.locale === undefined ? {} : { locale: parsed.locale }),
    ...(parsed.inStock === undefined ? {} : { inStock: parsed.inStock }),
    sort: parsed.sort ?? (parsed.q === undefined ? 'newest' : 'relevance'),
  };
}

/** The verified Oxy caller, or `undefined` for an anonymous read. */
function viewerOf(req: Request): string | undefined {
  const id = req.user?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Run one handler body with the surface's single failure mapping. The fallback
 * message is the ONLY text an unexpected error ever puts on the wire.
 */
async function answer(
  req: Request,
  res: Response,
  fallback: string,
  body: () => Promise<unknown>,
): Promise<void> {
  try {
    sendSuccess(res, await body());
  } catch (err) {
    // A 400/404/410 is an ordinary answer on a surface foreign callers probe with
    // persisted references; only an unexpected failure is worth an error line.
    if (!isMercariaError(err)) log.general.error({ err, path: req.path }, `[public-api] ${fallback}`);
    respondWithError(res, err, fallback);
  }
}

/** GET /public/v1/products */
export async function searchProducts(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to search products', () => {
    const parsed = parseQuery(publicProductSearchQuerySchema, req);
    return searchPublicProducts({
      ...productListParams(parsed),
      ...(parsed.storeId === undefined ? {} : { storeId: parsed.storeId }),
      ...(parsed.collectionId === undefined ? {} : { collectionId: parsed.collectionId }),
    });
  });
}

/** GET /public/v1/products/:id */
export async function getProduct(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load product', () => {
    parseQuery(publicNoQuerySchema, req);
    return getPublicProduct(routeParam(req, 'id'), viewerOf(req));
  });
}

/** GET /public/v1/stores/lookup?handle= */
export async function lookupStore(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load store', () =>
    lookupPublicStore(parseQuery(publicStoreLookupQuerySchema, req).handle),
  );
}

/** GET /public/v1/stores/:id */
export async function getStore(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load store', () => {
    parseQuery(publicNoQuerySchema, req);
    return getPublicStore(routeParam(req, 'id'));
  });
}

/** GET /public/v1/stores/:id/products */
export async function listStoreProducts(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load store products', () =>
    listPublicStoreProducts(
      routeParam(req, 'id'),
      productListParams(parseQuery(publicStoreProductsQuerySchema, req)),
    ),
  );
}

/** GET /public/v1/stores/:id/collections */
export async function listStoreCollections(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load store collections', () =>
    listPublicStoreCollections(
      routeParam(req, 'id'),
      pageParams(parseQuery(publicPageQuerySchema, req)),
    ),
  );
}

/** GET /public/v1/collections/:id */
export async function getCollection(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load collection', () => {
    parseQuery(publicNoQuerySchema, req);
    return getPublicCollection(routeParam(req, 'id'));
  });
}

/** GET /public/v1/collections/:id/products */
export async function listCollectionProducts(req: Request, res: Response): Promise<void> {
  await answer(req, res, 'Failed to load collection products', () =>
    listPublicCollectionProducts(
      routeParam(req, 'id'),
      pageParams(parseQuery(publicPageQuerySchema, req)),
    ),
  );
}
