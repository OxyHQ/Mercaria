import { Router } from 'express';
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
import feesRouter from './fees.js';

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

export default router;
