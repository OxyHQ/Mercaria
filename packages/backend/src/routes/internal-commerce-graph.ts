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
 * LINKAGE (#54), the RELATIONSHIP review workflow (#55) and merchant-claim
 * REVIEW (#83) all live here. Merge and split endpoints arrive with #59's
 * tooling and its `catalog_revisions` audit ledger (ADR 0002 D16) — this router
 * gains them then, behind this same gate. The relationship CORRECTION path is
 * #55's own and already here: it needs no revisions table, because a correction
 * is a new row linked to the one it replaces rather than an edit anything has
 * to record the before-state of.
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
import { validateBody, validateQuery } from '../middleware/validate.js';
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

export default router;
