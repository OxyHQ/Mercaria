import { Router } from 'express';
import { validateBody, validateId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { connectChannelSchema, updateSyncSettingsSchema } from '../../middleware/schemas.js';
import {
  advanceChannelOnboardingSchema,
  connectKeyChannelSchema,
  disconnectChannelSchema,
  pauseChannelSchema,
  startChannelOnboardingSchema,
} from '../../middleware/channels-schemas.js';
import {
  listChannelsHandler,
  connectChannelHandler,
  connectKeyChannelHandler,
  patchChannelSettingsHandler,
  reregisterChannelWebhooksHandler,
  syncChannelHandler,
  disconnectChannelHandler,
} from '../../controllers/admin/channels-admin.controller.js';
import {
  abandonChannelOnboardingHandler,
  activateChannelOnboardingHandler,
  advanceChannelOnboardingHandler,
  disconnectChannelWithPolicyHandler,
  getChannelOnboardingHandler,
  getChannelReadinessHandler,
  getChannelReconciliationHandler,
  listChannelAuditHandler,
  listChannelCatalogHandler,
  listChannelOnboardingHandler,
  listChannelRunsHandler,
  listChannelSummaryHandler,
  pauseChannelHandler,
  startChannelOnboardingHandler,
} from '../../controllers/admin/channels-catalog.controller.js';

/**
 * Store channels sub-router, mounted at `/admin/stores/:storeId/channels`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router already ran
 * `authenticateToken` → `loadStore` (and the `/admin` root applies the admin
 * rate limiter), so `req.store`/`req.storeMembership` are set. EVERY route is
 * gated on `channels:write` (owner + admin only; staff never configure
 * integrations). Credentials never appear in any response.
 *
 * ## Route ORDER is load-bearing here
 *
 * `/catalog`, `/summary`, `/readiness`, `/audit` and `/onboarding` are LITERAL
 * segments that would otherwise be captured by `/:connectionId` and
 * `/:provider`. Express matches in declaration order, so every literal path is
 * declared BEFORE the parameterized ones — and `validateId('connectionId')`
 * would then reject `catalog` as a malformed id, which reads as a client bug
 * rather than as a routing one. They are grouped together with this note so a
 * later addition lands above the line rather than below it.
 */
const router = Router({ mergeParams: true });

// ── Literal paths, declared before every parameterized route ────────────────

/** #87: what may be connected on this deployment, and what is wrong with each. */
router.get('/catalog', requireStorePermission('channels:write'), listChannelCatalogHandler);

/** #87: connectors, feeds and the native catalogue in ONE shape. */
router.get('/summary', requireStorePermission('channels:write'), listChannelSummaryHandler);

/** #87 acceptance 7: the ONE authoritative readiness result. */
router.get('/readiness', requireStorePermission('channels:write'), getChannelReadinessHandler);

/** #87 security 7: who changed what about this store's channels. */
router.get('/audit', requireStorePermission('channels:write'), listChannelAuditHandler);

router.get('/onboarding', requireStorePermission('channels:write'), listChannelOnboardingHandler);

router.post(
  '/onboarding',
  requireStorePermission('channels:write'),
  validateBody(startChannelOnboardingSchema),
  startChannelOnboardingHandler,
);

router.get(
  '/onboarding/:sessionId',
  requireStorePermission('channels:write'),
  validateId('sessionId'),
  getChannelOnboardingHandler,
);

router.patch(
  '/onboarding/:sessionId',
  requireStorePermission('channels:write'),
  validateId('sessionId'),
  validateBody(advanceChannelOnboardingSchema),
  advanceChannelOnboardingHandler,
);

router.post(
  '/onboarding/:sessionId/activate',
  requireStorePermission('channels:write'),
  validateId('sessionId'),
  activateChannelOnboardingHandler,
);

router.delete(
  '/onboarding/:sessionId',
  requireStorePermission('channels:write'),
  validateId('sessionId'),
  abandonChannelOnboardingHandler,
);

// ── Parameterized paths ─────────────────────────────────────────────────────

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
  validateId('connectionId'),
  validateBody(updateSyncSettingsSchema),
  patchChannelSettingsHandler,
);

router.post(
  '/:connectionId/sync',
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  syncChannelHandler,
);

/**
 * #262: register this channel's platform webhooks again, without a reconnect.
 *
 * Rate-limited on the `channels` bucket rather than the general admin one, for
 * `connect-key`'s reason: every call reaches the merchant's own platform, and this
 * one deletes and recreates subscriptions on a `per_connection` provider. The
 * connection's registration LEASE is what makes a burst safe rather than merely
 * bounded — a second request while one is in flight finds the claim held and does
 * nothing.
 */
router.post(
  '/:connectionId/webhooks/reregister',
  makeRateLimiter('channels'),
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  reregisterChannelWebhooksHandler,
);

/** #87 management 1 and 8: what happened while nobody was watching. */
router.get(
  '/:connectionId/runs',
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  listChannelRunsHandler,
);

/**
 * #87 reconcile: what Mercaria already indexed for this merchant.
 *
 * Rate-limited on the `channels` bucket rather than the general admin one: it
 * reads two bounded offer sets and runs #84's overlap fold over them, so a
 * screen refreshing in a loop is a real cost. It makes no outbound request.
 */
router.get(
  '/:connectionId/reconciliation',
  makeRateLimiter('channels'),
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  getChannelReconciliationHandler,
);

/** #87 management 4: pause fetch and publication independently. */
router.post(
  '/:connectionId/pause',
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  validateBody(pauseChannelSchema),
  pauseChannelHandler,
);

/** #87 management 7: disconnect with an explicit policy for what it produced. */
router.post(
  '/:connectionId/disconnect',
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  validateBody(disconnectChannelSchema),
  disconnectChannelWithPolicyHandler,
);

/**
 * The v1 disconnect, kept because a shipped dashboard build calls it.
 *
 * It maps to `keep_listings`, which is exactly what this route has always
 * done — see the handler's note. It retires when supported dashboard versions
 * have migrated to the POST above.
 */
router.delete(
  '/:connectionId',
  requireStorePermission('channels:write'),
  validateId('connectionId'),
  disconnectChannelHandler,
);

export default router;
