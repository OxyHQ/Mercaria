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
  referralAppealDecisionSchema,
  referralConductPolicySchema,
  referralDisclosureSchema,
  referralDiscrepancyResolutionSchema,
  referralEnforcementSchema,
  referralOperatorReasonSchema,
  referralRiskSignalSchema,
  referralPayoutBatchOpenSchema,
  referralPartnerTerminationSchema,
  referralProgramControlsSchema,
  referralRecoverySchema,
} from '../middleware/referral-schemas.js';
import {
  referralAppealResolutionSchema,
  referralApplicationDecisionSchema,
  referralOperatorPartnerSchema,
} from '../middleware/referral-partner-schemas.js';
import {
  referralProgramDraftPatchSchema,
  referralProgramDraftSchema,
  referralProgramLifecycleSchema,
  referralProgramPublishSchema,
} from '../middleware/referral-dashboard-schemas.js';
import {
  createReferralProgramHandler,
  createReferralProgramVersionHandler,
  editReferralProgramDraftHandler,
  getReferralProgramHandler,
  getReferralProgramUtilizationHandler,
  listReferralProgramsHandler,
  publishReferralProgramHandler,
  transitionReferralProgramHandler,
} from '../controllers/referral-program-operator.controller.js';
import {
  createReferralPartnerHandler,
  decideReferralApplicationHandler,
  getReferralPartnerReviewHandler,
  listReferralPartnerInboxHandler,
  resolveReferralAppealHandler,
  startReferralApplicationReviewHandler,
  transitionReferralPartnerStandingHandler,
} from '../controllers/referral-enrollment-operator.controller.js';
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
import {
  decideReferralAppealHandler,
  draftConductPolicyHandler,
  draftDisclosureHandler,
  evaluateReferralRiskHandler,
  imposeReferralEnforcementHandler,
  liftReferralEnforcementHandler,
  listConductPolicyVersionsHandler,
  publishConductPolicyHandler,
  publishDisclosureHandler,
  recordReferralRiskSignalHandler,
  traceReferralIntegrityHandler,
} from '../controllers/referral-integrity.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireReferralOperator);

// ── Enrollment review (#146 increment 2) ────────────────────────────────────
//
// On this SAME list rather than an eighth: deciding whether somebody may be a
// referral partner and approving what they are paid are the same economy, which
// is the argument #145 made when it joined. Deliberately NOT gated by
// `REFERRAL_PARTNER_ENROLLMENT_ENABLED` — that lever stops NEW enrollment, and
// a queue has to be workable through exactly the incident that turned it off.

/** The review inbox. Filtered by STATE only; there is no name or email search. */
router.get('/partners', listReferralPartnerInboxHandler);

/** One partner's whole enrollment picture, including live duplicate signals. */
router.get('/partners/:partnerId/review', getReferralPartnerReviewHandler);

/** Claim a submitted application. Idempotent — two operators converge. */
router.post('/partners/:partnerId/review', startReferralApplicationReviewHandler);

/** Decide it. One decision per revision; a repeat converges on the first. */
router.post(
  '/partners/:partnerId/review/decision',
  validateBody(referralApplicationDecisionSchema),
  decideReferralApplicationHandler,
);

/** Create a partner in one of the three operator-only enrollment modes. */
router.post('/partners', validateBody(referralOperatorPartnerSchema), createReferralPartnerHandler);

/**
 * Standing transitions #142 shipped and never mounted.
 *
 * Suspension stops NEW attribution and leaves everything durable exactly where
 * it is (ADR 0005 D18); termination is terminal for the standing and is never a
 * deletion. Neither voids, reverses or reduces a reward — D15's "skipped, not
 * voided" — and nothing on this router could.
 */
router.post(
  '/partners/:partnerId/suspend',
  validateBody(referralOperatorReasonSchema),
  transitionReferralPartnerStandingHandler('suspend'),
);
router.post(
  '/partners/:partnerId/reinstate',
  validateBody(referralOperatorReasonSchema),
  transitionReferralPartnerStandingHandler('reinstate'),
);
router.post(
  '/partners/:partnerId/terminate',
  validateBody(referralPartnerTerminationSchema),
  transitionReferralPartnerStandingHandler('terminate'),
);

/** Resolve an open appeal. Records the DECISION; reinstatement is separate. */
router.post(
  '/partners/:partnerId/appeal',
  validateBody(referralAppealResolutionSchema),
  resolveReferralAppealHandler,
);

// ─── Program management (#147) ──────────────────────────────────────────────
//
// On this SAME list, NOT an eighth: publishing the terms a partner earns under
// and approving what they are paid are the same economy — #145's argument when
// it joined, one step earlier in the lifecycle.
//
// The set is CLOSED and the omissions are the design: there is no "edit this
// ACTIVE version", no "set this program's status", no "delete this version" and
// no "backdate this effective start". Every write drives an existing service
// whose own compare-and-swap is what makes it safe, and the editable route
// reaches `updateProgramDraft`, whose `status = 'draft'` predicate is where
// #147 acceptance 4 actually lives.

/** GET — every program, one row each at its highest version. */
router.get('/programs', listReferralProgramsHandler);

/** GET — every VERSION of one program, newest first. The immutability audit. */
router.get('/programs/:programId', getReferralProgramHandler);

/** GET — budget and cap utilization, DERIVED. There is no utilization table. */
router.get('/programs/:programId/utilization', getReferralProgramUtilizationHandler);

/** POST — draft version 1 of a new program. */
router.post('/programs', validateBody(referralProgramDraftSchema), createReferralProgramHandler);

/** POST — draft the NEXT version, seeded from what is live. */
router.post('/programs/:programId/versions', createReferralProgramVersionHandler);

/** PATCH — edit a DRAFT. A published version matches nothing and is refused. */
router.patch(
  '/program-versions/:versionId',
  validateBody(referralProgramDraftPatchSchema),
  editReferralProgramDraftHandler,
);

/** POST — publish it. The approver comes off the credential, never the body. */
router.post(
  '/program-versions/:versionId/publish',
  validateBody(referralProgramPublishSchema),
  publishReferralProgramHandler,
);

/**
 * POST — the four lifecycle transitions, each with a mandatory reason.
 *
 * All FOUR are prospective (ADR 0005 D18): they stop new touches, new
 * attributions and new accruals, and not one of them reaches a reward, a batch
 * or a ledger entry — which is #147 acceptance 5, held by the import graph of
 * `program.service.ts` rather than by a promise.
 */
router.post(
  '/program-versions/:versionId/pause',
  validateBody(referralProgramLifecycleSchema),
  transitionReferralProgramHandler('pause'),
);
router.post(
  '/program-versions/:versionId/resume',
  validateBody(referralProgramLifecycleSchema),
  transitionReferralProgramHandler('resume'),
);
router.post(
  '/program-versions/:versionId/end',
  validateBody(referralProgramLifecycleSchema),
  transitionReferralProgramHandler('end'),
);
router.post(
  '/program-versions/:versionId/retire',
  validateBody(referralProgramLifecycleSchema),
  transitionReferralProgramHandler('retire'),
);

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

// ── Integrity: conduct, disclosures, signals, enforcement, appeals (#148) ────
//
// On this SAME list, not an eighth. #143 already said why: pausing attribution
// stops partners earning, and #148 is that power at a finer grain plus the one
// #145 stopped short of — taking money back. Splitting them would put one half
// of a partner's fate behind a list the other half's operator is not on.
//
// The set is CLOSED. There is no "clear this signal", no "edit this action", no
// "delete this appeal", no "set this partner's risk state" and no "open an
// appeal for this partner" — that last one because an operator who could open
// an appeal could open one they then decide, and the independence CHECK would
// be satisfied by two accounts one person holds.

/** GET — every conduct-policy version, newest first. */
router.get('/conduct-policies', listConductPolicyVersionsHandler);

/** POST — draft one. The version NUMBER is derived, never supplied. */
router.post(
  '/conduct-policies',
  validateBody(referralConductPolicySchema),
  draftConductPolicyHandler,
);

/** POST — publish it, superseding the incumbent in the same transaction. */
router.post('/conduct-policies/:policyId/publish', publishConductPolicyHandler);

/** POST — draft one disclosure requirement, refusing a forbidden claim BY NAME. */
router.post('/disclosures', validateBody(referralDisclosureSchema), draftDisclosureHandler);

/** POST — publish it, superseding the incumbent of its own (surface, market, language). */
router.post('/disclosures/:disclosureId/publish', publishDisclosureHandler);

/**
 * GET — one partner's whole integrity picture.
 *
 * Opens from a PARTNER id and nothing else. There is deliberately no "which
 * partners match this signal" and no search by name, email or URL: a fraud
 * surface that could be asked "who looks suspicious" is one that has to answer.
 */
router.get('/partners/:partnerId/integrity', traceReferralIntegrityHandler);

/** POST — measure one partner over the trailing window. Records; imposes nothing. */
router.post('/partners/:partnerId/risk-evaluation', evaluateReferralRiskHandler);

/** POST — record one observation an operator made by hand, attributably. */
router.post(
  '/partners/:partnerId/risk-signals',
  validateBody(referralRiskSignalSchema),
  recordReferralRiskSignalHandler,
);

/**
 * POST — impose one SCOPED action.
 *
 * `partner_termination` and `commission_held` are REFUSED here by name, each
 * pointing at the route that performs it: a second writer of
 * `referral_partners.state` or of the reward state machine could disagree with
 * the first.
 */
router.post(
  '/partners/:partnerId/enforcement',
  validateBody(referralEnforcementSchema),
  imposeReferralEnforcementHandler,
);

/** POST — lift one. A compensating record; the decision itself is frozen. */
router.post(
  '/enforcement/:actionId/lift',
  validateBody(referralOperatorReasonSchema),
  liftReferralEnforcementHandler,
);

/** POST — decide an open appeal, as a DIFFERENT operator (a CHECK, not a branch). */
router.post(
  '/appeals/:appealId/decision',
  validateBody(referralAppealDecisionSchema),
  decideReferralAppealHandler,
);

export default router;
