/**
 * `/internal/guest-commerce/*` — the guest-commerce operator diagnostic (#104).
 *
 * The `/internal/payments` and `/internal/commerce-graph` shape, applied to a
 * third power: mounted OUTSIDE `/admin` because no store membership could
 * authorize reading who merged which cart; mount gated on the allow-list being
 * non-empty (404 on a deployment with no operators, never a 401 that would
 * advertise the surface); the gate repeated in middleware because mount and
 * gate live in different files. Full reasoning: `routes/internal-payments.ts`.
 *
 * READS ONLY, and that is the whole surface by design. Every repair this domain
 * could want is already an idempotent path a buyer drives — retrying a merge
 * converges on the recorded row, and a cart is corrected by its owner editing
 * it. Adding a "fix this merge" endpoint would be a new way to move commerce
 * state that nothing needs.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireGuestOperator } from '../middleware/guest-operator-authz.js';
import {
  guestCommerceConsistencyHandler,
  listCartMergesHandler,
} from '../controllers/guest-commerce-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireGuestOperator);

/** The merges recorded for one guest session or one Oxy account. */
router.get('/cart-merges', listCartMergesHandler);

/** The two cross-row ownership invariants, counted. */
router.get('/consistency', guestCommerceConsistencyHandler);

export default router;
