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
 * ## It is READ-ONLY, and that is a decision rather than an omission
 *
 * There is no "activate this version", no "set this mapping", no "run this
 * feed". Every write in this domain belongs to the store that owns the feed and
 * is reached through `/admin/stores/:storeId/feeds` behind `channels:write`; an
 * operator route that could change a merchant's mapping would be a way to change
 * what a merchant sells without them asking. The one operator power that IS
 * needed — pausing or revoking a source whose terms went wrong — already exists
 * on `/internal/ingestion/sources/:id/status`, where the rights model lives.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { listAllFeedsHandler, traceFeedHandler } from '../controllers/feed-import.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — every configured feed, whoever manages it. */
router.get('/', listAllFeedsHandler);

/** GET — one feed's configuration, versions, mappings, reports and runs. */
router.get('/:configurationId', traceFeedHandler);

export default router;
