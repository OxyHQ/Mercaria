/**
 * `/referrals/*` — the buyer-facing referral edge (#143).
 *
 * Five routes and no sixth. Each is a BINDING act, the buyer's consent answer,
 * or the one read a disclosure banner needs; none of them creates, transfers or
 * reveals an attribution's partner.
 *
 * ## `resolveCommerceActor` first, limiters after
 *
 * `makeActorRateLimiter` keys on `req.commerceActor`, so without the resolver
 * ahead of it every request would look anonymous and the limiter would silently
 * degrade to per-IP — one NAT would be one shopper.
 *
 * ## Why these are not on `/cart` or `/checkout`
 *
 * They could not be: `cart-merge-isolation.test.ts` and
 * `checkout-contact-isolation.test.ts` fail the build if a cart or checkout
 * module so much as names the referral domain, and both gates are right. A
 * referral is acquisition history; a cart is commerce state; and the moment
 * checkout could reach attribution is the moment attribution could refuse a
 * purchase. So the referral edge stands alone and the CLIENT calls it.
 */

import { Router } from 'express';
import { makeActorRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { validateBody } from '../middleware/validate.js';
import {
  referralBindSchema,
  referralCodeEntrySchema,
  referralConsentSchema,
  referralMerchantBindingSchema,
} from '../middleware/referral-schemas.js';
import {
  referralBindHandler,
  referralCodeEntryHandler,
  referralConsentHandler,
  referralMerchantBindingHandler,
  referralStateHandler,
} from '../controllers/referral.controller.js';

const router = Router();

// ONE resolver for the whole surface (ADR 0003 D1: resolved once per request).
router.use(resolveCommerceActor);

/** GET /referrals/state — what this browser is holding, for the disclosure. */
router.get('/state', makeActorRateLimiter('referral-bind'), referralStateHandler);

/**
 * POST /referrals/consent — the buyer allowed, or declined, Mercaria remembering
 * a followed link. The ONLY route that writes a carrier cookie, and only on
 * `granted`; the carrier is accepted on the request header and nowhere else.
 */
router.post(
  '/consent',
  makeActorRateLimiter('referral-bind'),
  validateBody(referralConsentSchema),
  referralConsentHandler,
);

/** POST /referrals/bind — redeem a carried click for the resolved actor. */
router.post(
  '/bind',
  makeActorRateLimiter('referral-bind'),
  validateBody(referralBindSchema),
  referralBindHandler,
);

/**
 * POST /referrals/code-entry — the buyer typed a code.
 *
 * A much tighter budget than the rest: #143 code rule 5 asks for repeated code
 * guessing and enumeration to be prevented, and a code is a short string
 * somebody can iterate. Every refusal here is identical (#143 code rule 6), so
 * the only thing a guesser learns from a burst is that they have run out.
 */
router.post(
  '/code-entry',
  makeActorRateLimiter('referral-bind', { identifiedMax: 30, anonymousMax: 10 }),
  validateBody(referralCodeEntrySchema),
  referralCodeEntryHandler,
);

/** POST /referrals/merchant-binding — bind a carried click to a held claim. */
router.post(
  '/merchant-binding',
  makeActorRateLimiter('referral-bind', { identifiedMax: 30, anonymousMax: 10 }),
  validateBody(referralMerchantBindingSchema),
  referralMerchantBindingHandler,
);

export default router;
