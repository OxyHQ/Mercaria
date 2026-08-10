/**
 * The public routing and SEO API (#75) — what the edge asks before it serves a
 * page.
 *
 * No auth: everything here is public. What a crawler is told about a public URL
 * is by definition public, and requiring a credential would mean the Cloudflare
 * Worker holding one — a secret in an edge script that serves anonymous
 * traffic.
 *
 * Rate-limited under the dedicated `'seo'` scope rather than `'listings'`: the
 * caller is one worker on behalf of every crawler, so a crawl and a shopper
 * must not share a budget in either direction.
 *
 * Route ORDER is load-bearing: `sitemap.xml` and `robots.txt` are literal
 * segments and must precede nothing (`/sitemaps/:collection/:page` cannot
 * swallow them — different arity), but `/resolve` is listed first because it is
 * the one every page view hits.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { seoResolveQuerySchema } from '../middleware/seo-schemas.js';
import {
  resolveSeoDocumentHandler,
  seoRobotsHandler,
  seoSitemapIndexHandler,
  seoSitemapPageHandler,
} from '../controllers/seo.controller.js';

const router = Router();

router.use(makeRateLimiter('seo'));

/** GET /seo/resolve?path=… — a document, a redirect, a 404 or "no metadata". */
router.get('/resolve', validateQuery(seoResolveQuerySchema), resolveSeoDocumentHandler);

/** GET /seo/robots.txt — the crawl rules, from the ONE disallow list. */
router.get('/robots.txt', seoRobotsHandler);

/** GET /seo/sitemap.xml — the index over the four collections. */
router.get('/sitemap.xml', seoSitemapIndexHandler);

/**
 * GET /seo/sitemaps/:collection/:file — one paginated collection page.
 *
 * The `.xml` suffix is part of the SEGMENT rather than a literal in the
 * pattern: Express 4's path-to-regexp treats a `.` in a route as a format
 * separator, so `/:page.xml` does not mean what it reads as. The handler
 * requires the segment to be exactly `<digits>.xml`, so one page has one
 * address and a crawler cannot fetch the same rows twice under two spellings.
 */
router.get('/sitemaps/:collection/:file', seoSitemapPageHandler);

export default router;
