/**
 * `/internal/shopping-agents` — the operator surface, and it is ONE route.
 *
 * #97 cost rule 6 asks that queue lag, evaluation cost, notification yield and
 * duplicate suppression be monitored. Every one of those is an aggregate, and
 * aggregates are the whole of what this surface serves.
 *
 * ## There is deliberately no trace
 *
 * Every other operator surface in this repo opens a trace from some handle.
 * This one opens from nothing, and cannot be given one: a saved agent is a
 * person's stated intent in their own words, and #97 privacy 3 says it is
 * visible to its owner and to authorized services. So there is no route here
 * that takes an agent id, an account id or a canonical product, and none may be
 * added — "who is watching this product" is unrepresentable rather than
 * refused.
 *
 * Mounted on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
 * #54/#56/#57/#58/#60/#62/#68/#70/#78/#79 use, and deliberately NOT gated on
 * `SHOPPING_AGENTS_ENABLED`: the evidence has to be readable during the
 * incident that turned the shopper surface off.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { shoppingAgentMetricsHandler } from '../controllers/shopping-agents.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — queue lag, evaluation counts, notification yield, suppression split. */
router.get('/metrics', shoppingAgentMetricsHandler);

export default router;
