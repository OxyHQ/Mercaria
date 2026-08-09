/**
 * Store analytics sub-router, mounted at `/admin/stores/:storeId/analytics`
 * (#77 "Merchant analytics").
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are
 * set, and `:storeId` is therefore a store the caller is a member of rather
 * than a value they typed — which is what makes "their OWN offers" (merchant
 * rule 1) structural rather than a filter this file has to remember.
 *
 * Gated on `stats:read`, the SAME permission the sales reports use. Deliberate:
 * "how many people saw my products" and "how much did I sell" are the same
 * class of question about the same store, and giving discovery analytics a
 * permission of its own would mean a role matrix where a staff member can read
 * revenue and not impressions, which nobody could explain.
 *
 * NOT the sales reports at `/admin/stores/:storeId/reports/*`. Those are the
 * ORDER-sourced surface; this one is discovery telemetry with privacy
 * thresholds, and merging them would put a suppressed figure next to an exact
 * one under one heading.
 */

import { Router } from 'express';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { getStoreAnalyticsHandler } from '../../controllers/admin/analytics-admin.controller.js';

const router = Router({ mergeParams: true });

/** GET /admin/stores/:storeId/analytics/summary */
router.get('/summary', requireStorePermission('stats:read'), getStoreAnalyticsHandler);

export default router;
