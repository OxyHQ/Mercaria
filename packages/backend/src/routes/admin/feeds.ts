import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import {
  activateFeedVersionSchema,
  createFeedConfigurationSchema,
  draftFeedVersionSchema,
  feedUploadPartsSchema,
  feedUploadProofSchema,
  openFeedUploadSessionSchema,
} from '../../middleware/feed-import-schemas.js';
import {
  activateFeedVersionHandler,
  completeFeedUploadSessionHandler,
  declareFeedOwnerScope,
  createFeedHandler,
  feedUploadPartsHandler,
  getFeedUploadSessionHandler,
  getFeedValidationHandler,
  openFeedUploadSessionHandler,
  proveFeedUploadSessionHandler,
  downloadFeedReportHandler,
  draftFeedVersionHandler,
  getFeedHandler,
  getFeedReportHandler,
  getFeedStatusHandler,
  listFeedReportsHandler,
  listFeedUploadsHandler,
  listFeedsHandler,
  previewFeedVersionHandler,
  revertFeedVersionHandler,
  syncFeedHandler,
  validateFeedVersionHandler,
} from '../../controllers/feed-import.controller.js';

/**
 * A store's product-feed surface (#63), mounted at
 * `/admin/stores/:storeId/feeds`.
 *
 * Authentication and store membership are established by the parent
 * (`admin/index.ts` runs `authenticateToken`, `admin/stores.ts` runs
 * `loadStore`), so this router adds the permission and the rate limits.
 *
 * ## `channels:write` on every route, which the issue names and which fits
 *
 * Issue security 6 asks for "tenant ownership and `channels:write`
 * authorization where merchant-managed". It is the right permission rather than
 * merely the named one: a feed is a SALES CHANNEL's inventory arriving by file,
 * and `channels:write` is what already gates connecting a Shopify shop. It is
 * denied to `staff` by the role matrix, which is correct — configuring where a
 * store's catalogue comes from is not a shop-floor act.
 *
 * The reads follow the writes rather than getting a looser gate: a screen that
 * could show a mapping but not change it would be built against a permission
 * split this API then could not change without breaking it (the `fees` router's
 * reasoning, one surface over).
 *
 * ## No route here carries a feed
 *
 * A feed is gigabytes, and the proxy in front of this API refuses a request
 * body over 100 MB. So an upload is a SESSION: the client declares the file
 * (size, SHA-256, label, compression), PUTs presigned parts straight to storage,
 * and completes; every request here is a small JSON body under the global
 * `express.json()`. A whole-feed validation is likewise a job the client polls,
 * because reading a feed outlives the load balancer's idle timeout.
 */
const router = Router({ mergeParams: true });

/**
 * Its own bucket (`rl:feed-import:`), and a small one for the routes that
 * FETCH or make storage do work.
 *
 * A preview and a sync each cause an outbound request to a host the merchant
 * chose, so an unmetered surface is a way to make Mercaria hammer a third party
 * — or a way to make Mercaria download a gigabyte on demand, repeatedly. Sharing
 * the general admin budget would mean a merchant testing a mapping spends the
 * allowance they need to run their shop.
 */
const feedLimiter = makeRateLimiter('feed-import', { authenticatedMax: 300 });
const fetchLimiter = makeRateLimiter('feed-import-fetch', { authenticatedMax: 30 });

router.use(feedLimiter);

/**
 * Whose feeds these handlers act on.
 *
 * The same handlers serve `/internal/feed-imports`, where there is no store at
 * all. The scope is DECLARED here rather than read off `req.store`, because
 * "no store loaded means the platform" is one missing `loadStore` away from
 * turning this router into an operator one — and `feedOwnerStoreId` throws
 * rather than defaulting, so a router that forgets this line fails loudly on
 * its first request instead of quietly serving the wrong owner's rows.
 */
router.use(declareFeedOwnerScope('merchant'));

router.get('/', requireStorePermission('channels:write'), listFeedsHandler);

router.post(
  '/',
  requireStorePermission('channels:write'),
  validateBody(createFeedConfigurationSchema),
  createFeedHandler,
);

router.get('/:configurationId', requireStorePermission('channels:write'), getFeedHandler);

router.get(
  '/:configurationId/status',
  requireStorePermission('channels:write'),
  getFeedStatusHandler,
);

router.post(
  '/:configurationId/versions',
  requireStorePermission('channels:write'),
  validateBody(draftFeedVersionSchema),
  draftFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/preview',
  requireStorePermission('channels:write'),
  fetchLimiter,
  previewFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/validate',
  requireStorePermission('channels:write'),
  fetchLimiter,
  validateFeedVersionHandler,
);

router.get(
  '/:configurationId/versions/:versionId/validations/:validationId',
  requireStorePermission('channels:write'),
  getFeedValidationHandler,
);

router.post(
  '/:configurationId/versions/:versionId/activate',
  requireStorePermission('channels:write'),
  validateBody(activateFeedVersionSchema),
  activateFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/revert',
  requireStorePermission('channels:write'),
  revertFeedVersionHandler,
);

router.get(
  '/:configurationId/uploads',
  requireStorePermission('channels:write'),
  listFeedUploadsHandler,
);

// Direct uploads: the client PUTs the feed's parts to storage itself, so no
// request here carries a feed (`upload-session.service.ts`).
router.post(
  '/:configurationId/upload-sessions',
  requireStorePermission('channels:write'),
  fetchLimiter,
  validateBody(openFeedUploadSessionSchema),
  openFeedUploadSessionHandler,
);

router.get(
  '/:configurationId/upload-sessions/:sessionId',
  requireStorePermission('channels:write'),
  getFeedUploadSessionHandler,
);

router.post(
  '/:configurationId/upload-sessions/:sessionId/parts',
  requireStorePermission('channels:write'),
  validateBody(feedUploadPartsSchema),
  feedUploadPartsHandler,
);

router.post(
  '/:configurationId/upload-sessions/:sessionId/complete',
  requireStorePermission('channels:write'),
  fetchLimiter,
  completeFeedUploadSessionHandler,
);

router.post(
  '/:configurationId/upload-sessions/:sessionId/proof',
  requireStorePermission('channels:write'),
  fetchLimiter,
  validateBody(feedUploadProofSchema),
  proveFeedUploadSessionHandler,
);

router.get(
  '/:configurationId/reports',
  requireStorePermission('channels:write'),
  listFeedReportsHandler,
);

router.get(
  '/:configurationId/reports/:reportId',
  requireStorePermission('channels:write'),
  getFeedReportHandler,
);

router.get(
  '/:configurationId/reports/:reportId/download',
  requireStorePermission('channels:write'),
  downloadFeedReportHandler,
);

router.post(
  '/:configurationId/sync',
  requireStorePermission('channels:write'),
  fetchLimiter,
  syncFeedHandler,
);

export default router;
