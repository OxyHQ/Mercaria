/**
 * The canonical product page API (#71) — one PUBLIC composed read.
 *
 * A separate router from `/canonical-products` (#56), which serves catalogue
 * IDENTITY and deliberately no price, stock or seller. This answers a different
 * question — "what is this thing, and what are all the ways to acquire it right
 * now" — and composing the two is exactly what #71 is for.
 *
 * `optionalAuth`, not `authenticateToken`: a product page is public commercial
 * information. The signed-in half is a currency preference and nothing else; no
 * part of the page reads an account, and the ranking beneath it has no field an
 * account could be read into.
 *
 * Rate-limited under the `'listings'` scope, the same read-path budget
 * `/canonical-products`, `/offers` and `/offer-comparison` share: it is those
 * reads, composed.
 *
 * There is deliberately NO write route, and none may be added. Everything a
 * shopper can do from this page — add to cart, save a product, report data —
 * already has a surface that owns it, and a second way to reach any of them
 * from here would be a second authority over somebody else's rules.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { productPageQuerySchema } from '../middleware/product-page-schemas.js';
import { canonicalProductPageHandler } from '../controllers/product-page.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'), optionalAuth);

/** GET /product-page/:idOrSlug — identity, configurations, ranked offers, channels. */
router.get('/:idOrSlug', validateQuery(productPageQuerySchema), canonicalProductPageHandler);

export default router;
