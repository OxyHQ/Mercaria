/**
 * `/catalog-authoring/*` — the schema surface (#367 step 5, ADR 0007 D10).
 *
 * Authenticated but NOT store-scoped: a category list, a product-type list, a
 * composed schema and a canonical search are the same for every member of every
 * store, and scoping them under `/stores/:storeId` would make one cache entry
 * per store for an answer that does not vary by one.
 *
 * The permission PROJECTION inside a composed schema does vary, and it is
 * derived from `req.storeMembership` — which is absent here, so this surface
 * composes with the read-only projection. A form is opened through the
 * store-scoped draft routes, where the membership is loaded and the projection
 * is real.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { catalogRolloutGate } from '../middleware/catalog-rollout.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import {
  authoringCanonicalSearchQuerySchema,
  authoringCategoriesQuerySchema,
  authoringProductTypesQuerySchema,
  authoringSchemaQuerySchema,
} from '../middleware/catalog-authoring-schemas.js';
import {
  authoringCanonicalSearchHandler,
  authoringCategoriesHandler,
  authoringProductTypesHandler,
  authoringSchemaHandler,
} from '../controllers/catalog-authoring.controller.js';

const router = Router();

router.use(authenticateToken);
// The `listings` bucket, deliberately shared rather than a new scope. These are
// catalogue READS on the same rails a merchant's product screens already use,
// and a scope exists to stop one surface exhausting another's budget — which is
// an argument for separating a surface that CALLS a provider, not one that runs
// four indexed selects.
router.use(makeRateLimiter('listings'));

/**
 * `CATALOG_ROLLOUT_COHORTS` (ADR 0007 D12) is applied PER ROUTE here, and this is
 * the one router in the epic where it cannot be a single `router.use`.
 *
 * `product_type` is the dimension that forces it. The key is a ROUTE parameter
 * (`/schemas/:productTypeKey`), and Express populates route parameters only once
 * a route matches — so a router-level gate would judge a `/schemas/footwear`
 * request with `productTypeKey` unstated, and under a `product_type:footwear`
 * cohort it would refuse the very request that cohort exists to admit. Parsing
 * the key back out of `req.path` was the alternative and was rejected: a route
 * renamed later would silently stop matching, which WIDENS the rollout, and a
 * widening nothing announces is the failure this whole gate exists to prevent.
 *
 * A fifth route added without a gate would be a silent widening too, so it is
 * not left to memory: `routes/__tests__/catalog-rollout-coverage.test.ts` walks
 * the real Express stack of every gated router and fails the build on a route
 * this middleware does not cover.
 *
 * BEFORE `validateQuery` on each, which is where every other gated router puts
 * it: a surface outside the rollout is refused before its input is examined, so
 * an out-of-cohort caller cannot distinguish a valid request from an invalid one
 * and the refusal costs no parsing. The case-folding the query schema would have
 * done is not lost — `catalogRolloutSubjectValue` upper-cases a market and
 * lower-cases a locale itself, precisely so the gate does not depend on having
 * run after somebody else's transform.
 */
router.get(
  '/categories',
  catalogRolloutGate(),
  validateQuery(authoringCategoriesQuerySchema),
  authoringCategoriesHandler,
);
router.get(
  '/product-types',
  catalogRolloutGate(),
  validateQuery(authoringProductTypesQuerySchema),
  authoringProductTypesHandler,
);
/** Literal path FIRST, or `/schemas/:productTypeKey` swallows it. */
router.get(
  '/canonical-search',
  catalogRolloutGate(),
  validateQuery(authoringCanonicalSearchQuerySchema),
  authoringCanonicalSearchHandler,
);
router.get(
  '/schemas/:productTypeKey',
  catalogRolloutGate(),
  validateQuery(authoringSchemaQuerySchema),
  authoringSchemaHandler,
);

export default router;
