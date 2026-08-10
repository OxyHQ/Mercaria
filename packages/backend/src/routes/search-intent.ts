/**
 * `POST /search-intent` — natural-language shopping interpretation (#95).
 *
 * Mounted UNCONDITIONALLY, and that is the decision worth reading. Every other
 * surface in this codebase with a rollout lever gates its MOUNT; this one does
 * not, because the deterministic interpreter is the FLOOR rather than a
 * degraded mode. `NL_INTENT_ENABLED` gates whether a MODEL may be called, and a
 * deployment with it off — the default — still has a working natural-language
 * search box that reads identifiers, locale-aware money, magnitudes against
 * #94's registry, condition, channel and category. A lever that could 404 this
 * route would withdraw a working feature for no benefit.
 *
 * `resolveCommerceActor` rather than `authenticateToken`: an interpretation is
 * a read a shopper performs before they have decided to buy anything, and most
 * of that traffic carries no credential at all. The actor is used for ONE
 * thing — deciding who owns a clarification session — and an anonymous shopper
 * gets one addressed by its id alone (see `search_intent_sessions`).
 *
 * Its OWN rate-limit bucket (`rl:search-intent:`), which is #95 safety rule 8
 * verbatim: "rate-limit expensive parsing independently of ordinary search". A
 * parse may call a provider and a search does not, so sharing the `'listings'`
 * budget would let a parse flood exhaust the allowance a shopper needs to
 * BROWSE — and would make the model's cost bounded by the same number that
 * bounds a category page.
 */

import { Router } from 'express';
import { makeActorRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { validateBody } from '../middleware/validate.js';
import { shoppingIntentSchema } from '../middleware/search-intent-schemas.js';
import { shoppingIntentHandler } from '../controllers/search-intent.controller.js';

const router = Router();

router.use(resolveCommerceActor);
router.use(makeActorRateLimiter('search-intent'));

router.post('/', validateBody(shoppingIntentSchema), shoppingIntentHandler);

export default router;
