/**
 * `/price-history` — the PUBLIC read of a product's or a variant's price
 * history (#78 §"API and UI").
 *
 * No auth: an observed price is public commercial information with no
 * viewer-specific hydration, exactly like `/offers`. Rate-limited under the
 * `'listings'` read budget, the same scope the comparison read uses.
 *
 * There is deliberately NO write route, and no alert route. Observations are
 * produced by the offer write path from a source Mercaria actually read, and
 * price ALERTS belong to #79 — the `ProductSavePriceAlert` seam #80 published
 * still has one branch and it is the unsupported one, so a client renders
 * nothing rather than a control claiming an unbuilt feature exists.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { priceHistoryQuerySchema } from '../middleware/price-history-schemas.js';
import { getPriceHistoryHandler } from '../controllers/price-history.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /price-history — one named segment, one named measure, one named currency. */
router.get('/', validateQuery(priceHistoryQuerySchema), getPriceHistoryHandler);

export default router;
