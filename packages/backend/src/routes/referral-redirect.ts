/**
 * `GET /r/:token` — the public referral redirect (#143).
 *
 * Its own router and its own path prefix, deliberately short: a partner pastes
 * this into a post, and `mercaria.co/r/<token>` is the shape ADR 0005 D3 names.
 *
 * ## No actor is resolved, on purpose
 *
 * The redirect stores nothing on the device and attributes nothing: a click is
 * not consent (ePrivacy Art. 5(3)), so even a signed-in shopper's click waits
 * for the storefront's consent prompt and `POST /referrals/consent`. With no
 * touch to write there is no subject to look up, and not resolving one makes
 * "the redirect cannot attribute" a property of the route rather than a branch
 * somebody could restore. The answer is the same for everybody: a 302 whose
 * fragment carries the signed click evidence.
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
import { referralRedirectHandler } from '../controllers/referral.controller.js';

const router = Router();

router.use(makeRateLimiter('referral-redirect'));

/** GET /r/:token — resolve, classify, and 302 to one allow-listed destination. */
router.get('/:token', referralRedirectHandler);

export default router;
