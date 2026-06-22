import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { getStoreByHandle } from '../controllers/stores.controller.js';
import { listStoreReviews } from '../controllers/reviews.controller.js';
import {
  listStorePublicCollections,
  getStorePublicCollection,
} from '../controllers/collections.controller.js';

/**
 * Stores API — the public store (shop) page.
 *
 * PUBLIC; `optionalAuth` attaches the viewer (when present) so the store's
 * listings can hydrate `saved`. Metered on the dedicated `'stores'` scope.
 */
const router = Router();

router.use(makeRateLimiter('stores'), optionalAuth);

/** GET /stores/:handle — public store page (merchant summary + active listings). */
router.get('/:handle', getStoreByHandle);

/** GET /stores/:handle/reviews — a store's published reviews (paginated). */
router.get('/:handle/reviews', listStoreReviews);

/** GET /stores/:handle/collections — a store's published collections. */
router.get('/:handle/collections', listStorePublicCollections);

/** GET /stores/:handle/collections/:collectionHandle — one collection + its products. */
router.get('/:handle/collections/:collectionHandle', getStorePublicCollection);

export default router;
