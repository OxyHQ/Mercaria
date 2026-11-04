/**
 * `/internal/offers/*` — the offer domain's operator surface (#57).
 *
 * The `/internal/commerce-graph` shape, on the SAME key
 * (`catalog.operate`): who may reshape the catalogue and who may
 * withdraw an offer from a comparison are the same power over the same graph,
 * and a separate key would be another grant to keep in step for no separation
 * it does not already have.
 *
 * A SEPARATE router from `internal-commerce-graph.ts` rather than routes added
 * to it, per ADR 0002 D25(a)'s file-ownership protocol — the same reason #56
 * created `internal-canonical-catalog.ts` behind this identical gate.
 *
 * Mounted on every deployment; anyone without the key is answered 404, never a
 * 401 that would advertise the surface. Full reasoning:
 * `middleware/operator-authz.ts`.
 *
 * Three actions and no more, each driving a path that already exists and is
 * already idempotent — so this adds a trigger and no new way for an offer to
 * come into being.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import { offerConvergeSchema, offerRetireSchema } from '../middleware/offer-schemas.js';
import {
  convergeListingOffersHandler,
  offerConvergenceSummaryHandler,
  retireOfferHandler,
  traceOfferHandler,
} from '../controllers/offers-operator.controller.js';

const router = Router();

// Authentication FIRST, then the operator gate — it asks Oxy about the verified
// caller's own session, which only `authenticateToken` establishes.
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
