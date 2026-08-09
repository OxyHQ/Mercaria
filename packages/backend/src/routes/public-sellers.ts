/**
 * Public seller API (#92) — `/sellers/*`.
 *
 * The person behind a P2P listing, as a stranger sees them. NOT to be confused
 * with `/seller/*` (singular), which is the authenticated seller's own
 * management surface — their drafts, their orders, their payment onboarding.
 * The two are one letter apart and could not be more different in who may read
 * them, which is why they are separate routers with separate middleware rather
 * than one router with a public prefix.
 *
 * `optionalAuth` and not `authenticateToken`: a seller page is a seller page
 * whether or not anybody is signed in, and requiring a session to look at a
 * shop would make the marketplace invisible to a first-time visitor. When there
 * IS a session the viewer's own bearer is what asks Oxy the viewer-scoped
 * questions — block state, and whatever Oxy withholds from this caller.
 *
 * ## Its own rate-limit bucket, deliberately
 *
 * `rl:sellers:` rather than the `'stores'` scope the shop page uses. #92 privacy
 * rule 5 asks for enumeration to be metered, and enumeration is exactly the risk
 * here: the route is keyed on an Oxy ACCOUNT ID, so an unmetered surface is a
 * way to walk the id space and learn which Oxy accounts sell on Mercaria and
 * what they sell. Sharing a budget with the store page would mean a crawler
 * either exhausts shopping for everyone or is not bounded at all.
 *
 * There is deliberately NO write route and no follow route. Following a seller
 * is `kind: 'oxy.user'` in Oxy's user-owned graph and the client talks to it
 * directly through `@oxyhq/services`; a Mercaria endpoint that proxied it would
 * be a second copy of somebody else's authority, and one that STORED it would
 * be the app-local person identity #26 exists to prevent.
 */

import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { sellerListingsQuerySchema } from '../middleware/seller-schemas.js';
import {
  getPublicSellerHandler,
  listPublicSellerListingsHandler,
} from '../controllers/public-sellers.controller.js';

const router = Router();

router.use(makeRateLimiter('sellers'), optionalAuth);

/** GET /sellers/:oxyUserId — profile, aggregates and Oxy Trust. */
router.get('/:oxyUserId', getPublicSellerHandler);

/** GET /sellers/:oxyUserId/listings — keyset page of active P2P listings. */
router.get(
  '/:oxyUserId/listings',
  validateQuery(sellerListingsQuerySchema),
  listPublicSellerListingsHandler,
);

export default router;
