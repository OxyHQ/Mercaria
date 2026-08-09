import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import {
  activateFeedVersionSchema,
  createFeedConfigurationSchema,
  draftFeedVersionSchema,
} from '../../middleware/feed-import-schemas.js';
import {
  activateStoreFeedVersionHandler,
  createStoreFeedHandler,
  downloadStoreFeedReportHandler,
  draftStoreFeedVersionHandler,
  getStoreFeedHandler,
  getStoreFeedReportHandler,
  getStoreFeedStatusHandler,
  listStoreFeedReportsHandler,
  listStoreFeedUploadsHandler,
  listStoreFeedsHandler,
  previewStoreFeedVersionHandler,
  revertStoreFeedVersionHandler,
  syncStoreFeedHandler,
  uploadStoreFeedHandler,
  validateStoreFeedVersionHandler,
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
 * ## The upload route reads the request as a STREAM, and no parser may touch it
 *
 * `express.raw` would BUFFER the body, which for a feed is gigabytes in memory —
 * exactly what issue acceptance 1 forbids. So there is no body parser on the
 * upload route at all: the handler iterates `req` and writes to disk as the
 * bytes arrive, bounded by `FEED_IMPORT_MAX_DOWNLOAD_BYTES`. The global
 * `express.json()` leaves the stream alone because it matches on content type,
 * which is why the handler REFUSES a JSON content type rather than finding an
 * empty stream and reporting an empty feed. The metadata rides the query string
 * for the same reason a multipart parser is absent — two fields do not justify a
 * second parser over attacker-supplied input.
 */
const router = Router({ mergeParams: true });

/**
 * Its own bucket (`rl:feed-import:`), and a small one for the two routes that
 * FETCH.
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

router.get('/', requireStorePermission('channels:write'), listStoreFeedsHandler);

router.post(
  '/',
  requireStorePermission('channels:write'),
  validateBody(createFeedConfigurationSchema),
  createStoreFeedHandler,
);

router.get('/:configurationId', requireStorePermission('channels:write'), getStoreFeedHandler);

router.get(
  '/:configurationId/status',
  requireStorePermission('channels:write'),
  getStoreFeedStatusHandler,
);

router.post(
  '/:configurationId/versions',
  requireStorePermission('channels:write'),
  validateBody(draftFeedVersionSchema),
  draftStoreFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/preview',
  requireStorePermission('channels:write'),
  fetchLimiter,
  previewStoreFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/validate',
  requireStorePermission('channels:write'),
  fetchLimiter,
  validateStoreFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/activate',
  requireStorePermission('channels:write'),
  validateBody(activateFeedVersionSchema),
  activateStoreFeedVersionHandler,
);

router.post(
  '/:configurationId/versions/:versionId/revert',
  requireStorePermission('channels:write'),
  revertStoreFeedVersionHandler,
);

router.get(
  '/:configurationId/uploads',
  requireStorePermission('channels:write'),
  listStoreFeedUploadsHandler,
);

router.post(
  '/:configurationId/uploads',
  requireStorePermission('channels:write'),
  fetchLimiter,
  uploadStoreFeedHandler,
);

router.get(
  '/:configurationId/reports',
  requireStorePermission('channels:write'),
  listStoreFeedReportsHandler,
);

router.get(
  '/:configurationId/reports/:reportId',
  requireStorePermission('channels:write'),
  getStoreFeedReportHandler,
);

router.get(
  '/:configurationId/reports/:reportId/download',
  requireStorePermission('channels:write'),
  downloadStoreFeedReportHandler,
);

router.post(
  '/:configurationId/sync',
  requireStorePermission('channels:write'),
  fetchLimiter,
  syncStoreFeedHandler,
);

export default router;
