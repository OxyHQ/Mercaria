import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { getRates } from '../controllers/rates.controller.js';

/**
 * FX rates API.
 *
 * PUBLIC — consumer clients fetch conversion rates for dual-currency display.
 * FAIR is canonical; this is a presentation-only read path that never mutates
 * stored amounts. No auth required.
 *
 * A dedicated `'rates'` rate-limit scope keeps a distinct `rl:rates:` Redis
 * prefix so its counter never collides with the global `general` limiter.
 */
const router = Router();

router.use(makeRateLimiter('rates'));

/**
 * GET /rates
 * Conversion rates for a `base` (default FAIR) against a comma `quote` list.
 */
router.get('/', getRates);

export default router;
