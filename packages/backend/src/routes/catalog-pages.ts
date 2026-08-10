/**
 * Brand and product-family PAGES (#72) — the composed public reads.
 *
 * A separate router from `/canonical-products` and `/product-families`, which
 * are #56's and serve catalogue IDENTITY only ("no price, no stock, no
 * seller"). A PAGE is a composition — identity plus verified relationships plus
 * current offer summaries plus navigation — and putting it on #56's routers
 * would make its identity surface start carrying prices, which is exactly the
 * line that file draws in its own header.
 *
 * No auth on the reads: everything served is public catalogue identity and
 * public commercial context, with no viewer-specific hydration. The CORRECTION
 * is authenticated, because an unauthenticated write into an operator's review
 * queue is a queue anybody can fill. Both are rate-limited under the
 * `'listings'` scope, the read-path budget `merchants`, `canonical-products`
 * and `offers` already use.
 *
 * Route ORDER is load-bearing: `/brands/:handle/products` and
 * `/families/:handle/products` are two segments deeper than the page routes, so
 * no parameter route can swallow them, and `/corrections` is a distinct prefix
 * from both.
 *
 * There is deliberately NO write route for a brand, a family or a product. A
 * page composes what other domains own and owns nothing itself —
 * `catalog-page-isolation.test.ts` fails the build if a module here imports a
 * canonical write service.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { authenticateToken } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  catalogBrowseQuerySchema,
  catalogCorrectionSchema,
  catalogPageQuerySchema,
} from '../middleware/catalog-page-schemas.js';
import {
  getBrandPageHandler,
  getProductFamilyPageHandler,
  listBrandPageProductsHandler,
  listProductFamilyPageProductsHandler,
  submitCatalogCorrectionHandler,
} from '../controllers/catalog-pages.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /catalog-pages/brands/:handle — id, slug or alias; tombstones redirect. */
router.get('/brands/:handle', validateQuery(catalogPageQuerySchema), getBrandPageHandler);

/** GET /catalog-pages/brands/:handle/products — the brand's canonical products. */
router.get(
  '/brands/:handle/products',
  validateQuery(catalogBrowseQuerySchema),
  listBrandPageProductsHandler,
);

/** GET /catalog-pages/families/:handle — the family page. */
router.get('/families/:handle', validateQuery(catalogPageQuerySchema), getProductFamilyPageHandler);

/** GET /catalog-pages/families/:handle/products — the family's generations. */
router.get(
  '/families/:handle/products',
  validateQuery(catalogBrowseQuerySchema),
  listProductFamilyPageProductsHandler,
);

/**
 * POST /catalog-pages/corrections — dispute a published fact (#72 identity 2).
 *
 * Authenticated, and the account is used for NOTHING beyond being required: the
 * review item records the dispute and not the disputer, so submitting confers
 * no standing (#72 identity rule 1). What authentication buys is a bound on
 * unattributable volume, which the rate limiter alone cannot give.
 */
router.post(
  '/corrections',
  authenticateToken,
  validateBody(catalogCorrectionSchema),
  submitCatalogCorrectionHandler,
);

export default router;
