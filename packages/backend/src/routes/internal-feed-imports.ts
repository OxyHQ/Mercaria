/**
 * `/internal/feed-imports/*` — the feed importer's operator surface (#63).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/#62
 * use, and for #62's own reason: who may decide what an external source is
 * permitted to do and who may read how a feed is being mapped into the canonical
 * catalogue are the same power over the same graph. A seventh list beside
 * payments, catalog, guest, analytics, retail and procurement would be a seventh
 * thing to keep in step for no separation it does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-ingestion.ts`, per
 * ADR 0002 D25(a)'s file-ownership protocol — the same reason #56, #57, #58, #60
 * and #62 each created their own behind this identical gate.
 *
 * **It stays mounted while `FEED_IMPORT_ENABLED` is off**, deliberately and for
 * `/internal/backfill`'s reason: the evidence has to be readable during the
 * incident that turned the importer off, and a merchant's mapping, their
 * validation reports and the reason their last pass failed are exactly that
 * evidence.
 *
 * ## The cross-owner READS write nothing, and that stays true
 *
 * `GET /` and `GET /:configurationId` see every feed, whoever manages it, and
 * there is deliberately still no operator route that can change a MERCHANT's
 * mapping — that would be a way to change what a merchant sells without them
 * asking. The one operator power over somebody else's feed — pausing or
 * revoking a source whose terms went wrong — remains
 * `/internal/ingestion/sources/:id/status`, where the rights model lives.
 *
 * ## `/platform/*` writes, and reaches ONLY the platform's own feeds
 *
 * `feed_configurations.owner_kind` has two members, and the second one had no
 * writer: `createFeedConfiguration` writes `operator` when `storeId` is null,
 * and its only caller supplied a store. So an external partner that is not and
 * never will be a Mercaria store could not have a feed configured at all
 * (#986), which blocked the one affiliate path needing nobody's approval
 * (`docs/runbooks/direct-affiliate-partner.md`).
 *
 * These are the SAME handlers the merchant surface mounts, under a declared
 * owner scope of `platform`. `assertConfigurationOwnedByRequester` compares
 * `store_id` directly, so a merchant's configuration is 404 here for the same
 * reason a stranger's is 404 there — one expression, both directions, and the
 * read-only rule above is preserved by construction rather than by remembering
 * to check.
 *
 * ## `sourceKind` exists on this surface and NOT on the merchant one
 *
 * `affiliate_network` says Mercaria links out to somebody else's shop and earns
 * a commission on the click. It decides the offer KIND
 * (`offerKindFor`), which decides `affiliateDisclosureRequired`
 * (`commercial-presentation/presentation.ts`) — so it is a statement about a
 * contract Mercaria signed, and a store must not be able to make it about its
 * own catalogue. It is settable only at CREATION because `ensureCatalogSource`
 * never updates an existing row's kind.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import {
  activateFeedVersionSchema,
  createOperatorFeedConfigurationSchema,
  draftFeedVersionSchema,
} from '../middleware/feed-import-schemas.js';
import {
  activateFeedVersionHandler,
  createFeedHandler,
  declareFeedOwnerScope,
  downloadFeedReportHandler,
  draftFeedVersionHandler,
  getFeedHandler,
  getFeedReportHandler,
  getFeedStatusHandler,
  listAllFeedsHandler,
  listFeedReportsHandler,
  listFeedUploadsHandler,
  listFeedsHandler,
  previewFeedVersionHandler,
  revertFeedVersionHandler,
  syncFeedHandler,
  traceFeedHandler,
  uploadFeedHandler,
  validateFeedVersionHandler,
} from '../controllers/feed-import.controller.js';

const router = Router();

/**
 * The merchant surface's own buckets, reused rather than a third pair.
 *
 * A preview, a validate, an upload and a sync each cause an outbound request to
 * a host somebody chose or a write of up to `FEED_IMPORT_MAX_DOWNLOAD_BYTES`;
 * that cost does not change because the caller is an operator, and a separate
 * unmetered budget here would be the way to make Mercaria hammer a partner.
 */
const fetchLimiter = makeRateLimiter('feed-import-fetch', { authenticatedMax: 30 });

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — every configured feed, whoever manages it. */
router.get('/', listAllFeedsHandler);

/**
 * The PLATFORM's own feeds. Mounted BEFORE `/:configurationId`, because
 * `platform` would otherwise be read as a configuration id and every one of
 * these would 404 through the cross-owner trace instead.
 */
const platform = Router();
platform.use(declareFeedOwnerScope('platform'));

platform.get('/', listFeedsHandler);
platform.post('/', validateBody(createOperatorFeedConfigurationSchema), createFeedHandler);
platform.get('/:configurationId', getFeedHandler);
platform.get('/:configurationId/status', getFeedStatusHandler);
platform.post(
  '/:configurationId/versions',
  validateBody(draftFeedVersionSchema),
  draftFeedVersionHandler,
);
platform.post(
  '/:configurationId/versions/:versionId/preview',
  fetchLimiter,
  previewFeedVersionHandler,
);
platform.post(
  '/:configurationId/versions/:versionId/validate',
  fetchLimiter,
  validateFeedVersionHandler,
);
platform.post(
  '/:configurationId/versions/:versionId/activate',
  validateBody(activateFeedVersionSchema),
  activateFeedVersionHandler,
);
platform.post('/:configurationId/versions/:versionId/revert', revertFeedVersionHandler);
platform.get('/:configurationId/uploads', listFeedUploadsHandler);
// No body parser, exactly as on the merchant surface: `express.raw` would
// BUFFER a feed, which is gigabytes in memory. The handler iterates the stream.
platform.post('/:configurationId/uploads', fetchLimiter, uploadFeedHandler);
platform.get('/:configurationId/reports', listFeedReportsHandler);
platform.get('/:configurationId/reports/:reportId', getFeedReportHandler);
platform.get('/:configurationId/reports/:reportId/download', downloadFeedReportHandler);
platform.post('/:configurationId/sync', fetchLimiter, syncFeedHandler);

router.use('/platform', platform);

/** GET — one feed's configuration, versions, mappings, reports and runs. */
router.get('/:configurationId', traceFeedHandler);

export default router;
