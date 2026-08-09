/**
 * `/internal/offers/*` — the offer domain's operator surface (#57).
 *
 * The `/internal/commerce-graph` shape, on the SAME allow-list
 * (`CATALOG_OPERATOR_OXY_USER_IDS`): who may reshape the catalogue and who may
 * withdraw an offer from a comparison are the same power over the same graph,
 * and a fourth list beside payments, catalog and guest would be a fourth thing
 * to keep in step for no separation it does not already have.
 *
 * A SEPARATE router from `internal-commerce-graph.ts` rather than routes added
 * to it, per ADR 0002 D25(a)'s file-ownership protocol — the same reason #56
 * created `internal-canonical-catalog.ts` behind this identical gate.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files. Full reasoning:
 * `routes/internal-payments.ts` and `middleware/catalog-operator-authz.ts`.
 *
 * Three actions and no more, each driving a path that already exists and is
 * already idempotent — so this adds a trigger and no new way for an offer to
 * come into being.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import { offerConvergeSchema, offerRetireSchema } from '../middleware/offer-schemas.js';
import {
  convergeListingOffersHandler,
  offerConvergenceSummaryHandler,
  retireOfferHandler,
  traceOfferHandler,
} from '../controllers/offers-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/**
 * GET — how much projection work is outstanding.
 *
 * BEFORE `/:id`, or the parameter route swallows it.
 */
router.get('/convergence', offerConvergenceSummaryHandler);

/** GET — one offer, its verdict and the state of its convergence job. */
router.get('/:id', traceOfferHandler);

/** POST — run one listing's convergence now, instead of waiting for the loop. */
router.post(
  '/listings/:listingId/converge',
  validateBody(offerConvergeSchema),
  convergeListingOffersHandler,
);

/** POST — withdraw one EXTERNAL offer. The row and its provenance survive. */
router.post('/:id/retire', validateBody(offerRetireSchema), retireOfferHandler);

export default router;
