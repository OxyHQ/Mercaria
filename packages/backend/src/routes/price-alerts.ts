/**
 * `/price-alerts` — a buyer's own price conditions (#79).
 *
 * Mounted only when `PRICE_ALERTS_ENABLED`, so a deployment that has not adopted
 * #79 answers 404. The ALERTS themselves are never gated by anything: a row
 * already stored stays stored, keeps being evaluated and comes back when the
 * flag does — a flag that hid a person's alerts would make the rollback lever
 * cost them the thing they were waiting for.
 *
 * Metered on the `'listings'` scope, #80's reasoning exactly: an alert is a
 * catalogue-shaped read/write at the same rate and volume, and every route here
 * is keyed on a CATALOGUE id or on the caller's own alert id rather than on an
 * Oxy account id, so enumeration is not the risk that earned `'sellers'` its own
 * bucket. The two axes that ARE this domain's own — how many alerts an account
 * may hold and how fast it may create them — are counted in Postgres, because
 * "across every ECS task" is not a question a per-IP bucket can answer.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  createPriceAlertSchema,
  listPriceAlertsQuerySchema,
  priceAlertSuggestionQuerySchema,
  resolvePriceAlertSplitSchema,
  updatePriceAlertSchema,
} from '../middleware/price-alert-schemas.js';
import {
  createPriceAlertHandler,
  deletePriceAlertHandler,
  getPriceAlertHandler,
  listPriceAlertsHandler,
  priceAlertSuggestionHandler,
  resolvePriceAlertSplitHandler,
  updatePriceAlertHandler,
} from '../controllers/price-alerts.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('listings'));

/**
 * The literal path comes FIRST, or `/:alertId` swallows it.
 *
 * `suggestion` reads the current market and creates NOTHING (UX rule 2) — it is
 * a GET for exactly that reason.
 */
router.get(
  '/suggestion',
  validateQuery(priceAlertSuggestionQuerySchema),
  priceAlertSuggestionHandler,
);

router.get('/', validateQuery(listPriceAlertsQuerySchema), listPriceAlertsHandler);
router.post('/', validateBody(createPriceAlertSchema), createPriceAlertHandler);

router.get('/:alertId', validateId('alertId'), getPriceAlertHandler);
router.patch(
  '/:alertId',
  validateId('alertId'),
  validateBody(updatePriceAlertSchema),
  updatePriceAlertHandler,
);
router.delete('/:alertId', validateId('alertId'), deletePriceAlertHandler);

/** Answer a split ambiguity — the one route about which PRODUCT an alert meant. */
router.post(
  '/:alertId/resolve-split',
  validateId('alertId'),
  validateBody(resolvePriceAlertSplitSchema),
  resolvePriceAlertSplitHandler,
);

export default router;
