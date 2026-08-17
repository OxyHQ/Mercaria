/**
 * `/compatibility` — the PUBLIC fitment surface (#367 step 8, ADR 0007 D8).
 *
 * Eight reads, no writes, and the reason the domain needed a router at all: it was
 * fully modelled and fully unwired, so a product page had exactly two options for
 * "does this brake pad fit my car" — compose the answer from the title, or render
 * nothing. `packages/frontend/lib/catalog/compatibility.ts` took the second, by
 * name. This is the read that makes the first one unnecessary.
 *
 * No auth: whether a part fits a car is public product information with no
 * viewer-specific hydration, and the vehicle a shopper names travels in the query
 * and is stored NOWHERE — `COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS` keeps a VIN, a
 * plate and a buyer out of the tables, and this surface adds no place to put one.
 * Rate-limited under the `'listings'` scope, the closest read-path budget and the
 * one `/offers`, `/merchants` and `/canonical-products` share.
 *
 * ## Why this mounts unconditionally, where `/price-history` and `/price-signals`
 * have their own read lever
 *
 * Reviewed and approved rather than assumed, because the next person to read this
 * file will reach for the flag precisely because two sibling domains have one.
 * Three reasons, and the second is the decisive one:
 *
 *  1. **The publication policy already IS the lever, and a narrower one.** A flag
 *     gates a mount; the policy gates the CLAIM. A POSITIVE fit publishes only at
 *     `verification = 'verified'` (so a disputed one publishes nothing), a NEGATIVE
 *     one publishes from a wider set including `disputed` because it is a caution,
 *     and an absent fact answers `unknown` rather than `does_not_apply`. Withdrawal
 *     is per row through `closeCompatibilityRelation`, which is the correction this
 *     domain deliberately built instead of a delete.
 *  2. **A lever here could not change an answer.** Nothing populates
 *     `automotive_fitments` or `generic_compatibility_relations` on a real
 *     deployment yet — no adapter imports a vehicle tree, and a claim becomes
 *     canonical only through a verification somebody performs. So a default-false
 *     lever's entire effect today is a 404 in front of an answer that would be
 *     empty either way. The house rule is that a flag gates a mount or a loop and
 *     never a durable record; it is not that every public read has one.
 *  3. **It would have to default false to preserve today's behaviour**, and today's
 *     behaviour is that a product page renders no fitment at all — so the lever's
 *     only effect would be to keep it that way, which is the state this surface
 *     exists to end.
 *
 * `/price-history` and `/price-signals` differ on all three: both publish a DERIVED
 * CLAIM over data production already holds — a chart through real observations, a
 * "good price" over real offers — so for them a lever is the only way to withdraw a
 * claim that turns out to be wrong.
 *
 * ## The two directions share ONE route
 *
 * `GET /compatibility/relations` answers "what does this fit" or "what fits this"
 * depending on which selector arrives, and says which in the response. They are one
 * index read of one table in two directions (a `target_to_subject` direction is
 * deliberately unrepresentable — the reverse of a directed claim is the same fact
 * with the endpoints swapped), so two routes would be two names for one read. What
 * the schema refuses is a request naming BOTH, which is a third question.
 *
 * ## There is no write route and there cannot be one
 *
 * A fit is asserted into `compatibility_claims` by a manufacturer publication, a
 * feed, a merchant or the matcher, and becomes canonical through a verification
 * (ADR 0007 D7). A public write here would be a way to publish a fit nobody
 * asserted — and a wrong fitment claim is the highest-cost wrong answer in this
 * epic, because somebody buys a brake pad that does not fit their car.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import {
  compatibilityRelationsQuerySchema,
  fitmentVerdictQuerySchema,
  partFitmentsQuerySchema,
  vehicleConfigurationsQuerySchema,
} from '../middleware/compatibility-schemas.js';
import {
  compatibilityRelationsHandler,
  fitmentVerdictHandler,
  partFitmentsHandler,
  vehicleConfigurationsHandler,
  vehicleGenerationsHandler,
  vehicleMakesHandler,
  vehicleModelsHandler,
} from '../controllers/compatibility.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** Generic compatibility, either direction. Exactly one selector. */
router.get('/relations', validateQuery(compatibilityRelationsQuerySchema), compatibilityRelationsHandler);

/**
 * Automotive fitment. `/verdict` is declared BEFORE `/fitments` would ever be
 * matched as a prefix — they are distinct paths, so the order is not load-bearing
 * here, and it is written this way round so the narrower question reads first.
 */
router.get('/fitments/verdict', validateQuery(fitmentVerdictQuerySchema), fitmentVerdictHandler);
router.get('/fitments', validateQuery(partFitmentsQuerySchema), partFitmentsHandler);

/**
 * The vehicle picker, one route per rung, with each parent id in the PATH.
 *
 * In the path rather than the query because every rung below the first is
 * meaningless without its parent: a `models` read with no make is every model of
 * every manufacturer, and a query parameter is the shape in which that arrives by
 * omission. A single `?level=` route would need a refinement per rung to say the
 * same thing.
 */
router.get('/vehicles/makes', vehicleMakesHandler);
router.get('/vehicles/makes/:makeId/models', vehicleModelsHandler);
router.get('/vehicles/models/:modelId/generations', vehicleGenerationsHandler);
router.get(
  '/vehicles/generations/:generationId/configurations',
  validateQuery(vehicleConfigurationsQuerySchema),
  vehicleConfigurationsHandler,
);

export default router;
