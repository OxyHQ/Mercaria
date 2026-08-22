/**
 * `/taxonomy/*` — the PUBLIC taxonomy read surface (#367 Workstream 1,
 * ADR 0007 D1/D2/D13).
 *
 * ## What this closes
 *
 * `db/taxonomy/taxonomyRepository.ts` has shipped `findRootCategories`,
 * `findChildCategories`, `findCategoryAncestors`, `findCategoryDescendants` and
 * `findCategoryBreadcrumb` since #367 step 1, and `docs/taxonomy.md` closed with
 * *"Any HTTP surface. This step is schema, repository and gates only."* A census
 * over that module's callers finds scripts, the governance snapshot, the ancestry
 * benchmark and tests, and NO file under `controllers/` — while the same census
 * over `db/catalog/categoryRepository.ts` finds two, which is the positive control
 * that makes the absence a measurement. Five tested reads with no caller.
 *
 * ## Anonymous, and it has to be
 *
 * A category tree is the same tree for everybody: there is no account, store or
 * market dimension anywhere in `categories` or `category_localizations`. That is
 * what lets the responses carry `Cache-Control: public` with one validator valid
 * across callers — `/navigation`'s arrangement and its reasoning, one domain over.
 *
 * `/catalog-authoring/categories` is NOT this and must not be folded into it: that
 * read is a SELLER's picker, filtered to `selectable` nodes, behind
 * `authenticateToken`, and it composes a permission projection. This read serves
 * the taxonomy — structural nodes included, with `selectable` stated as a fact
 * rather than applied as a filter.
 *
 * ## Behind `CATALOG_TAXONOMY_V2_ENABLED`, which is the lever this IS
 *
 * `config/index.ts` describes that lever as *"The extended taxonomy READS"*
 * (ADR 0007 D12) and until now it gated only `/navigation`. Default FALSE, so
 * today's behaviour is unchanged and `GET /categories` — the v1 tree, D13 — keeps
 * answering exactly as it does. It gates the MOUNT and never a stored row: every
 * category, alias, redirect and localization stays readable with it off, because a
 * rollback must not delete catalog evidence.
 *
 * ## Route ORDER is load-bearing
 *
 * `/roots`, `/search` and `/by-key/:key` are literals and MUST precede
 * `/:categoryId`, or the parameter route swallows all three. `catalog-attributes.ts`
 * carries the same warning for the same reason.
 *
 * Identity is TWO routes rather than one `:idOrKey`. `generatedId()` mints a uuid
 * v7, whose lowercase-hex-and-hyphen spelling also satisfies `CATEGORY_KEY_PATTERN`
 * — so a single route would have to guess, and a guess that resolves an id as a key
 * (or the reverse) answers with a different category rather than failing.
 *
 * ## No write route may be added here
 *
 * A taxonomy change is planned, approved and applied through
 * `/internal/catalog-governance/changes`, on the `CATALOG_OPERATOR_OXY_USER_IDS`
 * allow-list, where it gets an impact estimate, four eyes and an audit row. A
 * second way to move a category would be a second authority over the one table
 * whose write chokepoint has a build-failing gate
 * (`db/__tests__/taxonomy-write-chokepoint.test.ts`).
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { catalogRolloutGate } from '../middleware/catalog-rollout.js';
import { validateId, validateQuery } from '../middleware/validate.js';
import {
  taxonomyCategoryQuerySchema,
  taxonomyChildrenQuerySchema,
  taxonomyDescendantsQuerySchema,
  taxonomyEligibilityQuerySchema,
  taxonomyRootsQuerySchema,
  taxonomySearchQuerySchema,
  taxonomyTrailQuerySchema,
} from '../middleware/taxonomy-schemas.js';
import {
  taxonomyAncestorsHandler,
  taxonomyBreadcrumbHandler,
  taxonomyCategoryByKeyHandler,
  taxonomyCategoryHandler,
  taxonomyChildrenHandler,
  taxonomyDescendantsHandler,
  taxonomyEligibilityHandler,
  taxonomyRootsHandler,
  taxonomySearchHandler,
} from '../controllers/taxonomy.controller.js';

const router = Router();

// The `'listings'` budget, deliberately shared rather than a new scope. These are
// catalogue reads on the same rails `/categories`, `/catalog-attributes`,
// `/navigation` and `/product-types` already run on, and a scope exists to stop
// one surface exhausting another's — which is an argument for separating a surface
// that CALLS a provider, not one that runs two indexed selects.
router.use(makeRateLimiter('listings'));
/**
 * `CATALOG_ROLLOUT_COHORTS` (ADR 0007 D12) — the same lever's other public mount,
 * narrowed the same way `/navigation` is.
 *
 * `locale` is the one dimension this surface can answer, and `category` is
 * deliberately NOT read out of `:categoryId` even though six of the nine routes
 * below carry one.
 * A cohort gate is a MOUNT-shaped decision — it admits or refuses a whole
 * request — and a tree read's ANSWER spans categories the cohort does not name:
 * admitting `/categories/c1/children` because `c1` is in the cohort would then
 * return children that are not, and refusing `/categories/roots` because it
 * names no category at all would withdraw the tree while pretending to narrow
 * it. Filtering a tree by cohort is a different feature from staging one, and
 * this domain must not grow the first while implementing the second.
 *
 * So under a category-, store- or product-type-scoped cohort this surface is
 * outside the rollout and answers 404 — its lever's answer, at the cohort grain,
 * which is exactly what D12's cumulative stages mean.
 */
router.use(catalogRolloutGate());

/** GET — the top-level categories. Literal, so it precedes `/:categoryId`. */
router.get('/categories/roots', validateQuery(taxonomyRootsQuerySchema), taxonomyRootsHandler);

/** GET — localized name search and autocomplete. Literal. */
router.get('/categories/search', validateQuery(taxonomySearchQuerySchema), taxonomySearchHandler);

/** GET — one category by its stable machine key (ADR 0007 D1). Literal prefix. */
router.get(
  '/categories/by-key/:key',
  validateQuery(taxonomyCategoryQuerySchema),
  taxonomyCategoryByKeyHandler,
);

/** GET — one category by id. */
router.get(
  '/categories/:categoryId',
  validateId('categoryId'),
  validateQuery(taxonomyCategoryQuerySchema),
  taxonomyCategoryHandler,
);

/** GET — its direct children, in sibling order. */
router.get(
  '/categories/:categoryId/children',
  validateId('categoryId'),
  validateQuery(taxonomyChildrenQuerySchema),
  taxonomyChildrenHandler,
);

/** GET — every browsable category beneath it, at any depth. Keyset-paged. */
router.get(
  '/categories/:categoryId/descendants',
  validateId('categoryId'),
  validateQuery(taxonomyDescendantsQuerySchema),
  taxonomyDescendantsHandler,
);

/** GET — its ancestors, root-first, excluding itself. */
router.get(
  '/categories/:categoryId/ancestors',
  validateId('categoryId'),
  validateQuery(taxonomyTrailQuerySchema),
  taxonomyAncestorsHandler,
);

/** GET — the trail: its ancestors root-first, then itself. */
router.get(
  '/categories/:categoryId/breadcrumb',
  validateId('categoryId'),
  validateQuery(taxonomyTrailQuerySchema),
  taxonomyBreadcrumbHandler,
);

/** GET — may a product be filed here, and what may be authored. */
router.get(
  '/categories/:categoryId/eligibility',
  validateId('categoryId'),
  validateQuery(taxonomyEligibilityQuerySchema),
  taxonomyEligibilityHandler,
);

export default router;
