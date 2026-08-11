/**
 * `/internal/guest-commerce/governance/*` (#111).
 *
 * A separate ROUTER file rather than more lines in `internal-guest-commerce.ts`,
 * mounted under the same path prefix and behind the same middleware, because
 * the four surfaces that file already carries (cart, portal, claims, buyer
 * requests) each answer a question about ONE buyer's commerce, and this one
 * answers questions about the deployment. Keeping them in one file would make
 * the "opens from a checkout group and nothing else" property that governs the
 * other four harder to read, since three of the routes below are legitimately
 * deployment-scoped.
 *
 * The allow-list is `GUEST_OPERATOR_OXY_USER_IDS` and is deliberately not a
 * seventh: `routes/internal-guest-commerce.ts` mounts this after the same
 * `authenticateToken` + `requireGuestOperator` pair, so an empty list means the
 * whole prefix is not mounted (404, never a 401 that would advertise it).
 */

import { Router } from 'express';
import {
  advanceGuestRolloutStageHandler,
  guestDataInventoryHandler,
  guestRolloutStatusHandler,
  guestSecuritySignalsHandler,
  liftGuestLegalHoldHandler,
  listGuestDataRequestsHandler,
  listGuestInterventionsHandler,
  listGuestRetentionRunsHandler,
  publishGuestRetentionPolicyHandler,
  raiseGuestLegalHoldHandler,
  recordGuestGateSignoffHandler,
  reviewGuestInterventionHandler,
  runGuestRetentionPassHandler,
} from '../controllers/guest-governance.controller.js';

const router = Router();

/** The inventory, the schedule and which classes an ACTIVE policy covers. */
router.get('/inventory', guestDataInventoryHandler);

/** Retention: publish a version, read the passes, run one now. */
router.post('/retention-policy', publishGuestRetentionPolicyHandler);
router.get('/retention-runs', listGuestRetentionRunsHandler);
router.post('/retention-runs', runGuestRetentionPassHandler);

/** Legal holds — raise one, lift one. Both attributable. */
router.post('/legal-holds', raiseGuestLegalHoldHandler);
router.post('/legal-holds/:holdId/lift', liftGuestLegalHoldHandler);

/** Security monitoring, and the abuse queue with its false-positive correction. */
router.get('/signals', guestSecuritySignalsHandler);
router.get('/interventions', listGuestInterventionsHandler);
router.post('/interventions/:interventionId/review', reviewGuestInterventionHandler);

/**
 * The rollout. `/rollout/signoffs` and `/rollout/advance` are distinct path
 * SEGMENTS rather than parameters on `/rollout`, for the reason
 * `/claims/consistency` is registered before `/claims/checkouts/:id` one file
 * over: Express matches in order, and a value that happened to read `advance`
 * must not reach a different handler.
 */
router.get('/rollout', guestRolloutStatusHandler);
router.post('/rollout/signoffs', recordGuestGateSignoffHandler);
router.post('/rollout/advance', advanceGuestRolloutStageHandler);

/** The erasure audit for one checkout group. Opens from a GROUP and nothing else. */
router.get('/data-requests/:checkoutGroupId', listGuestDataRequestsHandler);

export default router;
