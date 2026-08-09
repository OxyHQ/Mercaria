/**
 * Storefronts API (#54) — PUBLIC reads over the canonical channel layer.
 *
 * Same contract as `routes/merchants.ts`: public identity data, no writes, no
 * auth, `'listings'` rate budget, `/lookup` before the parameter route.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { storefrontLookupQuerySchema } from '../middleware/commerce-graph-schemas.js';
import { getStorefront, lookupStorefronts } from '../controllers/storefronts.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /storefronts/lookup?provider=&externalShopId= | ?domain=. */
router.get('/lookup', validateQuery(storefrontLookupQuerySchema), lookupStorefronts);

/** GET /storefronts/:idOrSlug — public read; merge tombstones redirect. */
router.get('/:idOrSlug', getStorefront);

export default router;
