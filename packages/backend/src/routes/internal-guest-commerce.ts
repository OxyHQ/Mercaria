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
 * The CART half is READS ONLY and that is the whole of it by design: every
 * repair it could want is already an idempotent path a buyer drives — retrying
 * a merge converges on the recorded row, and a cart is corrected by its owner
 * editing it. Adding a "fix this merge" endpoint would be a new way to move
 * commerce state that nothing needs.
 *
 * ## The PORTAL half (#108) adds two writes, and they are not an exception
 *
 * Re-sending an access link and revoking a group's access are both things the
 * buyer can already do themselves; what an operator adds is a TRIGGER for
 * somebody who cannot reach their own inbox, audited in
 * `guest_portal_operator_actions` with a mandatory actor and reason. Neither
 * puts a credential in an employee's hands: the re-send goes to the address
 * already on the checkout, and the revoke only takes access away. The surface
 * still cannot read an address, reroute a message, or grant access — see
 * `services/guest-portal/operator.service.ts` for why each of those is
 * unrepresentable rather than refused.
 *
 * The portal routes live HERE rather than under a seventh allow-list because
 * they are the same power class as the cart diagnostic: a guest-commerce
 * support question, answered without learning what anyone bought or who they
 * are.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireGuestOperator } from '../middleware/guest-operator-authz.js';
import {
  guestCommerceConsistencyHandler,
  listCartMergesHandler,
} from '../controllers/guest-commerce-operator.controller.js';
import {
  resendGuestAccessLinkHandler,
  revokeGuestGroupAccessHandler,
  traceGuestPortalHandler,
} from '../controllers/guest-portal-operator.controller.js';

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

/**
 * The portal half (#108). Every route opens from a CHECKOUT GROUP — there is no
 * parameter for an email, a hash, an order number or a session id anywhere
 * below, so this surface cannot be asked what an inbox has ever accessed.
 */
router.get('/portal/checkouts/:checkoutGroupId', traceGuestPortalHandler);
router.post(
  '/portal/checkouts/:checkoutGroupId/resend-access-link',
  resendGuestAccessLinkHandler,
);
router.post('/portal/checkouts/:checkoutGroupId/revoke-access', revokeGuestGroupAccessHandler);

export default router;
