/**
 * `/internal/navigation/*` — the navigation domain's operator surface
 * (#367 step 7, ADR 0007 D3).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#56/#57/#58/
 * #60/#62/#68/#70/#78 use, and deliberately not an eighth list: deciding what
 * the front page points at is the same power over the same graph as reshaping
 * the catalogue it points into, and a new list would be another thing to keep in
 * step for a separation it does not have.
 *
 * ## Mounted while `CATALOG_TAXONOMY_V2_ENABLED` is OFF, deliberately
 *
 * The `/internal/backfill` / `/internal/ebay` / `/internal/offer-freshness`
 * arrangement, and the reason is specific rather than a convention: the evidence
 * has to be readable during the incident that turned the lever off, and the one
 * moment somebody most needs to preview a navigation tree is right after
 * switching the public surface off. A gate on the rollout lever would make that
 * exact moment the one where preview 404s.
 *
 * The public read is a SEPARATE router (`routes/navigation.ts`) mounted at
 * `/navigation` behind that lever. Two routers rather than one, because they are
 * gated by different things for different reasons — which is precisely what the
 * first draft of this branch got wrong.
 *
 * ## The route set is CLOSED
 *
 * Seven routes, and there is deliberately no eighth: no "activate this
 * category", no "publish this collection", no "reorder the taxonomy", no
 * "set this node's rank". Every one of those is a second authority over
 * somebody else's rules — the category tree's, merchandising's or #74's — and
 * ADR 0007 D3's whole point is that navigation is none of them.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  createNavigationSavedQueryBodySchema,
  createNavigationTreeBodySchema,
  navigationPreviewQuerySchema,
  publishNavigationTreeBodySchema,
  replaceNavigationNodesBodySchema,
} from '../middleware/navigation-schemas.js';
import {
  archiveNavigationTreeHandler,
  createNavigationSavedQueryHandler,
  createNavigationTreeHandler,
  deleteNavigationTreeHandler,
  navigationPreviewHandler,
  publishNavigationTreeHandler,
  replaceNavigationNodesHandler,
} from '../controllers/navigation.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — what publishing this tree would produce, plus what it withholds. */
router.get(
  '/preview/:treeId',
  validateId('treeId'),
  validateQuery(navigationPreviewQuerySchema),
  navigationPreviewHandler,
);

/** POST — the next DRAFT version of a tree key. */
router.post('/trees', validateBody(createNavigationTreeBodySchema), createNavigationTreeHandler);

/** PUT — the whole node set of a draft, replaced in one transaction. */
router.put(
  '/trees/:treeId/nodes',
  validateId('treeId'),
  validateBody(replaceNavigationNodesBodySchema),
  replaceNavigationNodesHandler,
);

/** POST — publish a draft over a window. */
router.post(
  '/trees/:treeId/publish',
  validateId('treeId'),
  validateBody(publishNavigationTreeBodySchema),
  publishNavigationTreeHandler,
);

/** POST — stop a published tree being live. It stays readable. */
router.post('/trees/:treeId/archive', validateId('treeId'), archiveNavigationTreeHandler);

/** DELETE — a draft nobody published. Never a published or archived one. */
router.delete('/trees/:treeId', validateId('treeId'), deleteNavigationTreeHandler);

/** POST — a curated search a node can point at. */
router.post(
  '/saved-queries',
  validateBody(createNavigationSavedQueryBodySchema),
  createNavigationSavedQueryHandler,
);

export default router;
