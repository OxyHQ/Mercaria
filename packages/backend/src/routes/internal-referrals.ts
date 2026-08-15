/**
 * `/internal/referrals/*` — the referral operator surface (#143).
 *
 * On the SEVENTH allow-list (`REFERRAL_OPERATOR_OXY_USER_IDS`), for the reason
 * `middleware/referral-operator-authz.ts` gives: pausing a program's
 * attribution stops partners earning, and an operator vetted to repair a
 * payment or trace a cart merge has not been vetted for that.
 *
 * THREE routes, and the route set is CLOSED. There is no "attribute this
 * subject to that partner", no "create a touch", no "extend this window", no
 * "move this attribution", no "reveal who is attributed to this account" and no
 * delete. Each would be a way to make the record say something nobody observed;
 * the two corrections an operator legitimately makes already exist in #142,
 * append-only and attributable.
 *
 * Mounted while both levers are down and while `REFERRALS_ENABLED` is off — the
 * standing rule that the evidence has to be readable during the incident that
 * turned the surface off.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireReferralOperator } from '../middleware/referral-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import { referralProgramControlsSchema } from '../middleware/referral-schemas.js';
import {
  getReferralAttributionTraceHandler,
  getReferralProgramControlsHandler,
  setReferralProgramControlsHandler,
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

export default router;
