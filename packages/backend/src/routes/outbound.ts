/**
 * `GET /out/:token` — the affiliate outbound redirect (#67, part of #37).
 *
 * Its own router and its own short prefix, because the path is rendered into
 * public pages: `mercaria.co/out/<token>`.
 *
 * ## Not `/r/:token`
 *
 * #143's referral redirect sends a browser to a MERCARIA page from a partner's
 * link. This sends a browser to SOMEBODY ELSE'S SITE from an offer. Different
 * token, different secret, different allow-list, different risk — and the two
 * must stay separate routes. What they legitimately share is #143's traffic
 * CLASSIFIER, which is a pure function over three self-declared headers; a
 * second copy of it would be a second answer to "is this a person".
 *
 * ## No authentication, and no actor resolution either
 *
 * #143's route resolves a `CommerceActor` because its answer DIFFERS when a
 * subject already exists — a signed-in shopper's touch is written immediately.
 * Nothing here differs: the click record carries no actor of any kind, by
 * design, so resolving one would read a credential this domain has no column to
 * store and no use for. The absence is the privacy property.
 *
 * ## Its own rate-limit bucket
 *
 * `rl:outbound:` rather than the catalogue's. The risk is a different shape: an
 * unmetered redirect is a way to spend a merchant's affiliate quota and to
 * generate click rows, and sharing a bucket would mean a crawler either
 * exhausts shopping for everyone or is not bounded. Generous for #143's reason
 * — one shared product page is unfurled and clicked in bursts by real people.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { affiliateOutboundHandler } from '../controllers/outbound.controller.js';

const router = Router();

router.use(makeRateLimiter('outbound'));

/** GET /out/:token — revalidate, admit the destination, record, and 302. */
router.get('/:token', affiliateOutboundHandler);

export default router;
