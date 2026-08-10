/**
 * `/internal/price-history/*` — the price-history operator surface (#78
 * §"Operations").
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/
 * #62/#68 use, and deliberately not a seventh list: who may decide what a
 * source is permitted to publish and who may read what it published are the
 * same power over the same graph. Empty list = the router is not mounted at all
 * (404, never a 401 that would advertise the surface), and it STAYS mounted
 * while `PRICE_HISTORY_ENABLED` is off — the evidence has to be readable during
 * the incident that turned the loop off.
 *
 * ## Two reads and ONE write, and the omissions are the design
 *
 * There is no "set this point", no "hide this observation", no "correct this
 * price" and no delete of any kind. Every one of those would be a way to make a
 * price history say something nobody observed, which is the single property
 * that makes it worth keeping. A CORRECTION is a superseding observation
 * written by the path that observed it; a rebuild is a trigger for the
 * derivation that already runs; and a retention deletion belongs to the shared
 * expiry sweep, which answers to a source's own agreement rather than to an
 * operator's judgement.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  priceHistoryMetricsQuerySchema,
  priceHistoryRebuildSchema,
} from '../middleware/price-history-schemas.js';
import {
  priceHistoryMetricsHandler,
  priceHistoryOfferTraceHandler,
  priceHistoryRebuildHandler,
} from '../controllers/price-history.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — write volume, deduplication rate and aggregation lag. */
router.get('/metrics', validateQuery(priceHistoryMetricsQuerySchema), priceHistoryMetricsHandler);

/** GET — one offer's whole observation trail, oldest first. */
router.get('/offers/:offerId', priceHistoryOfferTraceHandler);

/** POST — re-arm one series now instead of waiting for the next observation. */
router.post(
  '/series/rebuild',
  validateBody(priceHistoryRebuildSchema),
  priceHistoryRebuildHandler,
);

export default router;
