/**
 * `/facets` — the public facet, filter and sort-option surface
 * (#367 Workstream 10).
 *
 * No auth: everything served is public catalogue metadata plus counts over
 * public catalogue rows, with no viewer-specific hydration — the
 * `/catalog-attributes` precedent, which is the same kind of read one layer
 * down. Rate-limited under the `'listings'` scope, the read-path budget those
 * surfaces share.
 *
 * ONE route. There is deliberately no `/facets/:categoryId` convenience form and
 * no operator surface: a facet rail is a projection over rows other domains own,
 * every one of which already has an operator surface behind its own allow-list,
 * and a seventh gate for a read that publishes nothing new would be a gate for
 * its own sake.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { facetRequestSchema } from '../middleware/facet-schemas.js';
import { facetsHandler } from '../controllers/facets.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** The rail: which facets exist for a scope, what they answer, and what is left. */
router.post('/', validateBody(facetRequestSchema), facetsHandler);

export default router;
