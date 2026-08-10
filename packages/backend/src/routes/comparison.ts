/**
 * `/comparison/*` — the grounded comparison and basket surface (#96).
 *
 * POST rather than GET on all three, and that is a contract decision rather
 * than a convenience: a comparison carries a constraint SET and a basket
 * carries a line list, and both are structured values a query string can only
 * encode by inventing a second grammar for the one #94 already defines. The
 * reads are still reads — nothing here writes a row, and this domain owns no
 * table at all.
 *
 * `optionalAuth`, not `authenticateToken`: a comparison is public commercial
 * information, and the signed-in half is a currency preference and a watchlist.
 * A guest solves a basket by sending lines.
 *
 * Rate-limited under the `'listings'` scope — the same read-path budget
 * `/offers`, `/offer-comparison` and `/product-page` use. A basket is several
 * of those reads at once, which is what {@link MAX_BASKET_LINES} bounds.
 *
 * There is deliberately NO write route and none may be added. A "save this
 * plan", "pin this merchant" or "boost this offer" endpoint would be a stored
 * plan served later — the stale plan UX rule 9 forbids — or a placement control
 * outside #74's versioned policy. Saving a result belongs to #81's watchlist,
 * where a saved thing is explicitly a saved thing.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  basketRevalidateSchema,
  basketSolveSchema,
  productComparisonSchema,
} from '../middleware/comparison-schemas.js';
import {
  compareProductsHandler,
  revalidateBasketHandler,
  solveBasketHandler,
} from '../controllers/comparison.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'), optionalAuth);

/** POST /comparison — the deterministic table, the tradeoffs and the explanation. */
router.post('/', validateBody(productComparisonSchema), compareProductsHandler);

/** POST /comparison/basket — every named plan, with its optimality status. */
router.post('/basket', validateBody(basketSolveSchema), solveBasketHandler);

/** POST /comparison/basket/revalidate — before navigation or checkout. */
router.post(
  '/basket/revalidate',
  validateBody(basketRevalidateSchema),
  revalidateBasketHandler,
);

export default router;
