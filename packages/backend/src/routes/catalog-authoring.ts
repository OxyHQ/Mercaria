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

router.get('/categories', validateQuery(authoringCategoriesQuerySchema), authoringCategoriesHandler);
router.get(
  '/product-types',
  validateQuery(authoringProductTypesQuerySchema),
  authoringProductTypesHandler,
);
/** Literal path FIRST, or `/schemas/:productTypeKey` swallows it. */
router.get(
  '/canonical-search',
  validateQuery(authoringCanonicalSearchQuerySchema),
  authoringCanonicalSearchHandler,
);
router.get(
  '/schemas/:productTypeKey',
  validateQuery(authoringSchemaQuerySchema),
  authoringSchemaHandler,
);

export default router;
