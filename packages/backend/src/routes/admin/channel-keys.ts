import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { generateChannelKeySchema } from '../../middleware/channels-schemas.js';
import {
  generateChannelKeyHandler,
  listChannelKeysHandler,
  revokeChannelKeyHandler,
} from '../../controllers/admin/channel-keys.controller.js';

/**
 * Channel API keys sub-router, mounted at `/admin/stores/:storeId/channel-keys`.
 *
 * `mergeParams` so `:storeId` is visible. The parent already ran
 * `authenticateToken` → `loadStore` (and `/admin` applies the admin limiter), so
 * `req.store`/`req.storeMembership` are set. EVERY route is gated on
 * `channels:write` (owner + admin only; staff never configure integrations) —
 * the same gate as the channels routers. Minting is additionally metered on the
 * shared `channels` scope since it creates a durable credential. The plaintext
 * key is emitted by the generate route ONLY and never again.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('channels:write'), listChannelKeysHandler);

router.post(
  '/',
  makeRateLimiter('channels'),
  requireStorePermission('channels:write'),
  validateBody(generateChannelKeySchema),
  generateChannelKeyHandler,
);

router.delete(
  '/:keyId',
  requireStorePermission('channels:write'),
  validateObjectId('keyId'),
  revokeChannelKeyHandler,
);

export default router;
