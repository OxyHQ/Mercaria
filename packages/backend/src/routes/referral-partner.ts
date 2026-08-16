/**
 * `/referral-partner/*` — an individual's OWN referral partner record (#146
 * increment 2).
 *
 * The `user` half of the two-mount split. The owner IS the authenticated
 * caller, so there is no permission question to ask and none is asked: #85's
 * `/seller/activation/policies` takes exactly this shape for exactly this
 * reason ("the owner is a PERSON … somebody selling a bicycle has no store and
 * no permission to hold").
 *
 * SINGULAR, deliberately, and none of the three neighbouring plurals:
 * `/referrals` is the buyer edge a shopper's browser calls, `/sellers` is the
 * public P2P profile surface, and `/seller` is a seller's own management
 * surface — which a referral partner need not be. A person may be a partner
 * without ever having listed anything.
 *
 * Its own rate-limit bucket. `rl:referral-bind:` is keyed on a commerce ACTOR
 * and sized for a shopper's redemption traffic; this is an authenticated
 * account writing to its own enrollment, which is a different shape and a much
 * smaller budget.
 */

import { Router } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { makeReferralPartnerRouter } from '../controllers/referral-partner.controller.js';

const router = Router();

// 300 per window: generous for somebody saving a draft as they type and far
// under the SDK's 5 000 default, which is sized for a shopper's browsing.
router.use(authenticateToken, makeRateLimiter('referral-partner', { authenticatedMax: 300 }));

router.use(
  '/',
  makeReferralPartnerRouter((req) => ({
    ownerType: 'user',
    // The verified caller and nothing else. No body, query or header field can
    // influence it, which is what makes "a person can only ever act for their
    // own record" a property of this line rather than of a check downstream.
    ownerId: getRequiredOxyUserId(req),
  })),
);

export default router;
