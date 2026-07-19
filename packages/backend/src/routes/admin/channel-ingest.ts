import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import {
  connectPushChannelSchema,
  ingestProductsSchema,
  ingestInventorySchema,
} from '../../middleware/schemas.js';
import {
  connectPushChannelHandler,
  ingestProductsHandler,
  ingestInventoryHandler,
} from '../../controllers/admin/channel-ingest.controller.js';

/**
 * Channel ingestion (`push_in`) sub-router, mounted as a SIBLING of the pull
 * channels router at `/admin/stores/:storeId/channels`. Their routes are disjoint
 * (`connect-push` / `ingest/*` here vs `connect` / `sync` / `settings` there), so
 * the pull router falls through to this one for ingest paths.
 *
 * `mergeParams` so `:storeId` is visible. The parent already ran
 * `authenticateToken` → `loadStore` (and `/admin` applies the admin limiter), so
 * `req.store`/`req.storeMembership` are set. Every route is metered on the shared
 * `channels` rate-limit scope and gated on `channels:write` (owner + admin only;
 * staff never configure integrations). The external push client authenticates as
 * the store's Oxy user holding that permission.
 */
const router = Router({ mergeParams: true });

router.use(makeRateLimiter('channels'));

router.post(
  '/:provider/connect-push',
  requireStorePermission('channels:write'),
  validateBody(connectPushChannelSchema),
  connectPushChannelHandler,
);

router.post(
  '/:connectionId/ingest/products',
  requireStorePermission('channels:write'),
  validateObjectId('connectionId'),
  validateBody(ingestProductsSchema),
  ingestProductsHandler,
);

router.post(
  '/:connectionId/ingest/inventory',
  requireStorePermission('channels:write'),
  validateObjectId('connectionId'),
  validateBody(ingestInventorySchema),
  ingestInventoryHandler,
);

export default router;
