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
import {
  approveClaimRevocationHandler,
  guestClaimConsistencyHandler,
  requestClaimRevocationHandler,
  traceGuestClaimsHandler,
  withdrawClaimRevocationHandler,
} from '../controllers/guest-claim-operator.controller.js';
import {
  reconcileBuyerRequest,
  traceBuyerRequests,
} from '../controllers/buyer-requests.controller.js';
import {
  guestP2PPolicyHandler,
  traceGuestP2PListingHandler,
} from '../controllers/guest-p2p-operator.controller.js';
import internalGuestGovernanceRouter from './internal-guest-governance.js';

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

/**
 * The CLAIM half (#109). Two reads and three writes, and the three writes are
 * three STEPS of one capability — detaching a claim — rather than three
 * capabilities.
 *
 * There is deliberately no "claim this group for account X" and no "move this
 * group to another account". #109 reject rule 7 says an operator typing an Oxy
 * user id is not a proof, and revocation rule 1 forbids moving a claimed
 * checkout between accounts self-service; permitting an operator to do it in
 * one step would defeat both. A correction is a DETACH, after which the
 * rightful buyer claims through the ordinary two-sided proof from their own
 * inbox — which is the only path in the system that can establish who they are.
 *
 * `/claims/consistency` is registered BEFORE `/claims/checkouts/:id` because
 * Express matches in order, and it is a distinct path segment rather than a
 * parameter for the same reason: a group id that happened to read
 * `consistency` must not reach a different handler.
 */
router.get('/claims/consistency', guestClaimConsistencyHandler);
router.get('/claims/checkouts/:checkoutGroupId', traceGuestClaimsHandler);
router.post('/claims/:claimId/revocations', requestClaimRevocationHandler);
router.post('/claim-revocations/:revocationId/approve', approveClaimRevocationHandler);
router.post('/claim-revocations/:revocationId/withdraw', withdrawClaimRevocationHandler);

/**
 * The buyer-request half (#110), on the SAME allow-list rather than a seventh.
 *
 * The power is the same one #104 and #108 already grant here — reading what a
 * guest did with their purchase and driving a path they can drive themselves —
 * so a new list would be a second answer to a question `GUEST_OPERATOR_OXY_USER_IDS`
 * already answers. It is deliberately NOT the payment operator list: a support
 * agent tracing a stuck return should not thereby be able to see every store's
 * money.
 *
 * A trace opens from an ORDER and nothing else, and the ONE write drives
 * `reconcileReturnRefund` — an idempotent path a merchant also drives, so this
 * surface adds a trigger and no new way to move money. There is deliberately no
 * "set this request completed", no "override this decision", no "approve this
 * return" and no way to write into a support thread as somebody else.
 */
router.get('/buyer-requests/orders/:orderId', traceBuyerRequests);
router.post('/buyer-requests/returns/:requestId/reconcile', reconcileBuyerRequest);

/**
 * The guest-P2P policy half (#112), on the SAME allow-list and READ ONLY.
 *
 * Two reads and no third. There is deliberately no "authorize this seller", no
 * "waive this criterion" and no "enable the pilot": approving a bounded scope
 * of guest P2P checkout is a dated decision recorded in `docs/guest-p2p/`, and
 * a route that could do it would be a way to grant one without the record.
 *
 * The trace opens from a LISTING, so "what did this guest try to buy" is not a
 * question this surface can be asked. It stays mounted whatever the
 * authorization state is, for the reason every other operator surface here
 * does: the evidence has to be readable while the answer is no.
 */
router.get('/p2p/policy', guestP2PPolicyHandler);
router.get('/p2p/listings/:listingId', traceGuestP2PListingHandler);

/**
 * The GOVERNANCE half (#111), mounted LAST and on the same allow-list.
 *
 * Its own router file rather than more routes here, and the split is not
 * cosmetic: every route above opens from one buyer's checkout group, order or
 * claim, and three of the routes below are legitimately deployment-scoped (the
 * retention runs, the security signals, the rollout). Keeping them apart is
 * what lets "this surface cannot be asked what an inbox has ever accessed" stay
 * readable as a property of the routes above rather than as a claim somebody
 * has to re-check every time one is added.
 */
router.use('/governance', internalGuestGovernanceRouter);

export default router;
