/**
 * `/internal/taxonomy/*` — the taxonomy domain's operator surface for
 * CLASSIFICATION (#367 Workstream 1).
 *
 * On the SAME allow-list (`CATALOG_OPERATOR_OXY_USER_IDS`) that #54, #55, #56,
 * #57, #58, #60, #62, #68, #70, #78, #83, #90 and #94 use. Not a seventh list:
 * deciding that a product is ALSO a regulated battery is the same power over
 * the same graph as deciding what a category means, and an operator who may
 * deprecate a category at `/internal/catalog-governance` but not see what is
 * filed under it would be holding half a decision.
 *
 * Mount gated on the allow-list being non-empty, so a deployment with no
 * operators 404s rather than 401s — a 401 advertises the surface.
 *
 * ## Why this is operator-gated and not seller-facing
 *
 * The PRIMARY category is seller-facing and stays exactly as it is: a required
 * `category` slug on `POST /seller/listings` and on the store product routes,
 * resolved by `catalog-write.service`. Nothing here touches it, and a seller's
 * ability to classify their own listing is unchanged by this file.
 *
 * A SECONDARY classification is the exception, and the epic's own wording is
 * "where required". Every admissible reason is either a scheme somebody must
 * cite (regulatory, tax, safety) or a judgement about the catalogue's shape —
 * and an unrestricted seller-facing version of it is precisely the mechanism
 * for "assigning fake categories to products" that the epic's merchandising
 * box asks to prevent. A seller-facing route can be added later behind a
 * store permission; it cannot be taken away once sellers depend on it.
 *
 * ## Route ORDER is load-bearing
 *
 * `/categories/:categoryId/usage` is a distinct prefix from
 * `/classifications/:subjectKind/:subjectId`, so the two cannot swallow each
 * other — stated because `taxonomy.ts` carries the same warning for the same
 * reason and the next person adding a literal segment here needs to see it.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import { secondaryClassificationSchema } from '../middleware/taxonomy-classification-schemas.js';
import {
  createSecondaryClassificationHandler,
  deleteSecondaryClassificationHandler,
  getCategoryClassificationUsageHandler,
  getProductClassificationHandler,
} from '../controllers/taxonomy-classification.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list: the gate reads the VERIFIED
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — the primary plus every secondary classification for one subject. */
router.get('/classifications/:subjectKind/:subjectId', getProductClassificationHandler);

/** POST — file one justified secondary classification. */
router.post(
  '/classifications/:subjectKind/:subjectId',
  validateBody(secondaryClassificationSchema),
  createSecondaryClassificationHandler,
);

/** DELETE — withdraw one. */
router.delete(
  '/classifications/:subjectKind/:subjectId/:categoryId',
  deleteSecondaryClassificationHandler,
);

/** GET — how many subjects name this category as a secondary, by subject kind. */
router.get('/categories/:categoryId/usage', getCategoryClassificationUsageHandler);

export default router;
