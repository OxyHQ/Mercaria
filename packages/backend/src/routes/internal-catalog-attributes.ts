/**
 * `/internal/catalog-attributes/*` — the attribute registry's operator surface
 * (#94).
 *
 * The `/internal/canonical-catalog` shape, applied to the attribute domain:
 * mounted OUTSIDE `/admin` because no store membership could authorize changing
 * what an attribute MEANS for every seller; mount gated on
 * `CATALOG_OPERATOR_OXY_USER_IDS` being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 *
 * A SEPARATE router from `/internal/canonical-catalog`, deliberately, rather
 * than new paths appended to it: the attribute registry moves at its own rate
 * and belongs to its own issue, and one router accumulating every internal
 * catalogue write is how a file nobody owns is born. They share the ONE operator
 * allow-list, which is the part that must not fork.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  attributeCoverageQuerySchema,
  attributeDefinitionDraftSchema,
  attributeDeprecateSchema,
  attributeObservationSchema,
  attributeReviewQuerySchema,
  attributeReviewResolveSchema,
  attributeSourceMappingSchema,
} from '../middleware/attribute-schemas.js';
import {
  aliasFoldAuditHandler,
  applyObservationHandler,
  coverageHandler,
  deprecateDefinitionHandler,
  draftDefinitionHandler,
  getActiveDefinitionHandler,
  listDefinitionHistoryHandler,
  listReindexRequestsHandler,
  listReviewsHandler,
  listSourceValuesHandler,
  publishDefinitionHandler,
  resolveReviewHandler,
  retireDefinitionHandler,
  upsertSourceMappingHandler,
} from '../controllers/internal-catalog-attributes.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** Definition versions. Drafting and publishing are two audited acts. */
router.post('/definitions', validateBody(attributeDefinitionDraftSchema), draftDefinitionHandler);
// Route ORDER: the three lifecycle suffixes and `/versions` are distinct, but
// all must precede the bare `/definitions/:key`, or it swallows them.
router.post('/definitions/:key/versions/:version/publish', publishDefinitionHandler);
router.post(
  '/definitions/:key/versions/:version/deprecate',
  validateBody(attributeDeprecateSchema),
  deprecateDefinitionHandler,
);
router.post('/definitions/:key/versions/:version/retire', retireDefinitionHandler);
router.get('/definitions/:key/versions', listDefinitionHistoryHandler);
router.get('/definitions/:key', getActiveDefinitionHandler);

/** How one feed's field names map onto the registry (#94 coverage rule 4). */
router.post(
  '/source-mappings',
  validateBody(attributeSourceMappingSchema),
  upsertSourceMappingHandler,
);

/** Record what a SOURCE said. Never a canonical value — see the controller. */
router.post('/observations', validateBody(attributeObservationSchema), applyObservationHandler);

/** Every recorded fact about one entity, with the provenance public reads omit. */
router.get('/values/:entityKind/:entityId', listSourceValuesHandler);

/** The conflicting-value review queue. */
router.get('/reviews', validateQuery(attributeReviewQuerySchema), listReviewsHandler);
router.post(
  '/reviews/:id/resolve',
  validateBody(attributeReviewResolveSchema),
  resolveReviewHandler,
);

/** Completeness by category, source and field. */
router.get('/coverage', validateQuery(attributeCoverageQuerySchema), coverageHandler);

/**
 * #632 — how far apart the write-side and read-side alias folds have carried the
 * registry. READ ONLY, and deliberately with no repair beside it: a collision
 * pointing at two canonical values is a catalogue judgement, not a patch.
 */
router.get('/alias-fold-audit', aliasFoldAuditHandler);

/** What is waiting to be re-indexed. Read-only — see the controller. */
router.get('/reindex-requests', listReindexRequestsHandler);

export default router;
