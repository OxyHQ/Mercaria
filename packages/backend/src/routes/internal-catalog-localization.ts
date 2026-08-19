/**
 * `/internal/catalog-localization` — the translation desk (#367 merge-order
 * step 10).
 *
 * ## The same allow-list, not a seventh
 *
 * `CATALOG_OPERATOR_OXY_USER_IDS`, which every ADR 0007 catalog surface already
 * uses. Reading how much of the catalogue is translated is not a different power
 * from publishing a taxonomy change or reviewing a translation — and the review
 * decision this desk feeds already lives behind exactly this list at
 * `/internal/catalog-governance/reviews/localization`. A separate list would
 * have to be granted to the same people, drift from it, and become the one
 * somebody forgets when an operator leaves. Empty list ⇒ **not mounted** (404,
 * never 401), gated in `app.ts` on `config.catalog.graphOperatorSurfaceEnabled`.
 *
 * ## Why a separate router from `/internal/catalog-metrics`
 *
 * That surface answers "is the catalogue healthy" in metric shape — every figure
 * a `measured`/`unmeasured` cell against a definition registry, deliberately
 * uniform so a dashboard can render them all the same way, and its route set is
 * asserted EXACTLY from both sides so a fifth route there is a build failure by
 * design. This one answers "what should a translator do next", which is a
 * different payload for a different reader: per (domain, locale) rows carrying
 * their own denominators, coverage census and staleness caveats, plus a review
 * comparison that is not a metric at all.
 *
 * The two do not duplicate a query. `tallyLocalizationStatuses` counts
 * localization ROWS by status with no denominator; this desk counts the ENTITY
 * population that is owed a translation, which is the figure that makes a
 * coverage ratio mean anything and which no row tally can produce.
 *
 * ## The route set is CLOSED and READ-ONLY
 *
 * Three GETs. There is deliberately no route that:
 *
 * - **settles a translation.** `POST /internal/catalog-governance/reviews/localization`
 *   owns that decision, behind this same gate and narrowed further by the
 *   `translate` role grant, and it writes the audit trail. A second route to one
 *   decision is how two surfaces come to disagree about what it meant.
 * - **requests a machine translation**, which would be a write to a family whose
 *   CHECKs and trigger exist to keep machine text out of `reviewed`/`approved`.
 * - **recomputes or caches a report.** Nothing is stored: the schema records
 *   `localization_coverage_runs` as deliberately absent because coverage is a
 *   query, so there is no run to trigger and nothing to invalidate.
 * - **marks a translation stale.** Staleness is a consequence of a source
 *   change — two triggers and one copy-forward — and a route that could assert
 *   it by hand would be a fourth mechanism disagreeing with the three.
 *
 * `catalog-localization-desk.test.ts` enumerates the registered paths off this
 * router's own stack and asserts them EXACTLY, so a fourth route is a decision
 * somebody makes on purpose.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateId, validateQuery } from '../middleware/validate.js';
import {
  localizationCompletenessQuerySchema,
  localizationReviewQuerySchema,
} from '../middleware/catalog-localization-schemas.js';
import {
  localizationAlertsHandler,
  localizationCompletenessHandler,
  localizationReviewHandler,
} from '../controllers/catalog-localization.controller.js';

const router = Router();

// Order is load-bearing: the operator gate needs a verified caller.
//
// NO rate limiter, matching every sibling on this allow-list
// (`/internal/catalog-governance`, `/internal/catalog-metrics`,
// `/internal/matching`, `/internal/search`). The bound is the allow-list itself
// — a handful of named Oxy accounts — so a per-IP bucket would be one bucket for
// the whole operator team and would trip exactly when several of them are
// reading the desk at once, which is what a translation push looks like.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/**
 * Completeness for every covered domain against every locale in scope.
 *
 * `?scope=launch` (the default) or `all`. The payload carries its own coverage
 * census and the per-domain staleness caveats, so a consumer cannot render the
 * figures without the two things that make them readable.
 */
router.get(
  '/completeness',
  validateQuery(localizationCompletenessQuerySchema),
  localizationCompletenessHandler,
);

/**
 * The launch-locale gaps, with the count of pairs actually examined.
 *
 * No query parameters at all: the locale set is `LAUNCH_LOCALES` by
 * construction. `evaluatedPairs` is in the payload because an empty `alerts`
 * array from a run that examined nothing is byte-identical to one from a run
 * that examined everything and found nothing wrong.
 */
router.get('/alerts', localizationAlertsHandler);

/**
 * One entity's source beside its target, in one locale.
 *
 * `?locale=` is the strict `SUPPORTED_LOCALES` enum and `:entityId` is shape
 * checked, both before any read. `:domain` is checked against the three-member
 * closed set in the HANDLER rather than by a middleware, because `validate.ts`
 * exports no params validator and adding a one-use generic helper to shared
 * middleware three other lanes are editing is the worse trade — the check still
 * runs before the read, which is the property that matters.
 *
 * A malformed request is therefore a 400 rather than an empty comparison that
 * reads as "nothing translated". It opens from an entity id and nothing else:
 * "every category this translator touched" is unaskable rather than refused.
 */
router.get(
  '/review/:domain/:entityId',
  validateId('entityId'),
  validateQuery(localizationReviewQuerySchema),
  localizationReviewHandler,
);

export default router;
