/**
 * `/internal/merchant-demand/*` — the operator acquisition pipeline (#86).
 *
 * ## On the ANALYTICS allow-list, and deliberately not a seventh
 *
 * `ANALYTICS_OPERATOR_OXY_USER_IDS` already grants the broadest reading power in
 * this codebase — "what is demand doing across the marketplace" — and this
 * surface is that power applied to one merchant at a time plus a workflow for
 * doing something about it. A seventh list would be a second answer to who holds
 * it, and the vetting conversation would be the same conversation twice.
 *
 * Empty means the router is NOT MOUNTED: 404, never a 401 that would advertise
 * the surface. The gate is repeated in middleware because the mount and the gate
 * live in different files, which is exactly the pair that drifts.
 *
 * ## Mounted while the merchant surfaces are OFF
 *
 * `MERCHANT_DEMAND_ENABLED` and `MERCHANT_DEMAND_PREVIEW_ENABLED` gate the
 * merchant-facing routers and never this one. The evidence has to be readable
 * during the incident that turned them off — the rule every operator surface in
 * this codebase follows.
 *
 * ## The write set is CLOSED and there is no send
 *
 * Eight writes, each `MERCHANT_ACQUISITION_ACTIONS` names, each driving an
 * idempotent path, each audited on both outcomes. There is no "set this merchant
 * claimed" (a verdict #83 owns), no "set this score" (a function of evidence),
 * no delete and — #86 acquisition 8 — no send of any kind.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireAnalyticsOperator } from '../middleware/analytics-operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  acquisitionAssignSchema,
  acquisitionContactSourceSchema,
  acquisitionDoNotContactSchema,
  acquisitionExcludeSchema,
  acquisitionListQuerySchema,
  acquisitionNextActionSchema,
  acquisitionOutreachSchema,
  acquisitionRescoreSchema,
} from '../middleware/merchant-demand-schemas.js';
import {
  acquisitionHealthHandler,
  addContactSourceHandler,
  assignCandidateHandler,
  candidateSnapshotsHandler,
  clearExclusionHandler,
  excludeCandidateHandler,
  getCandidateHandler,
  getOutreachContextHandler,
  listCandidatesHandler,
  recordOutreachHandler,
  rescoreCandidateHandler,
  setDoNotContactHandler,
  setNextActionHandler,
} from '../controllers/merchant-acquisition.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireAnalyticsOperator);

/** The pipeline's own health: what is waiting on a seam, and who is where. */
router.get('/health', acquisitionHealthHandler);

/** One page of the pipeline, highest score first. */
router.get('/candidates', validateQuery(acquisitionListQuerySchema), listCandidatesHandler);

/** One candidate, with its derived conversion stage and its whole trail. */
router.get('/candidates/:merchantId', getCandidateHandler);

/** How many snapshots this merchant has, live and superseded. */
router.get('/candidates/:merchantId/snapshots', candidateSnapshotsHandler);

/** The generated, reviewable outreach context. Evidence, never a message. */
router.get('/candidates/:merchantId/outreach-context', getOutreachContextHandler);

/** Rebuild the snapshot and re-run the pure scorer against it. */
router.post(
  '/candidates/:merchantId/rescore',
  validateBody(acquisitionRescoreSchema),
  rescoreCandidateHandler,
);

/** Assign, or clear an assignment. */
router.post(
  '/candidates/:merchantId/assign',
  validateBody(acquisitionAssignSchema),
  assignCandidateHandler,
);

/** Set the next action and move the pipeline state with it. */
router.post(
  '/candidates/:merchantId/next-action',
  validateBody(acquisitionNextActionSchema),
  setNextActionHandler,
);

/** Exclude a candidate, attributably. */
router.post(
  '/candidates/:merchantId/exclude',
  validateBody(acquisitionExcludeSchema),
  excludeCandidateHandler,
);

/** Lift an exclusion. Refused while do-not-contact is set. */
router.delete('/candidates/:merchantId/exclude', clearExclusionHandler);

/** Record or withdraw a do-not-contact request. */
router.post(
  '/candidates/:merchantId/do-not-contact',
  validateBody(acquisitionDoNotContactSchema),
  setDoNotContactHandler,
);

/** Record WHERE a public business contact is published. Never the contact. */
router.post(
  '/candidates/:merchantId/contact-sources',
  validateBody(acquisitionContactSourceSchema),
  addContactSourceHandler,
);

/** Record one outreach attempt AFTER a person made it. Nothing here sends. */
router.post(
  '/candidates/:merchantId/outreach',
  validateBody(acquisitionOutreachSchema),
  recordOutreachHandler,
);

export default router;
