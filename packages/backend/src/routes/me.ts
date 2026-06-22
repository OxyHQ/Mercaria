import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { updateCurrencyPreferenceSchema } from '../middleware/schemas.js';
import {
  getCurrencyPreference,
  updateCurrencyPreference,
} from '../controllers/currency-preference.controller.js';

/**
 * Current-user (`/me`) API — the authenticated consumer's own marketplace
 * preferences. Every route requires a real Oxy user (`authenticateToken`).
 *
 * Currently exposes the dual-currency DISPLAY preference, which is
 * presentation-only and never affects stored amounts (every price stays FAIR).
 */
const router = Router();

router.use(makeRateLimiter('general'), authenticateToken);

router.get('/currency-preference', getCurrencyPreference);
router.put(
  '/currency-preference',
  validateBody(updateCurrencyPreferenceSchema),
  updateCurrencyPreference,
);

export default router;
