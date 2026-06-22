import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { getCategoryTree, getCategoryListings } from '../controllers/categories.controller.js';

/**
 * Categories API — the taxonomy tree and per-category listing browse.
 *
 * PUBLIC; `optionalAuth` attaches the viewer (when present) so per-category
 * browse can hydrate `saved`. There is no `'categories'` rate-limit scope, so
 * this router uses the `'listings'` scope (the closest read-path budget).
 */
const router = Router();

router.use(makeRateLimiter('listings'), optionalAuth);

/** GET /categories — the active category taxonomy as a tree. */
router.get('/', getCategoryTree);

/** GET /categories/:slug/listings — cursor browse of a category's active listings. */
router.get('/:slug/listings', getCategoryListings);

export default router;
