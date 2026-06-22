import { Router } from 'express';
import { validateQuery } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { salesReportQuerySchema, topProductsQuerySchema } from '../../middleware/schemas.js';
import {
  getReportSummary,
  getSalesReportHandler,
  getTopProductsHandler,
} from '../../controllers/admin/reports-admin.controller.js';

/**
 * Store reports sub-router, mounted at `/admin/stores/:storeId/reports`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * Every report is read-only and gated on `stats:read` (the same permission the
 * dashboard `orders/stats` uses — owner, admin and staff all hold it).
 */
const router = Router({ mergeParams: true });

const requireStats = requireStorePermission('stats:read');

router.get('/summary', requireStats, getReportSummary);
router.get('/sales', requireStats, validateQuery(salesReportQuerySchema), getSalesReportHandler);
router.get(
  '/top-products',
  requireStats,
  validateQuery(topProductsQuerySchema),
  getTopProductsHandler,
);

export default router;
