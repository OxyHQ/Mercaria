/**
 * `/internal/discovery/*` — the operator trigger for the discovery sweep.
 *
 * `routes/internal-analytics.ts`'s shape, on that SAME key rather than
 * a new one: `analytics.operate` already gates
 * `/internal/analytics/*` and the merchant-demand acquisition pipeline, and
 * forcing a recomputation of counts derived from analytics events
 * (`docs/discovery.md`) is the power that key already grants. Mounted on every
 * deployment; anyone without the key is answered 404, never a 401 that would
 * advertise the surface.
 *
 * Authentication FIRST, then the operator gate — it asks Oxy about the verified
 * caller's own session, which only `authenticateToken` establishes.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireAnalyticsOperator } from '../middleware/operator-authz.js';
import { runDiscoverySweepNowHandler } from '../controllers/discovery-operator.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(requireAnalyticsOperator);

/** Force the next sweep tick now. Not a repair — see the controller. */
router.post('/sweep', runDiscoverySweepNowHandler);

export default router;
