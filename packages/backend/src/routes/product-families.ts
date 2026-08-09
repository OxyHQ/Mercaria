/**
 * Product families API (#56) — PUBLIC reads over the canonical family layer.
 *
 * A family is a NAVIGATION grouping (ADR 0002 D2): brand → family → product is
 * the path #72's brand page walks. Nothing here writes; families are created
 * explicitly through `/internal/canonical-catalog`, never derived from a source
 * (a family must not exist because two titles share a word).
 *
 * Same auth, rate-limit and route-order reasoning as `canonical-products.ts`.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { getProductFamily } from '../controllers/canonical-products.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /product-families/:idOrSlug — public projection; merge tombstones redirect. */
router.get('/:idOrSlug', getProductFamily);

export default router;
