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

import { Router, type Request } from 'express';
import type { CatalogRolloutSubject } from '@mercaria/shared-types';
import { makeRateLimiter } from '../lib/rate-limit.js';
import {
  catalogRolloutGate,
  catalogRolloutSubjectFromRequest,
} from '../middleware/catalog-rollout.js';
import { validateBody } from '../middleware/validate.js';
import { facetRequestSchema } from '../middleware/facet-schemas.js';
import { facetsHandler } from '../controllers/facets.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));
/**
 * `CATALOG_ROLLOUT_COHORTS` (ADR 0007 D12) — the category/locale half of the
 * epic's staged rollout.
 *
 * A custom subject, because a facet request nests its category one level down
 * (`{scope: {kind: 'category', categoryId}}`) and the default extractor reads
 * top-level fields only. Reading it here rather than teaching the default
 * extractor to walk nested objects is deliberate: an extractor that hunted for a
 * `categoryId` anywhere in a body would pick one out of a `selection` entry on
 * some future surface, and the cohort a request is judged against would then
 * depend on a field nobody thought of as identity.
 *
 * The `canonical_products` scope names no category, so under a category cohort
 * it is outside the rollout — correct, since a canonical-product facet request
 * spans whatever categories those products sit in and this domain cannot say
 * which without a read it is walled off from making.
 */
router.use(
  catalogRolloutGate((req: Request): CatalogRolloutSubject => {
    const base = catalogRolloutSubjectFromRequest(req);
    const scope: unknown = (req.body as { scope?: unknown } | undefined)?.scope;
    const categoryId =
      typeof scope === 'object' && scope !== null
        ? (scope as { categoryId?: unknown }).categoryId
        : undefined;
    return {
      ...base,
      categoryId: typeof categoryId === 'string' ? categoryId : base.categoryId,
    };
  }),
);

/** The rail: which facets exist for a scope, what they answer, and what is left. */
router.post('/', validateBody(facetRequestSchema), facetsHandler);

export default router;
