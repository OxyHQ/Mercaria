/**
 * `/catalog-proposals` — the merchant proposal surface (#367 step 6,
 * ADR 0007 D9/D10).
 *
 * Mounted at that exact path because ADR 0007 D10 finalizes
 * `POST /catalog-proposals` in its route list, and NOT under
 * `/stores/:storeId/…`. The store is therefore named in the body (or the query
 * for a read), which leaves a question the path would have answered: how does
 * the store authorization run.
 *
 * ## The answer is `loadStore`, not a second authorization path
 *
 * `storeScopeFrom` copies the caller's declared store id into `req.params` and
 * then delegates to the SAME `loadStore` → `requireStorePermission` chain every
 * store-scoped route uses. There is deliberately no second membership lookup and
 * no hand-rolled permission comparison here: two places deciding who may act for
 * a store is exactly the divergence `store-authz.ts` exists to prevent, and the
 * one that would diverge is the newer one.
 *
 * `products:write` is the permission, the SAME one the authoring drafts use, and
 * for the reason `routes/product-drafts.ts` states: `store_members_permissions_check`
 * renders the tuple, so an unlisted permission string is a refusal at the row —
 * and a merchant proposing a missing colour is doing exactly what that permission
 * names.
 *
 * ## The rate limiter is `admin`, and the durable axes are in Postgres
 *
 * A proposal is submitted from the authoring form, behind a store permission, on
 * the same rails a draft PATCH runs on — so it shares that budget rather than
 * taking a scope of its own. What actually bounds proposal farming is DURABLE and
 * per store: "how many has this store asked for today, across every ECS task" is
 * not a question a per-IP bucket can answer, and it is the axis an abusive
 * integration cannot escape by changing address (#83's ruling, with the two axes
 * this domain needs).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { loadStore, requireStorePermission } from '../middleware/store-authz.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  listCatalogProposalsQuerySchema,
  previewCatalogProposalDuplicatesSchema,
  refuseForbiddenSubmitterFields,
  submitCatalogProposalSchema,
  supplyCatalogProposalInformationSchema,
  withdrawCatalogProposalSchema,
} from '../middleware/catalog-proposal-schemas.js';
import {
  getCatalogProposalHandler,
  listCatalogProposalsHandler,
  previewCatalogProposalDuplicatesHandler,
  submitCatalogProposalHandler,
  supplyCatalogProposalInformationHandler,
  withdrawCatalogProposalHandler,
} from '../controllers/catalog-proposals.controller.js';

const router = Router();

router.use(makeRateLimiter('admin'), authenticateToken);

/**
 * Put the caller's declared store id where `loadStore` reads it.
 *
 * The schema has already validated its SHAPE, so this only moves a value —
 * `loadStore` still answers 404 for a store that does not exist and 403 for a
 * caller who is not a member, exactly as it does when the id came from a path.
 */
function storeScopeFrom(source: 'body' | 'query') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const container = source === 'body' ? req.body : req.query;
    const storeId = (container as { storeId?: unknown } | undefined)?.storeId;
    if (typeof storeId === 'string') req.params.storeId = storeId;
    next();
  };
}

/**
 * POST — the pre-submission duplicate scan (ADR 0007 D9). Stores nothing.
 *
 * A POST rather than a GET because the label is a body field and a label in a
 * query string is a label in an access log. It is the SAME scan the submission
 * runs, so what a merchant was shown and what the submission decided on cannot be
 * two different measurements.
 */
router.post(
  '/duplicates',
  validateBody(previewCatalogProposalDuplicatesSchema),
  storeScopeFrom('body'),
  loadStore,
  requireStorePermission('products:write'),
  previewCatalogProposalDuplicatesHandler,
);

/** POST — submit, or converge on the open request that already covers it. */
router.post(
  '/',
  // The forbidden-field refusal runs BEFORE the schema, so a body carrying `key`
  // is told what the rule is rather than "unrecognized key" — which reads as a
  // typo and sends an integrator looking for the right spelling of a field that
  // must never exist (#121's `forbidden-evidence` device).
  refuseForbiddenSubmitterFields,
  validateBody(submitCatalogProposalSchema),
  storeScopeFrom('body'),
  loadStore,
  requireStorePermission('products:write'),
  submitCatalogProposalHandler,
);

/** GET — this store's own proposals. */
router.get(
  '/',
  validateQuery(listCatalogProposalsQuerySchema),
  storeScopeFrom('query'),
  loadStore,
  requireStorePermission('products:write'),
  listCatalogProposalsHandler,
);

/** GET — one of them. Another store's answers 404, never 403. */
router.get(
  '/:proposalId',
  validateQuery(listCatalogProposalsQuerySchema.pick({ storeId: true })),
  storeScopeFrom('query'),
  loadStore,
  requireStorePermission('products:write'),
  getCatalogProposalHandler,
);

/** POST — close one's own request without spending an operator decision on it. */
router.post(
  '/:proposalId/withdraw',
  validateBody(withdrawCatalogProposalSchema),
  storeScopeFrom('body'),
  loadStore,
  requireStorePermission('products:write'),
  withdrawCatalogProposalHandler,
);

/** POST — answer a reviewer's question; puts the row back in the queue. */
router.post(
  '/:proposalId/information',
  validateBody(supplyCatalogProposalInformationSchema),
  storeScopeFrom('body'),
  loadStore,
  requireStorePermission('products:write'),
  supplyCatalogProposalInformationHandler,
);

export default router;
