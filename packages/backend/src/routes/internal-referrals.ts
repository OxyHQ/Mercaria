/**
 * `/internal/referrals/*` — the referral operator surface (#143, extended by
 * #145's earnings ledger).
 *
 * On the SEVENTH allow-list (`REFERRAL_OPERATOR_OXY_USER_IDS`), for the reason
 * `middleware/referral-operator-authz.ts` gives: pausing a program's
 * attribution stops partners earning, and an operator vetted to repair a
 * payment or trace a cart merge has not been vetted for that. #145 adds the
 * power to move a partner's MONEY and stays on the SAME list rather than
 * growing an eighth — approving a payout and pausing attribution are the same
 * economy, and splitting them would put one half of a partner's fate behind a
 * list the other half's operator is not on.
 *
 * The route set is CLOSED. There is no "attribute this subject to that
 * partner", no "create a touch", no "extend this window", no "move this
 * attribution", no "reveal who is attributed to this account" — and, since
 * #145, no "mark this reward paid", no "void this reward", no "book this
 * entry", no "edit this posting", no "set this batch's total" and still no
 * delete. Each would be a way to make the record say something nobody observed.
 * Every write below drives an existing idempotent path a machine already takes.
 *
 * Mounted while every lever is down and while `REFERRALS_ENABLED` is off — the
 * standing rule that the evidence has to be readable during the incident that
 * turned the surface off, and the reason an operator can settle a batch by hand
 * with `REFERRAL_PAYOUT_BATCHES_ENABLED` off.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireReferralOperator } from '../middleware/referral-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  referralDiscrepancyResolutionSchema,
  referralOperatorReasonSchema,
  referralPayoutBatchOpenSchema,
  referralProgramControlsSchema,
  referralRecoverySchema,
} from '../middleware/referral-schemas.js';
import {
  approveReferralPayoutBatchHandler,
  cancelReferralPayoutBatchHandler,
  freezeReferralPartnerRewardsHandler,
  getReferralAttributionTraceHandler,
  getReferralEarningsTraceHandler,
  getReferralPartnerBalancesHandler,
  getReferralProgramControlsHandler,
  liftReferralPartnerFreezeHandler,
  listReferralEarningDiscrepanciesHandler,
  openReferralPayoutBatchHandler,
  recordReferralRecoveryHandler,
  resolveReferralEarningDiscrepancyHandler,
  runReferralReconciliationHandler,
  runReferralVestingHandler,
  setReferralProgramControlsHandler,
  settleReferralPayoutBatchHandler,
} from '../controllers/referral-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireReferralOperator);

/** GET — the effective levers, with absence resolved to "both enabled". */
router.get('/programs/:programId/controls', getReferralProgramControlsHandler);

/** PUT — set both levers, attributably, with a mandatory reason. */
router.put(
  '/programs/:programId/controls',
  validateBody(referralProgramControlsSchema),
  setReferralProgramControlsHandler,
);

/** GET — one attribution's trace. Opens from an attribution id and nothing else. */
router.get('/attributions/:attributionId', getReferralAttributionTraceHandler);

// ─── The earnings ledger (#145) ─────────────────────────────────────────────

/**
 * GET — #145's whole operator trace: partner → attribution → conversion → rule
 * → funding → reward entries → hold/vesting → reversal → payout batch →
 * provider payout. It opens from a PARTNER id and carries no buyer-shaped field
 * at any depth.
 */
router.get('/partners/:partnerId/earnings', getReferralEarningsTraceHandler);

/** GET — the DERIVED balances, per currency. There is no balance table. */
router.get('/partners/:partnerId/balances', getReferralPartnerBalancesHandler);

/** POST — open a batch by hand over everything currently payable. */
router.post(
  '/partners/:partnerId/payout-batches',
  validateBody(referralPayoutBatchOpenSchema),
  openReferralPayoutBatchHandler,
);

/** POST — the second pair of eyes. A hand-opened batch cannot self-approve. */
router.post(
  '/payout-batches/:batchId/approve',
  validateBody(referralOperatorReasonSchema),
  approveReferralPayoutBatchHandler,
);

/** POST — the SAME settlement the loop runs, on the batch's own key. */
router.post('/payout-batches/:batchId/settle', settleReferralPayoutBatchHandler);

/** POST — the only status that releases claims, so the rewards can be rebuilt. */
router.post(
  '/payout-batches/:batchId/cancel',
  validateBody(referralOperatorReasonSchema),
  cancelReferralPayoutBatchHandler,
);

/** POST — ADR 0005 D18/R8's freeze. It withholds and never destroys. */
router.post(
  '/partners/:partnerId/freeze',
  validateBody(referralOperatorReasonSchema),
  freezeReferralPartnerRewardsHandler,
);

/** POST — the lift, which returns each reward to the state it paused in. */
router.post(
  '/partners/:partnerId/unfreeze',
  validateBody(referralOperatorReasonSchema),
  liftReferralPartnerFreezeHandler,
);

/** POST — ADR 0005 R7's recovery: money that ARRIVED, recorded rather than decided. */
router.post(
  '/partners/:partnerId/recoveries',
  validateBody(referralRecoverySchema),
  recordReferralRecoveryHandler,
);

/** GET — the reconciliation sweep's findings. It detects; it never repairs. */
router.get('/earnings/discrepancies', listReferralEarningDiscrepanciesHandler);

/** POST — a note about a finding, never a change to what the finding measured. */
router.post(
  '/earnings/discrepancies/:id/resolve',
  validateBody(referralDiscrepancyResolutionSchema),
  resolveReferralEarningDiscrepancyHandler,
);

/** POST — run one page of the sweep. Repairs nothing, so it cannot make it worse. */
router.post('/earnings/reconcile', runReferralReconciliationHandler);

/** POST — run one page of the vesting sweep. The same function the loop calls. */
router.post('/earnings/vest', runReferralVestingHandler);

export default router;
