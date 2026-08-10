/**
 * `/internal/seo/*` — the SEO operator surface (#75).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/
 * #62/#68/#78 use, and deliberately not a seventh: who may decide what the
 * catalogue says and who may read what a crawler is told about it are the same
 * power over the same graph. Empty list = the router is not mounted at all
 * (404, never a 401 that would advertise the surface), and it STAYS mounted
 * while `SEO_ROUTES_ENABLED` is off — the evidence has to be readable during
 * the incident that turned the public surface off.
 *
 * ## THREE reads and no write, and the omissions are the design
 *
 * There is no "index this anyway", no "set this page's robots directive", no
 * "add this URL to a sitemap", no cache purge and no way to edit the route
 * registry. Every one would be a second authority over what
 * `decideIndexability` already decides, and the first would publish a page some
 * source's agreement forbids. What an operator changes is an INPUT — a
 * description, a rights policy, a category, a lever — and this surface exists
 * to say WHICH input.
 *
 * `internal-seo-routes.test.ts` enumerates the registered routes EXACTLY, so a
 * fourth route or any non-GET method fails the build.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateQuery } from '../middleware/validate.js';
import { seoResolveQuerySchema } from '../middleware/seo-schemas.js';
import {
  seoDiagnoseHandler,
  seoRouteRegistryHandler,
  seoSitemapCoverageHandler,
} from '../controllers/internal-seo.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — one URL's resolution PLUS the indexability reason a crawler never sees. */
router.get('/diagnose', validateQuery(seoResolveQuerySchema), seoDiagnoseHandler);

/** GET — the route registry as the process holds it, with the rollout levers. */
router.get('/routes', seoRouteRegistryHandler);

/** GET — how much of one sitemap page the policy kept, and what refused the rest. */
router.get('/sitemaps/:collection/:page', seoSitemapCoverageHandler);

export default router;
