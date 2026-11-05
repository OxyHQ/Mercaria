import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { merchandisedPageQuerySchema } from '../middleware/merchandising-rules-schemas.js';
import {
  getStorefrontMerchandisedPage,
  getStorefrontMerchandising,
} from '../controllers/store-merchandising.controller.js';

/**
 * The store page's merchandising read, mounted at `/stores/:handle/merchandising`
 * BEFORE the public `/stores` router (#89, `advanced_merchandising_rules`).
 *
 * Its own router rather than two lines in `routes/stores.ts`, and that is the
 * point: `routes/stores.ts` is part of the derived ranking surface, and a module
 * of that surface must never import the code that applies a merchant plan
 * (`merchant-plan-isolation.test.ts`). PUBLIC and anonymous — nothing here is
 * per-viewer — and metered on the store page's own `'stores'` scope.
 */
const router = Router({ mergeParams: true });

router.use(makeRateLimiter('stores'));

/** GET /stores/:handle/merchandising — what the store page applies right now. */
router.get('/', getStorefrontMerchandising);

/** GET /stores/:handle/merchandising/listings — one page of the merchandised grid order. */
router.get('/listings', validateQuery(merchandisedPageQuerySchema), getStorefrontMerchandisedPage);

export default router;
