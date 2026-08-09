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
 * Only LINKAGE lives here today. Merge/split/correction endpoints arrive with
 * #59's tooling and its `catalog_revisions` audit ledger (ADR 0002 D16) —
 * this router gains them then, behind this same gate.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  nativeStoreLinkCreateSchema,
  nativeStoreLinkRevokeSchema,
} from '../middleware/commerce-graph-schemas.js';
import {
  createNativeStoreLinkHandler,
  revokeNativeStoreLinkHandler,
} from '../controllers/commerce-graph-operator.controller.js';

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

export default router;
