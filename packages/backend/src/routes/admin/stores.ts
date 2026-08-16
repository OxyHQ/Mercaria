import { Router } from 'express';
import { config } from '../../config/index.js';
import { validateBody, validateId } from '../../middleware/validate.js';
import { loadStore, requireStorePermission } from '../../middleware/store-authz.js';
import {
  createStoreSchema,
  updateStoreSchema,
  updateStoreSettingsSchema,
  updateTaxSettingsSchema,
} from '../../middleware/schemas.js';
import {
  createStoreHandler,
  listMyStores,
  getStoreHandler,
  updateStoreHandler,
  updateStoreSettingsHandler,
} from '../../controllers/admin/store-admin.controller.js';
import { patchStoreTaxSettings } from '../../controllers/admin/tax-rates-admin.controller.js';
import membersRouter from './members.js';
import productsRouter from './products.js';
import ordersRouter from './orders.js';
import locationsRouter from './locations.js';
import collectionsRouter from './collections.js';
import discountsRouter from './discounts.js';
import taxRatesRouter from './tax-rates.js';
import customersRouter from './customers.js';
import draftOrdersRouter from './draft-orders.js';
import refundsRouter from './refunds.js';
import reportsRouter from './reports.js';
import channelsRouter from './channels.js';
import channelIngestRouter from './channel-ingest.js';
import channelKeysRouter from './channel-keys.js';
import paymentsRouter from './payments.js';
import feedsRouter from './feeds.js';
import feesRouter from './fees.js';
import merchantActivationRouter from './merchant-activation.js';
import referralPartnerRouter from './referral-partner.js';
import planRouter from './plan.js';
import analyticsRouter from './analytics.js';

/**
 * Store-admin router, mounted at `/admin/stores`.
 *
 * `POST /` (create — caller becomes owner) and `GET /` (caller's stores) do NOT
 * use `loadStore`. Everything under `/:storeId` runs `loadStore` first (resolve
 * + member check, attaching `req.store`/`req.storeMembership`), then per-route
 * role/permission guards. The members + products sub-routers inherit the loaded
 * store via `mergeParams`.
 */
const router = Router();

// Caller-scoped (no loadStore).
router.post('/', validateBody(createStoreSchema), createStoreHandler);
router.get('/', listMyStores);

// Store-scoped: load + authorize the store for every nested route.
router.use('/:storeId', validateId('storeId'), loadStore);

router.get('/:storeId', getStoreHandler);
router.patch(
  '/:storeId',
  requireStorePermission('store:manage'),
  validateBody(updateStoreSchema),
  updateStoreHandler,
);

// Store settings (policies/notifications/tax): gated on `settings:write`. The
// dedicated `/settings/tax` path stays for the focused B4 tax-only update; the
// broader `/settings` path patches policies + notification prefs (+ tax) at once.
router.patch(
  '/:storeId/settings/tax',
  requireStorePermission('settings:write'),
  validateBody(updateTaxSettingsSchema),
  patchStoreTaxSettings,
);
router.patch(
  '/:storeId/settings',
  requireStorePermission('settings:write'),
  validateBody(updateStoreSettingsSchema),
  updateStoreSettingsHandler,
);

router.use('/:storeId/members', membersRouter);
router.use('/:storeId/products', productsRouter);
router.use('/:storeId/orders', ordersRouter);
router.use('/:storeId/locations', locationsRouter);
router.use('/:storeId/collections', collectionsRouter);
router.use('/:storeId/discounts', discountsRouter);
router.use('/:storeId/tax-rates', taxRatesRouter);
router.use('/:storeId/customers', customersRouter);
router.use('/:storeId/draft-orders', draftOrdersRouter);
router.use('/:storeId/refunds', refundsRouter);
router.use('/:storeId/reports', reportsRouter);
router.use('/:storeId/channels', channelsRouter);
// Push-in ingestion routes (connect-push, ingest/*); sibling of the pull router.
router.use('/:storeId/channels', channelIngestRouter);
// Channel API keys (mint / list / revoke) for the token-free ingest path.
router.use('/:storeId/channel-keys', channelKeysRouter);
// Payment onboarding (ADR 0001 D9). Deliberately NOT under `/channels`: a sales
// channel is where a catalogue is listed and this is where money is settled, and
// issue #46 (UX 5) keeps the two separate concepts everywhere they appear.
router.use('/:storeId/payments', paymentsRouter);
// The marketplace fee schedule the store sells under (#88): read, terms
// acceptance and fee/net preview. Beside `/payments` and not inside it — the
// fee is a COMMERCIAL agreement with Mercaria, not a property of any rail.
router.use('/:storeId/fees', feesRouter);
// Merchant activation readiness (#85), behind `store:manage` — the same
// permission fees and payment onboarding use, because accepting the
// responsibilities that come with taking orders is the same kind of binding
// commercial act. Deliberately NOT under `/channels`: a channel is where a
// catalogue comes from, and activation is whether this business may sell.
router.use('/:storeId/activation', merchantActivationRouter);
// This store's REFERRAL PARTNER record (#146 increment 2), behind
// `store:manage` — the same permission activation, fees and payment onboarding
// use, and for the same reason: enrolling a business in an arrangement that
// will pay it money is a binding commercial act, and the partner's display name
// is public. SINGULAR (`referral-partner`) because it is this store's own one
// record; `/referrals` is the buyer edge and has nothing to do with it.
//
// Mounting it HERE is how the referral domain consumes the "may this account
// act for this store" answer instead of deriving a second one — see the
// router's own docblock.
if (config.referrals.partnerEnrollmentEnabled) {
  router.use('/:storeId/referral-partner', referralPartnerRouter);
}
// The store's own plan, entitlements and optional subscription billing (#89).
// Beside `/fees` and not inside it: a marketplace fee is what Mercaria takes
// from a SALE, and a plan is what a merchant pays Mercaria for TOOLING. They are
// two versioned policies with different lifecycles, and no plan selects a fee
// schedule — which is easier to keep true when the two surfaces are separate.
router.use('/:storeId/plan', planRouter);
// The product-feed importer (#63), behind `channels:write` — a feed is a sales
// channel's inventory arriving by file, which is the same permission connecting
// a Shopify shop needs. Deliberately NOT under `/channels`: a connector pushes
// Mercaria's state to a platform a store operates, and a feed reads somebody
// else's catalogue in. Collapsing them would put an inbound file behind a
// surface whose whole vocabulary is outbound.
router.use('/:storeId/feeds', feedsRouter);
// Discovery analytics for this store's own offers (#77). Beside `/reports` and
// deliberately NOT inside it: reports are the ORDER-sourced surface with exact
// figures, and this is discovery telemetry with privacy thresholds. Merging
// them would put a suppressed number next to an exact one under one heading.
router.use('/:storeId/analytics', analyticsRouter);

export default router;
