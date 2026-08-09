/**
 * `/internal/awin/*` — the Awin retailer-network operator surface (#66).
 *
 * The `/internal/ingestion` shape, on the SAME allow-list
 * (`CATALOG_OPERATOR_OXY_USER_IDS`): who may decide what an external source is
 * permitted to do and who may decide which retailers on a network Mercaria
 * lists are the same power over the same graph. A seventh list beside payments,
 * catalog, guest, analytics, retail and procurement would be a seventh thing to
 * keep in step for no separation it does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-ingestion.ts`, per
 * ADR 0002 D25(a)'s file-ownership protocol — the same reason #56, #57, #58,
 * #60, #62, #63 and #68 each created their own behind this identical gate.
 *
 * **It stays mounted while `AWIN_ENABLED` is off**, deliberately and for
 * `/internal/ingestion`'s reason: registering an account, polling the feed list
 * and reading what it found is how a network is brought up before the adapter
 * is switched on, and the evidence has to be readable during the incident that
 * turned it off.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import {
  changeAwinAccountStateHandler,
  changeAwinActivationHandler,
  discoverAwinHandler,
  listAwinAccountsHandler,
  listAwinAdvertisersHandler,
  recordAwinSampleHandler,
  registerAwinAccountHandler,
  registerAwinSourceHandler,
  traceAwinAdvertiserHandler,
} from '../controllers/awin-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — every publisher account, its state, its budget and its last list poll. */
router.get('/accounts', listAwinAccountsHandler);

/** POST — register or reconfigure one. It permits nothing until reviewed. */
router.post('/accounts', registerAwinAccountHandler);

/** POST — pause, resume, or record a deauthorization. A reason is mandatory. */
router.post('/accounts/:accountId/state', changeAwinAccountStateHandler);

/** POST — poll the feed list NOW and reconcile advertisers and feeds. */
router.post('/accounts/:accountId/discover', discoverAwinHandler);

/** GET — this account's advertisers, with membership and activation. */
router.get('/accounts/:accountId/advertisers', listAwinAdvertisersHandler);

/** GET — one advertiser's trace: feeds, quality history, samples, its source. */
router.get('/advertisers/:advertiserId', traceAwinAdvertiserHandler);

/** POST — bind this advertiser to a #62 source, with a merchant and storefront. */
router.post('/advertisers/:advertiserId/source', registerAwinSourceHandler);

/** POST — move the activation. The per-advertiser kill switch. */
router.post('/advertisers/:advertiserId/activation', changeAwinActivationHandler);

/** POST — record a destination-and-tracking sample verdict. Append-only. */
router.post('/advertisers/:advertiserId/samples', recordAwinSampleHandler);

export default router;
