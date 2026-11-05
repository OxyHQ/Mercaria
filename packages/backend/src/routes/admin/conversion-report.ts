/**
 * The checkout conversion report sub-router, mounted at
 * `/admin/stores/:storeId/analytics/advanced` — the paid
 * `advanced_demand_analytics` tool (#89).
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`. Every route is `stats:read` (the #77
 * summary's permission and the sales reports') and then the plan gate.
 *
 * A SEPARATE router from `routes/admin/analytics.ts`, deliberately: that one is
 * #77's discovery-telemetry surface, which reads no order and no plan, and it
 * stays exactly as it is. This one reads orders and is plan-gated, so it lives
 * with the order-sourced reports and only shares the URL prefix.
 */

import { Router } from 'express';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  exportConversionReportHandler,
  getConversionTrendHandler,
  getListingConversionHandler,
  requireConversionReportCapability,
} from '../../controllers/admin/conversion-report-admin.controller.js';

const router = Router({ mergeParams: true });

const guards = [requireStorePermission('stats:read'), requireConversionReportCapability];

router.get('/listings', ...guards, getListingConversionHandler);
router.get('/trend', ...guards, getConversionTrendHandler);
router.get('/export', ...guards, exportConversionReportHandler);

export default router;
