/**
 * Catalog administration and governance (#367 Workstream 12) — the operator
 * surface over ADR 0007's nine catalog domains.
 *
 * ## The SAME allow-list, and why this is not a seventh
 *
 * `CATALOG_OPERATOR_OXY_USER_IDS`, which #54, #55, #56, #57, #58, #60, #62,
 * #68, #70, #78, #83, #90, #94 and #367's own proposals surface already use.
 * This domain administers exactly those domains — it holds no power they do not
 * already hold, it just puts an impact measurement, a second pair of eyes and
 * one audit trail in front of them. A separate list would mean an operator who
 * may deprecate an attribute directly at `/internal/catalog-attributes` but not
 * through the surface that measures what deprecating it would do, which is the
 * wrong way round.
 *
 * Empty list = NOT MOUNTED at all (404, never 401), gated in `app.ts` on
 * `config.catalog.graphOperatorSurfaceEnabled`.
 *
 * WITHIN that list, `catalog_governance_role_grants` narrows: view, propose,
 * review, translate, publish. A grant can never admit anybody the env list
 * excludes, which is what keeps the refinement from becoming a second identity
 * system. See `services/catalog-governance/role.service.ts`.
 *
 * ## The route set is CLOSED, and the omissions are the design
 *
 * There is deliberately NO route that:
 *
 * - decides a PROPOSAL. All seven decisions live at
 *   `/internal/catalog-proposals/*` behind this same gate, writing the same
 *   `catalog_review_events` trail. A second route to one decision is how two
 *   surfaces come to disagree about what it meant. This surface CONSUMES
 *   proposals by counting their backlog on the desk.
 * - drafts or publishes an ATTRIBUTE definition directly —
 *   `/internal/catalog-attributes` owns that, and this surface plans a
 *   publication so the impact is measured first.
 * - edits or deletes an audit event, a change request that has been applied, or
 *   a role grant. `rewrite_audit_history`, `edit_applied_change_request` and
 *   `delete_definition` are named in
 *   `CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES`, and the triggers refuse all
 *   three whatever a route did.
 * - forces a snapshot restore over a divergent row, or a vertical package over
 *   one. Both report divergence and neither corrects it.
 *
 * `catalog-governance-isolation.test.ts` enumerates the registered paths
 * EXACTLY, so an eighteenth route is a decision somebody makes on purpose.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  auditQuerySchema,
  changeQuerySchema,
  decideChangeSchema,
  diffQuerySchema,
  exportSnapshotSchema,
  grantRoleSchema,
  impactQuerySchema,
  orphanQuerySchema,
  planChangeSchema,
  restoreSnapshotSchema,
  attributeClaimQueueQuerySchema,
  compatibilityClaimQueueQuerySchema,
  promoteCompatibilityClaimSchema,
  settleAttributeClaimSchema,
  reviewCompatibilityClaimSchema,
  reviewExternalMappingSchema,
  reviewLocalizationSchema,
  revokeRoleSchema,
  roleQuerySchema,
  snapshotQuerySchema,
  verticalPackageCensusQuerySchema,
  verticalPackageSchema,
} from '../middleware/catalog-governance-schemas.js';
import {
  applyChangeHandler,
  approveChangeHandler,
  attributeDiffHandler,
  auditHandler,
  changeQueueHandler,
  changeTraceHandler,
  exportSnapshotHandler,
  governanceCapabilitiesHandler,
  governanceImpactHandler,
  grantRoleHandler,
  orphanHandler,
  planChangeHandler,
  productTypeDiffHandler,
  qualityHandler,
  queuesHandler,
  rejectChangeHandler,
  restoreSnapshotHandler,
  attributeClaimQueueHandler,
  compatibilityClaimQueueHandler,
  promoteCompatibilityClaimHandler,
  settleAttributeClaimHandler,
  reviewCompatibilityClaimHandler,
  reviewExternalMappingHandler,
  reviewLocalizationHandler,
  revokeRoleHandler,
  roleListHandler,
  snapshotDocumentHandler,
  snapshotListHandler,
  verticalPackageCensusHandler,
  verticalPackageHandler,
  verticalPackageListHandler,
  withdrawChangeHandler,
} from '../controllers/catalog-governance.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — what the calling operator may do here, and whether roles are enforced. */
router.get('/me', governanceCapabilitiesHandler);

/** GET — what a change to this subject would touch, BEFORE anything is planned. */
router.get('/impact', validateQuery(impactQuerySchema), governanceImpactHandler);

/** POST — plan a change: measure the impact and decide whether it needs two people. */
router.post('/changes', validateBody(planChangeSchema), planChangeHandler);

/** GET — the change queue. */
router.get('/changes', validateQuery(changeQuerySchema), changeQueueHandler);

/** GET — one change request with its measurements. */
router.get('/changes/:changeId', validateId('changeId'), changeTraceHandler);

/** POST — approve a planned change. Refuses the operator who planned it. */
router.post(
  '/changes/:changeId/approve',
  validateId('changeId'),
  validateBody(decideChangeSchema),
  approveChangeHandler,
);

/** POST — apply an approved change by driving the owning domain's own writer. */
router.post('/changes/:changeId/apply', validateId('changeId'), applyChangeHandler);

/** POST — reject a change. */
router.post(
  '/changes/:changeId/reject',
  validateId('changeId'),
  validateBody(decideChangeSchema),
  rejectChangeHandler,
);

/** POST — withdraw your own change. */
router.post(
  '/changes/:changeId/withdraw',
  validateId('changeId'),
  validateBody(decideChangeSchema),
  withdrawChangeHandler,
);

/** GET — what changed between two product type versions. */
router.get(
  '/diff/product-types/:key',
  validateQuery(diffQuerySchema),
  productTypeDiffHandler,
);

/** GET — what changed between two attribute definition versions. */
router.get('/diff/attributes/:key', validateQuery(diffQuerySchema), attributeDiffHandler);

/** GET — the immutable audit trail: actor, reason, before/after, source, timestamp. */
router.get('/audit', validateQuery(auditQuerySchema), auditHandler);

/** GET — every backlog, in one ordering. */
router.get('/queues', queuesHandler);

/** GET — completeness by category, type, locale and source, plus duplicates. */
router.get('/quality', qualityHandler);

/** GET — pointers into definitions an operator has taken out of service. */
router.get('/quality/orphans', validateQuery(orphanQuerySchema), orphanHandler);

/** GET — every role grant, live and revoked. */
router.get('/roles', validateQuery(roleQuerySchema), roleListHandler);

/** POST — grant a role WITHIN the allow-list. Never admits anybody to it. */
router.post('/roles', validateBody(grantRoleSchema), grantRoleHandler);

/**
 * POST — revoke a role.
 *
 * A POST and not a DELETE, because it carries a reason and the row is kept: a
 * revocation is a new fact about a grant, not the removal of one.
 */
router.post('/roles/revoke', validateBody(revokeRoleSchema), revokeRoleHandler);

/** GET — the snapshot catalogue, without the documents. */
router.get('/snapshots', validateQuery(snapshotQuerySchema), snapshotListHandler);

/** POST — export the catalog definitions in scope. Refuses an empty export. */
router.post('/snapshots', validateBody(exportSnapshotSchema), exportSnapshotHandler);

/** GET — one snapshot's document. */
router.get('/snapshots/:snapshotId', validateId('snapshotId'), snapshotDocumentHandler);

/** POST — plan (default) or apply a restore. Insert-only; divergence is reported. */
router.post(
  '/snapshots/:snapshotId/restore',
  validateId('snapshotId'),
  validateBody(restoreSnapshotSchema),
  restoreSnapshotHandler,
);

/** GET — the versioned vertical packages this deployment ships. */
router.get('/vertical-packages', verticalPackageListHandler);

/** POST — plan (default) or apply one. Drives `seed-verticals` and nothing else. */
router.post(
  '/vertical-packages/:packageName',
  validateBody(verticalPackageSchema),
  verticalPackageHandler,
);

/** GET — the census: did a previous application actually land anything. */
router.get(
  '/vertical-packages/:packageName/census',
  validateQuery(verticalPackageCensusQuerySchema),
  verticalPackageCensusHandler,
);

/** POST — review one translation. The localization domain has no other surface. */
router.post(
  '/reviews/localization',
  validateBody(reviewLocalizationSchema),
  reviewLocalizationHandler,
);

/** POST — approve, reject or fan-out-approve one external mapping. */
router.post(
  '/reviews/external-mappings/:mappingId',
  validateId('mappingId'),
  validateBody(reviewExternalMappingSchema),
  reviewExternalMappingHandler,
);

/**
 * GET — the variant-grain attribute-claim backlog (#576).
 *
 * Declared before the `:claimId` route below for the same reason its
 * compatibility twin is: not load-bearing for routing, written this way round
 * because the read an operator reaches for first should read first.
 */
router.get(
  '/reviews/attribute-claims',
  validateQuery(attributeClaimQueueQuerySchema),
  attributeClaimQueueHandler,
);

/**
 * POST — settle one attribute claim, at either grain.
 *
 * `review` and not `publish`: a settlement records what the registry answers for
 * a claim and creates no row a shopper is shown. It sits on the SAME side of the
 * role boundary as the compatibility review below, and the opposite side from
 * the promotion beside it.
 *
 * One route for both grains rather than two, because the act is identical and
 * the table is a required field of the request — two paths would be two
 * spellings of one decision, and the id spaces are disjoint anyway.
 */
router.post(
  '/reviews/attribute-claims/:claimId',
  validateId('claimId'),
  validateBody(settleAttributeClaimSchema),
  settleAttributeClaimHandler,
);

/**
 * GET — the unresolved compatibility-claim queue.
 *
 * Declared BEFORE the two `:claimId` routes below. Not load-bearing for routing
 * (a literal `/reviews/compatibility-claims` cannot be captured by a sibling
 * whose path has one more segment), and written this way round because the read
 * an operator reaches for first should read first.
 */
router.get(
  '/reviews/compatibility-claims',
  validateQuery(compatibilityClaimQueueQuerySchema),
  compatibilityClaimQueueHandler,
);

/** POST — review one compatibility claim. Publishes nothing. */
router.post(
  '/reviews/compatibility-claims/:claimId',
  validateId('claimId'),
  validateBody(reviewCompatibilityClaimSchema),
  reviewCompatibilityClaimHandler,
);

/**
 * POST — promote one claim to a canonical fitment.
 *
 * A different act from the review above and a different role (`publish`, not
 * `review`), because this one creates the row a shopper acts on. The vehicle is
 * required in the body; nothing here derives it.
 */
router.post(
  '/reviews/compatibility-claims/:claimId/fitment',
  validateId('claimId'),
  validateBody(promoteCompatibilityClaimSchema),
  promoteCompatibilityClaimHandler,
);

export default router;
