/**
 * The SEO operator surface (#75) — WHY a page is not indexed, and how much of a
 * collection the policy is keeping.
 *
 * ## Why this exists at all
 *
 * `decideIndexability` answers with a named reason and a crawler is told only
 * `noindex`: a refusal that spans nine conditions gets ONE public answer, or a
 * client could vary one input at a time and read the switchboard out of the
 * catalogue. That split is only honest if somebody can still ask — otherwise
 * the reason is a value nobody reads, and an operator staring at a missing page
 * has no way to tell a thin description from a withheld source right.
 *
 * ## Read-only, and the omissions are the design
 *
 * There is no "index this anyway", no "set this page's robots directive", no
 * "add this URL to the sitemap" and no cache purge. Every one of them would be
 * a second authority over what the policy already decides, and the first would
 * publish a page some source's agreement forbids. What an operator changes is
 * the INPUT — a description, a rights policy, a category, a lever — and this
 * surface is how they see which input to change. `internal-seo-routes.test.ts`
 * enumerates the registered routes EXACTLY, so a write cannot be added without
 * the gate going red.
 *
 * ## Auditing
 *
 * `requireCatalogOperator` logs every REFUSAL; each handler here logs the
 * granted attempt with the caller and exactly what was asked. Both halves are
 * structured log lines rather than a table, matching every other read-only
 * catalogue operator surface — this domain owns no table and adds none.
 */

import type { Request, Response } from 'express';
import { SEO_SITEMAP_COLLECTIONS } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { PUBLIC_ROUTES } from '../services/seo/routes.js';
import { diagnoseSeoUrl } from '../services/seo/seo.service.js';
import { readSitemapCoverage } from '../services/seo/sitemap.service.js';
import { isSitemapCollection } from '../services/seo/sitemap.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/**
 * `GET /internal/seo/diagnose?path=…` — the resolution, plus the verdict.
 *
 * The SAME `diagnoseSeoUrl` call the public resolver projects, so the reason an
 * operator reads is the reason the crawler's `noindex` came from rather than a
 * re-derivation that can disagree with it.
 */
export async function seoDiagnoseHandler(req: Request, res: Response): Promise<void> {
  const { path } = req.query as { path: string };
  const operator = catalogOperatorId(req);
  try {
    const url = new URL(path, config.web.origin);
    const diagnosis = await diagnoseSeoUrl({
      pathname: url.pathname,
      query: url.searchParams,
    });

    log.general.info(
      {
        operator,
        path: url.pathname,
        outcome: diagnosis.resolution.outcome,
        indexability: diagnosis.indexability?.outcome,
        reason:
          diagnosis.indexability?.outcome === 'refused'
            ? diagnosis.indexability.reason
            : undefined,
      },
      '[Seo] operator diagnosed a public URL',
    );

    sendSuccess(res, {
      path: url.pathname,
      outcome: diagnosis.resolution.outcome,
      ...(diagnosis.resolution.outcome === 'document'
        ? {
            canonicalUrl: diagnosis.resolution.document.canonicalUrl,
            robots: diagnosis.resolution.document.robots,
            structuredDataTypes: diagnosis.resolution.document.structuredData.map(
              (node) => node['@type'],
            ),
          }
        : {}),
      ...(diagnosis.resolution.outcome === 'redirect'
        ? { redirect: diagnosis.resolution.redirect }
        : {}),
      ...(diagnosis.indexability === undefined ? {} : { indexability: diagnosis.indexability }),
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to diagnose the URL');
  }
}

/**
 * `GET /internal/seo/routes` — the registry, as the process actually holds it.
 *
 * Which patterns exist, which have a screen behind them and which sitemap each
 * feeds. An operator debugging "why is there no brand page in the sitemap"
 * reads `availability: 'planned'` here and stops looking.
 */
export function seoRouteRegistryHandler(req: Request, res: Response): void {
  const operator = catalogOperatorId(req);
  log.general.info({ operator }, '[Seo] operator read the public route registry');
  sendSuccess(res, {
    routes: PUBLIC_ROUTES,
    sitemapCollections: SEO_SITEMAP_COLLECTIONS,
    indexingMode: config.seo.indexingMode,
    canaryCategoryIds: config.seo.canaryCategoryIds,
  });
}

/**
 * `GET /internal/seo/sitemaps/:collection/:page` — how much of one page the
 * policy kept, and what refused the rest.
 *
 * Bounded to one page: "how many pages of the catalogue are indexable" is a
 * full scan of every collection, which is what the paginated design exists to
 * avoid. The total ROW count is exact; the tally is the page's.
 */
export async function seoSitemapCoverageHandler(req: Request, res: Response): Promise<void> {
  const collection = routeParam(req, 'collection');
  const pageParam = routeParam(req, 'page');
  const operator = catalogOperatorId(req);
  try {
    if (!isSitemapCollection(collection) || !/^\d+$/u.test(pageParam)) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    const coverage = await readSitemapCoverage(
      collection,
      Number.parseInt(pageParam, 10),
      config.web.origin,
    );
    if (coverage === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    log.general.info(
      { operator, collection, page: coverage.page, indexable: coverage.indexable },
      '[Seo] operator read sitemap coverage',
    );
    sendSuccess(res, coverage);
  } catch (error) {
    respondWithError(res, error, 'Failed to read sitemap coverage');
  }
}
