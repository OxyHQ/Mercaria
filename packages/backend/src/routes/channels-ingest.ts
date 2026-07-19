import { Router } from 'express';
import { requireChannelKey } from '../middleware/channel-key-auth.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { ingestProductsSchema, ingestInventorySchema } from '../middleware/schemas.js';
import {
  keyIngestProductsHandler,
  keyIngestInventoryHandler,
} from '../controllers/channel-ingest-key.controller.js';

/**
 * Channel-key ingestion router, mounted at `/channels/ingest`.
 *
 * This is the NON-`/admin`, token-free ingest surface the external push client
 * (e.g. the Mercaria WooCommerce plugin) reaches with only a long-lived channel
 * key. Every route is metered on the shared `channels` rate-limit scope (keyed
 * per-IP for these unauthenticated-to-Oxy callers) BEFORE key verification, then
 * authenticated by `requireChannelKey` (which sets `req.channelKey`). The bodies
 * and idempotent behavior mirror the admin ingest routes exactly — the handlers
 * delegate to the SAME `channel-ingest.service` funnels.
 */
const router = Router();

router.use(makeRateLimiter('channels'), requireChannelKey);

router.post(
  '/:connectionId/products',
  validateObjectId('connectionId'),
  validateBody(ingestProductsSchema),
  keyIngestProductsHandler,
);

router.post(
  '/:connectionId/inventory',
  validateObjectId('connectionId'),
  validateBody(ingestInventorySchema),
  keyIngestInventoryHandler,
);

export default router;
