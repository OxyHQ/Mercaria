/**
 * A store's competitive price analytics (#89's `competitive_price_analytics`
 * tool), mounted at `/admin/stores/:storeId/price-analytics`.
 *
 * The parent has already run `authenticateToken` → `loadStore`, so `:storeId`
 * is a store the caller belongs to.
 *
 * ## `analytics:read`, not `stats:read` or `products:read`
 *
 * `analytics:read` is the permission `STORE_PERMISSIONS` defines for exactly
 * this class of question — "what is the market doing around my products" — as
 * opposed to `stats:read`'s "how did my shop trade". How a store's prices sit
 * against every other seller's is commercial strategy rather than shop-floor
 * information, so by default it is the owner's, the admins' and billing's, and
 * anyone else needs a grant; `products:read` would hand it to every viewer and
 * developer.
 *
 * ## The plan gate comes second
 *
 * `requireStorePermission` first, then the capability, so a member without the
 * permission is told about the permission and nothing about the store's plan.
 * Every route computes a new report, which is the tool's work, so every route is
 * gated; the tool stores nothing, so there is nothing of the store's to keep
 * readable after a plan ends.
 *
 * Its own rate-limit bucket (`rl:storePriceAnalytics:`): one overview costs a
 * comparison read per listing, up to 200, which is a different budget from the
 * rest of `/admin`.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { validateId, validateQuery } from '../../middleware/validate.js';
import {
  storePriceAnalyticsQuerySchema,
  storePriceTrendQuerySchema,
} from '../../middleware/store-price-benchmark-schemas.js';
import {
  getStorePriceAnalyticsHandler,
  getStorePriceTrendHandler,
  requirePriceAnalyticsCapability,
} from '../../controllers/admin/store-price-benchmark.controller.js';

const router = Router({ mergeParams: true });

router.use(
  makeRateLimiter('storePriceAnalytics'),
  requireStorePermission('analytics:read'),
  requirePriceAnalyticsCapability,
);

/** GET — every live, matched listing variant against its comparison; `format=csv` exports it. */
router.get(
  '/listings',
  validateQuery(storePriceAnalyticsQuerySchema),
  getStorePriceAnalyticsHandler,
);

/** GET — one listing variant's price against its comparison over time. */
router.get(
  '/listings/:productVariantId/trend',
  validateId('productVariantId'),
  validateQuery(storePriceTrendQuerySchema),
  getStorePriceTrendHandler,
);

export default router;
