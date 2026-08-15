/**
 * `GET /r/:token` — the public referral redirect (#143).
 *
 * Its own router and its own path prefix, deliberately short: a partner pastes
 * this into a post, and `mercaria.co/r/<token>` is the shape ADR 0005 D3 names.
 *
 * ## `resolveCommerceActor`, not `authenticateToken`
 *
 * A referral link is followed by strangers. The resolver is here because the
 * ANSWER differs when a subject already exists — a signed-in shopper's click is
 * recorded immediately against their account, while an anonymous click is
 * carried and bound later (ADR 0003 T10: browsing creates no row). It never
 * refuses: an anonymous caller is a first-class outcome on this route.
 *
 * ## No body parser reaches it and it accepts no query
 *
 * There is nothing to parse — the whole request is a path segment — and the
 * handler reads no query parameter at all, which is what makes "arbitrary
 * campaign injector" (acceptance 2) inexpressible rather than filtered.
 *
 * ## Not #67
 *
 * This sends a browser to a MERCARIA page. The outbound external-offer
 * redirect (#37/#67) does not exist; when it does it is a different route with
 * a different token, a different allow-list and a different risk, and nothing
 * here may grow into it.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { referralRedirectHandler } from '../controllers/referral.controller.js';

const router = Router();

router.use(makeRateLimiter('referral-redirect'), resolveCommerceActor);

/** GET /r/:token — resolve, classify, and 302 to one allow-listed destination. */
router.get('/:token', referralRedirectHandler);

export default router;
