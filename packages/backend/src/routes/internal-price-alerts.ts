/**
 * `/internal/price-alerts/*` — the price-alert operator surface (#79).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54, #55, #56, #57,
 * #58, #59, #60, #62, #68, #78, #80, #83, #90 and #94 use, and NOT a seventh
 * list. An alert points at a canonical product and is decided from the
 * catalogue's own offers, freshness and eligibility — who may reshape that
 * catalogue and who may see why an alert did not fire are the same power over
 * the same graph.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 *
 * ## The route set is CLOSED, and the omissions are the design
 *
 * TWO reads and ONE write, and the write DRIVES the existing idempotent
 * evaluation. There is deliberately no "trigger this alert", no "send this
 * notification again", no "set this alert triggered" and no "delete this
 * trigger" — the first three would be ways to tell a buyer something no price
 * ever justified, and the fourth would let somebody remove the evidence that one
 * had been.
 *
 * ## And it cannot be asked who is watching a product
 *
 * Every route is keyed on an ALERT ID. There is no product, merchant or account
 * handle anywhere in this file, so issue abuse rule 6 — analytics must not
 * expose one user's targets to merchants — holds because the question is
 * unrepresentable rather than because a handler filters it out.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateId } from '../middleware/validate.js';
import {
  priceAlertMetricsHandler,
  priceAlertReevaluateHandler,
  priceAlertTraceHandler,
} from '../controllers/price-alerts.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — evaluation lag, trigger count, delivery rate, stale-link suppression. */
router.get('/metrics', priceAlertMetricsHandler);

/** GET — one alert's whole history: triggers, quotes, deliveries, queue state. */
router.get('/alerts/:alertId', validateId('alertId'), priceAlertTraceHandler);

/** POST — ask for this alert's subject to be evaluated now. Drives the queue. */
router.post('/alerts/:alertId/evaluate', validateId('alertId'), priceAlertReevaluateHandler);

export default router;
