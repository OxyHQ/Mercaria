/**
 * `/internal/commerce-graph/*` — the canonical-graph operator surface (#54).
 *
 * The `/internal/payments` shape, applied to a different power: mounted
 * OUTSIDE `/admin` because no store membership could authorize a write that
 * joins ANY merchant to ANY store; mount gated on the allow-list being
 * non-empty (404 on a deployment with no operators, never a 401 that would
 * advertise the surface); the gate repeated in middleware because mount and
 * gate live in different files. Full reasoning: `routes/internal-payments.ts`
 * and `middleware/catalog-operator-authz.ts`.
 *
 * LINKAGE (#54), the RELATIONSHIP review workflow (#55), merchant-claim REVIEW
 * (#83) and the CURATION half — the review queue, merge and split jobs,
 * corrections and the `catalog_revisions` timeline (#59, ADR 0002 D16) — all
 * live here, behind this one gate. The relationship CORRECTION path is #55's
 * own: it needs no revisions row, because a correction is a new row linked to
 * the one it replaces rather than an edit anything has to record the
 * before-state of.
 *
 * The claim-review routes are here and not on a surface of their own for the
 * reason this gate exists: deciding who operates a merchant is the same power
 * as linking one to a native store, exercised over the same graph, and a
 * second allow-list for it would be a second thing to keep in step with this
 * one.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import { holdStoreActivationSchema } from '../middleware/merchant-activation-schemas.js';
import {
  getActivationTraceHandler,
  holdActivationHandler,
  observeActivationHandler,
  releaseActivationHoldHandler,
} from '../controllers/merchant-activation.controller.js';
import {
  nativeStoreLinkCreateSchema,
  nativeStoreLinkRevokeSchema,
} from '../middleware/commerce-graph-schemas.js';
import {
  relationshipApproveSchema,
  relationshipAssertSchema,
  relationshipCorrectSchema,
  relationshipEndSchema,
  relationshipEvidenceRevokeSchema,
  relationshipEvidenceSchema,
  relationshipQueueQuerySchema,
  relationshipReviewSchema,
  relationshipVerifySchema,
} from '../middleware/relationship-schemas.js';
import {
  merchantClaimDecisionSchema,
  merchantClaimQueueQuerySchema,
  merchantClaimRevokeSchema,
} from '../middleware/merchant-claim-schemas.js';
import {
  storeLinkageCandidateSchema,
  storeLinkageCorrectionSchema,
  storeLinkageDecisionSchema,
} from '../middleware/store-linkage-schemas.js';
import {
  createNativeStoreLinkHandler,
  revokeNativeStoreLinkHandler,
} from '../controllers/commerce-graph-operator.controller.js';
import {
  approveRelationshipHandler,
  assertRelationshipHandler,
  attachEvidenceHandler,
  correctRelationshipHandler,
  expireRelationshipHandler,
  getRelationshipHandler,
  listRelationshipQueueHandler,
  rejectRelationshipHandler,
  requestEvidenceHandler,
  revokeEvidenceHandler,
  revokeRelationshipHandler,
  verifyRelationshipHandler,
} from '../controllers/relationships-operator.controller.js';
import {
  decideClaimHandler,
  getClaimForOperatorHandler,
  listClaimQueueHandler,
  revokeClaimHandler,
} from '../controllers/merchant-claims-operator.controller.js';
import {
  approveMergeHandler,
  cancelMergeHandler,
  approveSplitHandler,
  claimReviewItemHandler,
  compensateRevisionHandler,
  drainCurationJobsHandler,
  getMergeJobHandler,
  getReviewItemHandler,
  getSplitJobHandler,
  liftSuppressionHandler,
  listMergeJobsHandler,
  listRevisionsHandler,
  listReviewQueueHandler,
  listSplitJobsHandler,
  previewMergeImpactHandler,
  raiseReviewItemHandler,
  reassignIdentifierHandler,
  releaseReviewItemHandler,
  requestMergeHandler,
  requestSplitHandler,
  resolveConflictHandler,
  resolveReviewItemHandler,
  runDetectorsHandler,
  selectAttributeValueHandler,
  suppressEntityHandler,
} from '../controllers/curation-operator.controller.js';
import {
  approveJobSchema,
  compensateRevisionSchema,
  drainCurationSchema,
  liftSuppressionSchema,
  mergePreviewQuerySchema,
  raiseReviewItemSchema,
  reassignIdentifierSchema,
  requestMergeSchema,
  requestSplitSchema,
  resolveConflictSchema,
  resolveReviewItemSchema,
  revisionQuerySchema,
  reviewQueueQuerySchema,
  runDetectorsSchema,
  selectAttributeValueSchema,
  suppressEntitySchema,
} from '../middleware/curation-schemas.js';
import {
  decideLinkageRequestHandler,
  getLinkageRequestForOperatorHandler,
  listLinkageQueueHandler,
  openLinkageCorrectionHandler,
  proposeLinkageCandidateHandler,
  revokeClaimAndUnlinkHandler,
} from '../controllers/store-linkage-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** Create the verified merchant ↔ native store link. */
router.post(
  '/native-store-links',
  validateBody(nativeStoreLinkCreateSchema),
  createNativeStoreLinkHandler,
);

/** Reverse a link. The revoked row remains as the audit record. */
router.post(
  '/native-store-links/:id/revoke',
  validateBody(nativeStoreLinkRevokeSchema),
  revokeNativeStoreLinkHandler,
);

// ── Relationships (#55) ─────────────────────────────────────────────────────
//
// The candidate queue and the five decisions the issue's operator workflow
// names, plus the correction path. `approve` and `verify` are SEPARATE
// endpoints deliberately: an endorsement and a verdict are different acts, and
// collapsing them would make a four-eyes rule that one operator satisfies by
// calling the same endpoint twice.

/** GET — the candidate queue, with evidence summary, approvals and conflicts. */
router.get('/relationships', validateQuery(relationshipQueueQuerySchema), listRelationshipQueueHandler);

/** POST — record a CLAIM. It lands as a candidate whoever asks. */
router.post('/relationships', validateBody(relationshipAssertSchema), assertRelationshipHandler);

/** GET one claim with its evidence, review history and conflicts. */
router.get('/relationships/:id', getRelationshipHandler);

/** POST — attach one durable piece of proof. */
router.post(
  '/relationships/:id/evidence',
  validateBody(relationshipEvidenceSchema),
  attachEvidenceHandler,
);

/** POST — the proof lapses; the relationship and its history do not. */
router.post(
  '/relationships/:id/evidence/:evidenceId/revoke',
  validateBody(relationshipEvidenceRevokeSchema),
  revokeEvidenceHandler,
);

/** POST — one operator's endorsement of the current round (four eyes). */
router.post(
  '/relationships/:id/approve',
  validateBody(relationshipApproveSchema),
  approveRelationshipHandler,
);

/** POST — verify. Evidence gate, then four-eyes gate, then the CAS. */
router.post(
  '/relationships/:id/verify',
  validateBody(relationshipVerifySchema),
  verifyRelationshipHandler,
);

/** POST — refuse the claim. The row stays as the record that it was asked. */
router.post(
  '/relationships/:id/reject',
  validateBody(relationshipReviewSchema),
  rejectRelationshipHandler,
);

/** POST — send it back for more proof. */
router.post(
  '/relationships/:id/request-evidence',
  validateBody(relationshipReviewSchema),
  requestEvidenceHandler,
);

/** POST — time ran out on a claim that was true. */
router.post(
  '/relationships/:id/expire',
  validateBody(relationshipEndSchema),
  expireRelationshipHandler,
);

/** POST — a decision that the claim should no longer stand. */
router.post(
  '/relationships/:id/revoke',
  validateBody(relationshipEndSchema),
  revokeRelationshipHandler,
);

/** POST — close this row and open its corrected successor, in one transaction. */
router.post(
  '/relationships/:id/correct',
  validateBody(relationshipCorrectSchema),
  correctRelationshipHandler,
);
// ── Merchant claim review (#83) ─────────────────────────────────────────────

/** The claims waiting on a person: `review_pending` and `disputed`. */
router.get('/claims', validateQuery(merchantClaimQueueQuerySchema), listClaimQueueHandler);

/** One claim in full, evidence included — and the ACCESS is audited. */
router.get('/claims/:id', getClaimForOperatorHandler);

/** Verify or reject a claim awaiting a decision. */
router.post(
  '/claims/:id/decision',
  validateBody(merchantClaimDecisionSchema),
  decideClaimHandler,
);

/** Withdraw a verification. The merchant returns to `unclaimed`. */
router.post('/claims/:id/revoke', validateBody(merchantClaimRevokeSchema), revokeClaimHandler);

/**
 * Withdraw a verification AND remove the management linkage it authorized
 * (#84, revocation rule 1).
 *
 * A SEPARATE route from `/revoke` rather than a change to it. Revoking a claim
 * without touching linkage stays legitimate — a merchant with no native store
 * has nothing to unlink — and folding the two would make #83's own tests
 * describe something else. The composition lives in the controller because
 * `services/merchant-claims/` may not name `native_store_links` at all; see
 * that file's docblock.
 */
router.post(
  '/claims/:id/revoke-and-unlink',
  validateBody(merchantClaimRevokeSchema),
  revokeClaimAndUnlinkHandler,
);

// ── Merchant → native store linkage (#84) ───────────────────────────────────
//
// Here rather than on a surface of their own for the reason this gate exists:
// deciding which native store a canonical merchant resolves to is the same
// power as deciding who operates that merchant, over the same graph. The
// CLAIMANT half of the flow is `/store-linkage/*`, authenticated but not
// operator-gated — a merchant linking their own shop is not an operator act.

/** The queue: requests awaiting a decision, and those stuck on a conflict. */
router.get('/store-linkage/requests', listLinkageQueueHandler);

/** POST — correct or end a linkage. Returns the stored impact preview. */
router.post(
  '/store-linkage/corrections',
  validateBody(storeLinkageCorrectionSchema),
  openLinkageCorrectionHandler,
);

/** GET one request with its candidates, adoptions and overlap findings. */
router.get('/store-linkage/requests/:id', getLinkageRequestForOperatorHandler);

/** POST — approve (naming the store) or reject a request awaiting review. */
router.post(
  '/store-linkage/requests/:id/decision',
  validateBody(storeLinkageDecisionSchema),
  decideLinkageRequestHandler,
);

/** POST — record a store an operator believes is right, as `operator` evidence. */
router.post(
  '/store-linkage/requests/:id/candidates',
  validateBody(storeLinkageCandidateSchema),
  proposeLinkageCandidateHandler,
);

// ── Catalogue curation (#59) ────────────────────────────────────────────────
//
// The review queue, the two job kinds, the corrections and the timeline. Every
// mutating route below takes a mandatory `reason` (#59 security 2) and writes a
// `catalog_revisions` row; none of them can force a job past a phase, mark a
// conflict applied or supply an impact figure, which is what keeps the merge's
// own gates the only way through.

/** GET — the inbox, with per-kind depth and the age of the oldest open item. */
router.get('/review-items', validateQuery(reviewQueueQuerySchema), listReviewQueueHandler);

/** POST — an operator raising an item by hand; the eighth detector is a person. */
router.post('/review-items', validateBody(raiseReviewItemSchema), raiseReviewItemHandler);

/** POST — run every detector once, bounded. The schedule's own code path. */
router.post('/review-items/scan', validateBody(runDetectorsSchema), runDetectorsHandler);

/** GET — one item plus every prior item ever raised about the same subject. */
router.get('/review-items/:id', getReviewItemHandler);

/** POST — claim it, so two operators do not both start the same merge. */
router.post('/review-items/:id/claim', claimReviewItemHandler);

/** POST — hand it back. Only its own claimant may. */
router.post('/review-items/:id/release', releaseReviewItemHandler);

/** POST — close it. The state is DERIVED from the resolution, never posted. */
router.post(
  '/review-items/:id/resolve',
  validateBody(resolveReviewItemSchema),
  resolveReviewItemHandler,
);

/**
 * GET — what a merge WOULD move (#59 security 2).
 *
 * A read, so an operator who decides not to proceed leaves nothing behind.
 */
router.get('/merge-impact', validateQuery(mergePreviewQuerySchema), previewMergeImpactHandler);

/** GET — every open merge job. */
router.get('/merge-jobs', listMergeJobsHandler);

/** POST — open one. It plans, detects conflicts, and blocks until they are decided. */
router.post('/merge-jobs', validateBody(requestMergeSchema), requestMergeHandler);

/** GET — one job, its conflicts, its phase progress and the revisions it wrote. */
router.get('/merge-jobs/:id', getMergeJobHandler);

/** POST — the SECOND operator's approval. The requester's own is refused. */
router.post('/merge-jobs/:id/approve', validateBody(approveJobSchema), approveMergeHandler);
/**
 * Stop a merge that has moved nothing, freeing the entity for another (#680).
 *
 * It reuses `approveJobSchema` because the input is the same shape — a
 * mandatory reason — and the actor comes off the credential rather than the
 * body, as everywhere else on this surface.
 */
router.post('/merge-jobs/:id/cancel', validateBody(approveJobSchema), cancelMergeHandler);

/** POST — decide ONE conflict. `merge_pair` opens the child job it implies. */
router.post(
  '/merge-jobs/:id/conflicts/:conflictId/resolve',
  validateBody(resolveConflictSchema),
  resolveConflictHandler,
);

/** GET — every open split job. */
router.get('/split-jobs', listSplitJobsHandler);

/** POST — open one, with the assignment list that IS the split (#59 invariant 1). */
router.post('/split-jobs', validateBody(requestSplitSchema), requestSplitHandler);

/** GET — one job, exactly what it moves, and the revisions it wrote. */
router.get('/split-jobs/:id', getSplitJobHandler);

/** POST — the second operator's approval. */
router.post('/split-jobs/:id/approve', validateBody(approveJobSchema), approveSplitHandler);

/** POST — run one batch of jobs now. The dispatcher's own drain. */
router.post('/curation-jobs/drain', validateBody(drainCurationSchema), drainCurationJobsHandler);

/** POST — move an identifier to a different entity, with the collision read first. */
router.post(
  '/identifiers/:id/reassign',
  validateBody(reassignIdentifierSchema),
  reassignIdentifierHandler,
);

/** POST — choose which source value is shown, and PIN the field against re-application. */
router.post(
  '/attribute-values/:id/select',
  validateBody(selectAttributeValueSchema),
  selectAttributeValueHandler,
);

/** POST — hide something from public discovery. Nothing is deleted. */
router.post('/suppressions', validateBody(suppressEntitySchema), suppressEntityHandler);

/** POST — bring it back. Attributable and reasoned, by CHECK. */
router.post('/suppressions/lift', validateBody(liftSuppressionSchema), liftSuppressionHandler);

/** GET — the immutable timeline of one entity (#59 acceptance 4). */
router.get('/revisions', validateQuery(revisionQuerySchema), listRevisionsHandler);

/** POST — record a compensating correction against one revision (action 10). */
router.post(
  '/revisions/:id/compensate',
  validateBody(compensateRevisionSchema),
  compensateRevisionHandler,
);

/**
 * Merchant activation (#85), on this SAME allow-list rather than a seventh.
 *
 * The power is the one this gate already carries: deciding whether a merchant
 * may operate. #83 verifies the claim, #84 joins the merchant to a store, and
 * holding that store's checkout while a risk or moderation question is open is
 * the same decision one step later, over the same graph, by the same people. A
 * seventh list would be a seventh thing to keep in step with this one.
 *
 * The route set is CLOSED and there is deliberately no "activate this store",
 * no "set this capability" and no "mark this requirement satisfied" — every one
 * would be a way to grant a capability the derivation refuses, which is exactly
 * what #85 acceptance 2 asks to be impossible. The one write that is not a hold
 * DRIVES the existing idempotent observation.
 */

/** GET — one store's activation state, its hold detail and its transition trail. */
router.get('/activation/:storeId', validateId('storeId'), getActivationTraceHandler);

/** POST — hold a store's checkout. The reason is mandatory and audited. */
router.post(
  '/activation/:storeId/hold',
  validateId('storeId'),
  validateBody(holdStoreActivationSchema),
  holdActivationHandler,
);

/** DELETE — release it. Attributable, and recorded as its own transition. */
router.delete('/activation/:storeId/hold', validateId('storeId'), releaseActivationHoldHandler);

/** POST — re-derive now and append whatever moved. Adds no way to change anything. */
router.post('/activation/:storeId/observe', validateId('storeId'), observeActivationHandler);

export default router;
