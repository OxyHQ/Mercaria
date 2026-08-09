/**
 * `/internal/product-saves/*` — the product-save operator surface (#80).
 *
 * The `/internal/commerce-graph` shape, on the SAME allow-list
 * (`CATALOG_OPERATOR_OXY_USER_IDS`) #54, #55, #56, #57, #58, #59, #83, #90 and
 * #94 use. A product save points at a canonical product, its counter is a
 * canonical rollup, and its migration reads the canonical attachments #58
 * wrote: who may reshape the catalogue and who may repair what the catalogue's
 * saves add up to are the same power over the same graph, and a SIXTH list
 * beside payments, catalog, guest, analytics and retail would be a sixth thing
 * to keep in step for no separation it does not already have.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files. Full reasoning:
 * `routes/internal-payments.ts` and `middleware/catalog-operator-authz.ts`.
 *
 * Deliberately NOT here: any read that names who saved something. The trace
 * opens from a canonical product id and returns counts; the ONE route that
 * names a person is the erasure, which needs the subject by definition and
 * returns two numbers.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  counterDriftQuerySchema,
  eraseSubjectSchema,
  rebuildCountersSchema,
  runMigrationSchema,
} from '../middleware/product-save-schemas.js';
import {
  counterDriftHandler,
  eraseSubjectSavesHandler,
  rebuildCountersHandler,
  runMigrationHandler,
  traceProductSavesHandler,
} from '../controllers/product-saves-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — which counters disagree with the rows they are derived from. */
router.get('/counters/drift', validateQuery(counterDriftQuerySchema), counterDriftHandler);

/** POST — re-derive one product's counter, one listing's, or a bounded page. */
router.post('/counters/rebuild', validateBody(rebuildCountersSchema), rebuildCountersHandler);

/** POST — run one page of the favorite→product-save migration. */
router.post('/migrations', validateBody(runMigrationSchema), runMigrationHandler);

/** GET — one product's save counts. Never who saved it. */
router.get(
  '/trace/:canonicalProductId',
  validateId('canonicalProductId'),
  traceProductSavesHandler,
);

/** DELETE — erase one Oxy account's product saves (#80 privacy rule 5). */
router.delete(
  '/subjects/:oxyUserId',
  validateId('oxyUserId'),
  validateBody(eraseSubjectSchema),
  eraseSubjectSavesHandler,
);

export default router;
