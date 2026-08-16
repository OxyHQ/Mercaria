/**
 * `/internal/canonical-catalog/*` — the canonical PRODUCT operator surface (#56).
 *
 * The `/internal/commerce-graph` shape, applied to the product layer: mounted
 * OUTSIDE `/admin` because no store membership could authorize a write that
 * changes what a product IS for every seller; mount gated on
 * `CATALOG_OPERATOR_OXY_USER_IDS` being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 *
 * A SEPARATE router from `/internal/commerce-graph`, deliberately, rather than
 * new paths appended to it: the two surfaces move at different rates and belong
 * to different issues, and one router accumulating every internal catalogue
 * write is how a file nobody owns is born. They share the ONE operator
 * allow-list, which is the part that must not fork.
 *
 * Every write here takes SOURCE FACTS or an explicit operator decision. There is
 * no endpoint that accepts a canonical value from an ingestion caller (#56 API
 * rule 4) — see `middleware/canonical-catalog-schemas.ts`, where that is a
 * property of the schemas rather than a convention of the handlers.
 *
 * **There is NO merge route here, and there must never be one again.** #53/#56
 * shipped three (`/product-families/:winnerId/merge`, `/products/:winnerId/merge`,
 * `/variants/:winnerId/merge`), each a single-transaction merge that skipped
 * #59's conflict gate, its census-complete rehoming plan, its impact estimate
 * and its audit timeline — and moved a strict SUBSET of the columns the plan
 * covers, so a merged product's own variants, images, attribute values, saves,
 * alerts and match rows were left pointing at a tombstone with every page still
 * rendering. They were deleted whole (#36 completion criterion 4). The merge an
 * operator uses is `POST /internal/commerce-graph/merge-jobs`, which is the same
 * allow-list one router over and covers all seven mergeable entity types.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  canonicalProductCreateSchema,
  canonicalProductObservationSchema,
  canonicalVariantCreateSchema,
  identifierAssignSchema,
  identifierCorrectSchema,
  productFamilyCreateSchema,
} from '../middleware/canonical-catalog-schemas.js';
import {
  applyProductObservationHandler,
  assignIdentifierHandler,
  correctIdentifierHandler,
  createCanonicalProductHandler,
  createCanonicalVariantHandler,
  createProductFamilyHandler,
} from '../controllers/canonical-catalog-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** Product families. Creation is EXPLICIT; no source path mints one (#56). */
router.post('/product-families', validateBody(productFamilyCreateSchema), createProductFamilyHandler);

/** Canonical products. */
router.post('/products', validateBody(canonicalProductCreateSchema), createCanonicalProductHandler);
// Route ORDER is load-bearing: `/products/:productId/variants` and
// `/products/:productId/observations` are distinct suffixes, so neither swallows
// the other, but both must precede any future bare `/products/:id` route.
router.post(
  '/products/:productId/variants',
  validateBody(canonicalVariantCreateSchema),
  createCanonicalVariantHandler,
);
router.post(
  '/products/:productId/observations',
  validateBody(canonicalProductObservationSchema),
  applyProductObservationHandler,
);

/** Identifiers. A collision answers `disputed`, never a moved owner. */
router.post('/identifiers', validateBody(identifierAssignSchema), assignIdentifierHandler);
router.post(
  '/identifiers/:id/correct',
  validateBody(identifierCorrectSchema),
  correctIdentifierHandler,
);

export default router;
