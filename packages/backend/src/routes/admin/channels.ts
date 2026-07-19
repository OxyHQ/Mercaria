import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { connectChannelSchema, updateSyncSettingsSchema } from '../../middleware/schemas.js';
import { connectKeyChannelSchema } from '../../middleware/channels-schemas.js';
import {
  listChannelsHandler,
  connectChannelHandler,
  connectKeyChannelHandler,
  patchChannelSettingsHandler,
  syncChannelHandler,
  disconnectChannelHandler,
} from '../../controllers/admin/channels-admin.controller.js';

/**
 * Store channels (connectors) sub-router, mounted at
 * `/admin/stores/:storeId/channels`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router already ran
 * `authenticateToken` → `loadStore` (and the `/admin` root applies the admin
 * rate limiter), so `req.store`/`req.storeMembership` are set. EVERY route is
 * gated on `channels:write` (owner + admin only; staff never configure
 * integrations). Credentials never appear in any response.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('channels:write'), listChannelsHandler);

router.post(
  '/:provider/connect',
  requireStorePermission('channels:write'),
  validateBody(connectChannelSchema),
  connectChannelHandler,
);

// API-key connect (WooCommerce): rate-limited on the shared `channels` scope, as
// it verifies the credentials against the merchant's site on every call.
router.post(
  '/:provider/connect-key',
  makeRateLimiter('channels'),
  requireStorePermission('channels:write'),
  validateBody(connectKeyChannelSchema),
  connectKeyChannelHandler,
);

router.patch(
  '/:connectionId/settings',
  requireStorePermission('channels:write'),
  validateObjectId('connectionId'),
  validateBody(updateSyncSettingsSchema),
  patchChannelSettingsHandler,
);

router.post(
  '/:connectionId/sync',
  requireStorePermission('channels:write'),
  validateObjectId('connectionId'),
  syncChannelHandler,
);

router.delete(
  '/:connectionId',
  requireStorePermission('channels:write'),
  validateObjectId('connectionId'),
  disconnectChannelHandler,
);

export default router;
