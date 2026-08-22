/**
 * `/navigation` — the published navigation trees a storefront renders
 * (#367 step 7, ADR 0007 D3).
 *
 * ## Anonymous, and it has to be
 *
 * A menu is the first thing a shopper sees and it is the same menu for everybody
 * in one `(market, locale)`. There is no `optionalAuth` here because there is
 * nothing an account could change about the answer — which is also what makes
 * the ETag worth having, since a payload that varied per caller could not be
 * validated across them.
 *
 * ## ONE route, and no write route may be added
 *
 * The operator surface that authors these trees is `/internal/navigation`
 * (`routes/internal-navigation.ts`), on the `CATALOG_OPERATOR_OXY_USER_IDS`
 * allow-list and mounted while this router's rollout lever is OFF — the evidence
 * has to be readable during the incident that turned the public surface off.
 * Two routers rather than one because they are gated by different things for
 * different reasons.
 *
 * There is deliberately no route here that writes a category, a collection, a
 * brand or a family. Each has a surface that owns it, and a second way to reach
 * one from navigation would be a second authority over somebody else's rules —
 * which is ADR 0007 D3's whole point about navigation not being taxonomy.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { catalogRolloutGate } from '../middleware/catalog-rollout.js';
import { validateQuery } from '../middleware/validate.js';
import { navigationQuerySchema } from '../middleware/navigation-schemas.js';
import { navigationReadHandler } from '../controllers/navigation.controller.js';

const router = Router();

// The `'listings'` budget, which the catalogue reads share: this is those reads'
// arrangement, and a menu request accompanies them rather than replacing them.
router.use(makeRateLimiter('listings'));
/**
 * `CATALOG_ROLLOUT_COHORTS` (ADR 0007 D12) — the market/locale half of the epic's
 * staged rollout, which is the stage this surface is actually the subject of.
 *
 * `market` and `locale` are BOTH required by `navigationQuerySchema`, so this
 * surface can always answer those two dimensions and can never answer the other
 * three. With a store-scoped or product-type-scoped cohort configured it is
 * therefore outside the rollout and answers 404 — the same 404 its lever gives,
 * which the storefront already falls back from. That is the documented cost of
 * the fail-closed rule and the reason D12's stages are CUMULATIVE.
 */
router.use(catalogRolloutGate());

/** GET /navigation — every tree live for one market and locale. */
router.get('/', validateQuery(navigationQuerySchema), navigationReadHandler);

export default router;
