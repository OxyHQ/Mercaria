/**
 * `/price-signals` — the PUBLIC read of one subject's price signals (#82 §"UI").
 *
 * No auth: a signal is derived from offers Mercaria already publishes, with no
 * viewer-specific hydration, exactly like `/offers` and `/price-history`.
 * Rate-limited under the `'listings'` read budget, the same scope the comparison
 * and history reads use.
 *
 * There is deliberately NO write route. A signal is DERIVED from immutable
 * observations under a published policy version; an HTTP surface able to submit
 * one would be a way to publish a claim about a price nobody measured, which is
 * the single property that makes the claim worth making.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { priceSignalsQuerySchema } from '../middleware/price-signal-schemas.js';
import { getPriceSignalsHandler } from '../controllers/price-signals.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /price-signals — one named segment, one named currency, one named market. */
router.get('/', validateQuery(priceSignalsQuerySchema), getPriceSignalsHandler);

export default router;
