/**
 * The public taxonomy HTTP surface (#367 Workstream 1).
 *
 * Thin, like every controller here: read the request, call one service, shape the
 * response. The two things it owns that a service cannot are the ETag exchange
 * and the cursor decode — both are HTTP facts, and a service that answered `304`
 * would have to know about HTTP.
 *
 * ## Every read answers with a validator, and the validator is PUBLIC
 *
 * `Cache-Control: public, no-cache` and not `private`: this surface is anonymous
 * and its answer is identical for every reader, so one validator is valid across
 * callers and a shared cache may hold it. `no-cache` rather than `no-store` is the
 * whole point of a deterministic ETag — a client SHOULD keep the body and
 * revalidate.
 *
 * `Vary: Accept-Encoding` and NOT `Vary: Accept-Language`. The locale is a query
 * parameter, so it is already part of the cache key by being part of the URL;
 * adding the header would fragment every cache entry by a header this surface
 * never reads. The taxonomy answers from `?locale=` and never from a header —
 * `/catalog-authoring`'s rule, and `referral-enrollment.realdb.test.ts` refuses an
 * `Accept-Language` where a language tag belongs.
 *
 * ## A 404 is the only shape a withheld category takes
 *
 * `readTaxonomy*` answers `null` or `absent` for a category that does not exist
 * AND for one whose lifecycle is not addressable, and this controller cannot tell
 * them apart because it is not told. A distinguishable answer would be an oracle
 * over unannounced verticals — the `?version=` exposure
 * `schema-version-lifecycle-exposure.realdb.test.ts` closed, one surface over.
 */

import type { Request, Response } from 'express';
import { getDb } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';
import { ifNoneMatchMatches } from '../lib/http/if-none-match.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';
import { taxonomyEtag, type TaxonomyEtagKey } from '../services/taxonomy/etag.js';
import {
  decodeCategoryCursor,
  readTaxonomyAncestors,
  readTaxonomyBreadcrumb,
  readTaxonomyCategory,
  readTaxonomyCategoryByKey,
  readTaxonomyChildren,
  readTaxonomyDescendants,
  readTaxonomyEligibility,
  readTaxonomyRoots,
  searchTaxonomyCategories,
  type TaxonomyPageOptions,
} from '../services/taxonomy/read.service.js';
import { config } from '../config/index.js';
import { categoryKeyParam } from '../middleware/taxonomy-schemas.js';

/** The locale a read resolves in, from the query and never from a header. */
function requestedLocale(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : 'en';
}

/** How many rows a page holds when the caller names no limit. */
function pageLimit(raw: unknown): number {
  return typeof raw === 'number' ? raw : config.catalogAuthoring.categoryPageSize;
}

/**
 * The paged-read options, with a malformed cursor REFUSED.
 *
 * Refused rather than ignored: a cursor that silently fell back to the first page
 * would answer page four with page one, which a client renders as duplicate rows
 * and reads as a server bug it cannot see.
 */
function pageOptions(req: Request): TaxonomyPageOptions {
  const query = req.query as unknown as { locale?: string; limit?: number; cursor?: string };
  const base = { requestedLocale: requestedLocale(query.locale), limit: pageLimit(query.limit) };
  if (query.cursor === undefined) return base;
  const after = decodeCategoryCursor(query.cursor);
  if (after === null) {
    throw validationError('That page cursor is not one this surface issued');
  }
  return { ...base, after };
}

/**
 * Answer with a body, its ETag, and `304` when the caller already holds it.
 *
 * ONE function for all nine reads, so no route can acquire a tag and forget the
 * exchange — or set the exchange and forget the headers. The key is composed by
 * the caller because only the caller knows which dimensions its read has.
 */
function sendCacheable(req: Request, res: Response, key: TaxonomyEtagKey, body: unknown): void {
  const etag = taxonomyEtag(key, body);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  if (ifNoneMatchMatches(req.headers['if-none-match'], etag)) {
    res.status(304).end();
    return;
  }
  sendSuccess(res, body);
}

/** The same 404 for "no such category" and "not addressable". */
function notFoundCategory(res: Response): void {
  res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Category not found' });
}

/* -------------------------------------------------------------------------- */

/** `GET /taxonomy/categories/roots` */
export async function taxonomyRootsHandler(req: Request, res: Response): Promise<void> {
  try {
    const options = pageOptions(req);
    const page = await readTaxonomyRoots(getDb(), options);
    sendCacheable(
      req,
      res,
      {
        read: 'roots',
        subject: null,
        requestedLocale: options.requestedLocale,
        parameters: { limit: options.limit, cursor: cursorDimension(options) },
      },
      page,
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to read the taxonomy roots');
    respondWithError(res, err, 'Failed to read the taxonomy');
  }
}

/** `GET /taxonomy/categories/search` */
export async function taxonomySearchHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as { q: string; locale?: string; limit?: number };
    const locale = requestedLocale(query.locale);
    const limit = typeof query.limit === 'number' ? query.limit : 20;
    const result = await searchTaxonomyCategories(getDb(), {
      query: query.q,
      requestedLocale: locale,
      limit,
    });
    sendCacheable(
      req,
      res,
      { read: 'search', subject: query.q, requestedLocale: locale, parameters: { limit } },
      result,
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to search the taxonomy');
    respondWithError(res, err, 'Failed to search the taxonomy');
  }
}

/** `GET /taxonomy/categories/by-key/:key` */
export async function taxonomyCategoryByKeyHandler(req: Request, res: Response): Promise<void> {
  const key = routeParam(req, 'key');
  try {
    /*
     * The key's SHAPE is checked here rather than by a route middleware, because
     * `middleware/validate.ts` has no param validator and this is the only route
     * that needs one — a generic `validateParams` for one caller is an
     * abstraction with one user.
     *
     * The pattern is `categoryKeyParam`'s, which is the SAME one
     * `categories_key_format_check` renders, so a key this surface accepts and a
     * key the database stores cannot diverge. Refused as a 400 naming the rule
     * rather than passed through as a lookup that would 404: a caller sending a
     * LABEL where a key belongs needs to be told that (ADR 0007 D1 rule 3), and a
     * 404 reads as "no such category".
     */
    const shape = categoryKeyParam.safeParse(key);
    if (!shape.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'a category is named by its stable machine key (ADR 0007 D1); a label is not a key',
      });
      return;
    }
    const locale = requestedLocale((req.query as { locale?: string }).locale);
    const lookup = await readTaxonomyCategoryByKey(getDb(), shape.data, locale);
    if (lookup.outcome === 'absent') {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      { read: 'category_by_key', subject: key, requestedLocale: locale, parameters: {} },
      { category: lookup.category },
    );
  } catch (err) {
    log.general.error({ err, key }, 'Failed to read a category by key');
    respondWithError(res, err, 'Failed to read that category');
  }
}

/** `GET /taxonomy/categories/:categoryId` */
export async function taxonomyCategoryHandler(req: Request, res: Response): Promise<void> {
  const categoryId = routeParam(req, 'categoryId');
  try {
    const locale = requestedLocale((req.query as { locale?: string }).locale);
    const lookup = await readTaxonomyCategory(getDb(), categoryId, locale);
    if (lookup.outcome === 'absent') {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      { read: 'category', subject: categoryId, requestedLocale: locale, parameters: {} },
      { category: lookup.category },
    );
  } catch (err) {
    log.general.error({ err, categoryId }, 'Failed to read a category');
    respondWithError(res, err, 'Failed to read that category');
  }
}

/** `GET /taxonomy/categories/:categoryId/children` */
export async function taxonomyChildrenHandler(req: Request, res: Response): Promise<void> {
  const categoryId = routeParam(req, 'categoryId');
  try {
    const options = pageOptions(req);
    const page = await readTaxonomyChildren(getDb(), categoryId, options);
    if (page === null) {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      {
        read: 'children',
        subject: categoryId,
        requestedLocale: options.requestedLocale,
        parameters: { limit: options.limit, cursor: cursorDimension(options) },
      },
      page,
    );
  } catch (err) {
    log.general.error({ err, categoryId }, 'Failed to read a category’s children');
    respondWithError(res, err, 'Failed to read those categories');
  }
}

/** `GET /taxonomy/categories/:categoryId/descendants` */
export async function taxonomyDescendantsHandler(req: Request, res: Response): Promise<void> {
  const categoryId = routeParam(req, 'categoryId');
  try {
    const options = pageOptions(req);
    const page = await readTaxonomyDescendants(getDb(), categoryId, options);
    if (page === null) {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      {
        read: 'descendants',
        subject: categoryId,
        requestedLocale: options.requestedLocale,
        parameters: { limit: options.limit, cursor: cursorDimension(options) },
      },
      page,
    );
  } catch (err) {
    log.general.error({ err, categoryId }, 'Failed to read a category’s descendants');
    respondWithError(res, err, 'Failed to read those categories');
  }
}

/** `GET /taxonomy/categories/:categoryId/ancestors` */
export async function taxonomyAncestorsHandler(req: Request, res: Response): Promise<void> {
  const categoryId = routeParam(req, 'categoryId');
  try {
    const locale = requestedLocale((req.query as { locale?: string }).locale);
    const steps = await readTaxonomyAncestors(getDb(), categoryId, locale);
    if (steps === null) {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      { read: 'ancestors', subject: categoryId, requestedLocale: locale, parameters: {} },
      { steps },
    );
  } catch (err) {
    log.general.error({ err, categoryId }, 'Failed to read a category’s ancestors');
    respondWithError(res, err, 'Failed to read that trail');
  }
}

/** `GET /taxonomy/categories/:categoryId/breadcrumb` */
export async function taxonomyBreadcrumbHandler(req: Request, res: Response): Promise<void> {
  const categoryId = routeParam(req, 'categoryId');
  try {
    const locale = requestedLocale((req.query as { locale?: string }).locale);
    const steps = await readTaxonomyBreadcrumb(getDb(), categoryId, locale);
    if (steps === null) {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      { read: 'breadcrumb', subject: categoryId, requestedLocale: locale, parameters: {} },
      { steps },
    );
  } catch (err) {
    log.general.error({ err, categoryId }, 'Failed to read a category’s breadcrumb');
    respondWithError(res, err, 'Failed to read that trail');
  }
}

/** `GET /taxonomy/categories/:categoryId/eligibility` */
export async function taxonomyEligibilityHandler(req: Request, res: Response): Promise<void> {
  const categoryId = routeParam(req, 'categoryId');
  try {
    const locale = requestedLocale((req.query as { locale?: string }).locale);
    const eligibility = await readTaxonomyEligibility(getDb(), categoryId, locale);
    if (eligibility === null) {
      notFoundCategory(res);
      return;
    }
    sendCacheable(
      req,
      res,
      { read: 'eligibility', subject: categoryId, requestedLocale: locale, parameters: {} },
      { eligibility },
    );
  } catch (err) {
    log.general.error({ err, categoryId }, 'Failed to read a category’s eligibility');
    respondWithError(res, err, 'Failed to read that eligibility');
  }
}

/**
 * The cursor as an ETag dimension.
 *
 * `null` for an unpaged request. The cursor has to be IN the key: page one and
 * page two of the same read differ only by it, and a tag that omitted it would let
 * a `304` answer page two with page one from a client's own cache.
 */
function cursorDimension(options: TaxonomyPageOptions): string | null {
  return options.after === undefined
    ? null
    : `${String(options.after.position)}:${options.after.slug}`;
}
