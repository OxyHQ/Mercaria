/**
 * `/nearby` — the public proximity surface (#93).
 *
 * Mounted only when `NEARBY_DISCOVERY_ENABLED` is on, so an unconfigured
 * deployment 404s rather than answering with an empty list: "nothing is
 * collectable near you" and "this deployment does not offer nearby discovery"
 * are different facts and a shopper acts differently on each.
 *
 * `resolveCommerceActor` rather than `authenticateToken` — #93 nearby rule 11
 * and client rule 9, browsing must not need an account. It runs the SAME
 * resolver cart and checkout do rather than a second one, so an anonymous
 * caller, a guest and an Oxy buyer all reach the same handler.
 *
 * Its own rate-limit bucket (`rl:nearby:`): the route is keyed on a POSITION,
 * so the thing worth bounding is somebody sweeping a grid of coordinates to
 * enumerate a merchant's branch network and its stock, which is a different
 * shape of abuse from the catalogue reads sharing the `listings` bucket.
 */

import { Router } from 'express';
import { makeActorRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { validateQuery } from '../middleware/validate.js';
import {
  nearbyP2pQuerySchema,
  nearbyPlacesQuerySchema,
  nearbyQuerySchema,
} from '../middleware/pickup-schemas.js';
import {
  nearbyHandler,
  nearbyP2pHandler,
  nearbyPlacesHandler,
} from '../controllers/pickup.controller.js';

const router = Router();

router.use(makeActorRateLimiter('nearby'), resolveCommerceActor);

/** GET /nearby — collectable locations for one canonical entity, nearest first. */
router.get('/', validateQuery(nearbyQuerySchema), nearbyHandler);

/** GET /nearby/places — the manual-location fallback, composed from real stock. */
router.get('/places', validateQuery(nearbyPlacesQuerySchema), nearbyPlacesHandler);

/** GET /nearby/p2p — coarse local discovery of P2P listings. Never a collection promise. */
router.get('/p2p', validateQuery(nearbyP2pQuerySchema), nearbyP2pHandler);

export default router;
