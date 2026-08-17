/**
 * `/internal/catalog-proposals/*` — the operator review surface (#367 step 6,
 * ADR 0007 D9).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54, #55, #56, #57,
 * #58, #59, #60, #62, #68, #70, #78, #79, #80, #83, #90 and #94 use, and NOT a
 * seventh list. A proposal asks for a category, a product type, a brand or a
 * controlled value: who may reshape that catalogue and who may decide a request
 * to reshape it are the same power over the same graph.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 *
 * It is deliberately NOT gated on `CATALOG_PROPOSALS_ENABLED`. The
 * `/internal/product-saves` arrangement, for its reason: the evidence has to be
 * readable during the incident that turned the merchant surface off, and
 * "what did we approve last week" is exactly the question somebody asks after
 * pulling the lever.
 *
 * ## The route set is CLOSED, and the omissions are the design
 *
 * Two reads and seven writes, and every write is one of ADR 0007 D9's own six
 * operator actions plus the idempotent backfill they drive. There is deliberately
 * NO "set this proposal approved", no "attach this entity id", no "clear this
 * decision", no "edit this label" and no delete. Each would be a way to make the
 * record say something other than what happened — and `catalog_review_events` is
 * append-only against UPDATE and DELETE precisely so that the record cannot be
 * quietly corrected afterwards.
 *
 * ## And it cannot be asked what one merchant has been proposing
 *
 * Every write is keyed on a PROPOSAL id and the trace opens from one. The queue
 * read accepts a `storeId` FILTER, which is a different thing from a handle: it
 * narrows a list an operator can already page through, and there is no route that
 * takes a merchant, a submitter account or a label.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  approveCatalogProposalSchema,
  backfillCatalogProposalSchema,
  deferCatalogProposalSchema,
  listCatalogProposalQueueSchema,
  mergeCatalogProposalSchema,
  redirectCatalogProposalSchema,
  rejectCatalogProposalSchema,
  requestCatalogProposalInformationSchema,
} from '../middleware/catalog-proposal-schemas.js';
import {
  approveCatalogProposalHandler,
  backfillCatalogProposalHandler,
  catalogProposalQueueHandler,
  catalogProposalTraceHandler,
  deferCatalogProposalHandler,
  mergeCatalogProposalHandler,
  redirectCatalogProposalHandler,
  rejectCatalogProposalHandler,
  requestCatalogProposalInformationHandler,
} from '../controllers/catalog-proposals-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — the review queue, filtered by state, type or store. */
router.get('/', validateQuery(listCatalogProposalQueueSchema), catalogProposalQueueHandler);

/** GET — one proposal, its scan evidence, its references and its whole timeline. */
router.get('/:proposalId', validateId('proposalId'), catalogProposalTraceHandler);

/** POST — approve, minting the concept. The `key` is the operator's (ADR 0007 D1). */
router.post(
  '/:proposalId/approve',
  validateId('proposalId'),
  validateBody(approveCatalogProposalSchema),
  approveCatalogProposalHandler,
);

/** POST — merge into an entity that already exists. */
router.post(
  '/:proposalId/merge',
  validateId('proposalId'),
  validateBody(mergeCatalogProposalSchema),
  mergeCatalogProposalHandler,
);

/** POST — refuse it. Terminal; another attempt is a NEW proposal. */
router.post(
  '/:proposalId/reject',
  validateId('proposalId'),
  validateBody(rejectCatalogProposalSchema),
  rejectCatalogProposalHandler,
);

/** POST — ask the submitter for more. */
router.post(
  '/:proposalId/request-information',
  validateId('proposalId'),
  validateBody(requestCatalogProposalInformationSchema),
  requestCatalogProposalInformationHandler,
);

/** POST — put it down until a date. Still an OPEN state; a draft still waits. */
router.post(
  '/:proposalId/defer',
  validateId('proposalId'),
  validateBody(deferCatalogProposalSchema),
  deferCatalogProposalHandler,
);

/** POST — it is really a different TYPE; mint the continuation and point at it. */
router.post(
  '/:proposalId/redirect',
  validateId('proposalId'),
  validateBody(redirectCatalogProposalSchema),
  redirectCatalogProposalHandler,
);

/** POST — re-run one page of the idempotent backfill an approval owes. */
router.post(
  '/:proposalId/backfill',
  validateId('proposalId'),
  validateBody(backfillCatalogProposalSchema),
  backfillCatalogProposalHandler,
);

export default router;
