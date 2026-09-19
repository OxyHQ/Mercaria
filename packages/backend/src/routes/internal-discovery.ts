/**
 * `/internal/discovery/*` — the operator trigger for the discovery sweep.
 *
 * `routes/internal-analytics.ts`'s shape, on that SAME allow-list rather than
 * a new one: `ANALYTICS_OPERATOR_OXY_USER_IDS` already gates
 * `/internal/analytics/*` and the merchant-demand acquisition pipeline, and
 * forcing a recomputation of counts derived from analytics events
 * (`docs/discovery.md`) is the power that list already holds. Mount gated on
 * the allow-list being non-empty (404 on a deployment with no operators,
 * never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 *
 * Authentication FIRST, then the allow-list — the gate reads the verified
 * caller, and an allow-list consulted before authentication would compare
 * against whatever a client claimed.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireAnalyticsOperator } from '../middleware/analytics-operator-authz.js';
import { runDiscoverySweepNowHandler } from '../controllers/discovery-operator.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(requireAnalyticsOperator);

/** Force the next sweep tick now. Not a repair — see the controller. */
router.post('/sweep', runDiscoverySweepNowHandler);

export default router;
