/**
 * `/catalog-attributes/*` — the PUBLIC attribute and constraint surface (#94).
 *
 * Reads and pure computations only: what the registry says, what a category can
 * be filtered on, whether a set of requirements is answerable, and how one
 * product measures against it. No writes; values are recorded through ingestion
 * (#62) and the operator surface.
 *
 * No auth, because everything served is public catalogue identity with no
 * viewer-specific hydration — the `canonical-products` precedent. Rate-limited
 * under the `'listings'` scope, the closest read-path budget, and the evaluation
 * endpoint shares it deliberately: it is bounded work over one product, not a
 * search.
 *
 * Route ORDER is load-bearing: `/definitions` and `/facets` must precede
 * `/values/:entityKind/:entityId`, and `/constraints/*` is its own prefix so no
 * parameter route can swallow it.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  attributeDefinitionQuerySchema,
  attributeFacetQuerySchema,
  constraintSetEvaluateSchema,
  constraintSetValidateSchema,
} from '../middleware/attribute-schemas.js';
import {
  evaluateConstraintsHandler,
  getPublicAttributeValuesHandler,
  listAttributeDefinitionsHandler,
  listAttributeFacetsHandler,
  validateConstraintsHandler,
} from '../controllers/catalog-attributes.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** Definitions by category, or one key's active (or named) version. */
router.get(
  '/definitions',
  validateQuery(attributeDefinitionQuerySchema),
  listAttributeDefinitionsHandler,
);

/** Filter facets for one category, derived from the same registry. */
router.get('/facets', validateQuery(attributeFacetQuerySchema), listAttributeFacetsHandler);

/** Validate a constraint set BEFORE search — the pre-flight (#94 API rule 3). */
router.post(
  '/constraints/validate',
  validateBody(constraintSetValidateSchema),
  validateConstraintsHandler,
);

/** Evaluate one product or variant against a set, with its explanation. */
router.post(
  '/constraints/evaluate',
  validateBody(constraintSetEvaluateSchema),
  evaluateConstraintsHandler,
);

/** The SELECTED values of one entity, with no internal provenance. */
router.get('/values/:entityKind/:entityId', getPublicAttributeValuesHandler);

export default router;
