/**
 * `/internal/ebay/*` — the eBay Browse source's operator surface (#65).
 *
 * A separate router behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
 * #54/#56/#57/#58/#60/#62 use, per ADR 0002 D25(a)'s file-ownership protocol.
 * Not a seventh allow-list: deciding which eBay categories Mercaria ingests is
 * the same power over the same graph as deciding what any other external source
 * may do, and a list that granted one without the other would be a distinction
 * nobody could defend.
 *
 * Mounted only when that list is non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface), and it stays mounted
 * while `EBAY_ENABLED` and `EBAY_FETCH_ENABLED` are off — `/internal/backfill`'s
 * rule: the evidence has to be readable during the incident that turned the
 * fetching off, and reading the budget is exactly what somebody does after
 * flipping the switch.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import {
  ebayBudgetHandler,
  ebayReconciliationHandler,
  listEbayDiscoveryQueriesHandler,
  reconcileEbaySourceHandler,
  upsertEbayDiscoveryQueryHandler,
} from '../controllers/ebay-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — today's and recent days' call budget. Issue acceptance 4's quota metric. */
router.get('/budget', ebayBudgetHandler);

/** GET — the discovery cohort one source sweeps, and how many items it tracks. */
router.get('/sources/:sourceId/discovery-queries', listEbayDiscoveryQueriesHandler);

/** POST — widen or narrow that cohort. The rollout lever (#65 acceptance 7). */
router.post('/sources/:sourceId/discovery-queries', upsertEbayDiscoveryQueryHandler);

/** GET — what a live re-read said, beside what Mercaria was serving. */
router.get('/sources/:sourceId/reconciliation', ebayReconciliationHandler);

/** POST — run one reconciliation sweep now. It detects and repairs nothing. */
router.post('/sources/:sourceId/reconcile', reconcileEbaySourceHandler);

export default router;
