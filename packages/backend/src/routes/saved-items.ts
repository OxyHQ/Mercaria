/**
 * `/saved-items` — the buyer's saved products and saved listings, merged (#80).
 *
 * A SEPARATE mount from `/product-saves` because it is not a product-save read:
 * it spans two kinds and, in `off` mode, returns no product saves at all. Hiding
 * it under `/product-saves` would name the response after the half of it a
 * rolled-back deployment does not serve.
 *
 * Always mounted with `/product-saves`. The read mode (`PRODUCT_SAVE_READS`)
 * decides what it serves: `off` is the surface serving the old list, which is
 * where a rollback lands.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { savedItemsQuerySchema } from '../middleware/product-save-schemas.js';
import { savedItemsHandler } from '../controllers/product-saves.controller.js';

const router = Router();

router.use(authenticateToken);

router.get(
  '/',
  makeRateLimiter('listings'),
  validateQuery(savedItemsQuerySchema),
  savedItemsHandler,
);

export default router;
