/**
 * Canonical products API (#56) — PUBLIC reads over the canonical product layer.
 *
 * Catalogue IDENTITY only: what a thing is, which configurations exist, what
 * identifies them. No price, no stock, no seller — those are the listing's and
 * the offer's (#57), and a read surface that mixed them would be the first place
 * canonical identity started to look like inventory.
 *
 * No writes: products are minted by ingestion (#62), the backfill (#60) and the
 * operator surface under `/internal/canonical-catalog`. No auth: everything
 * served is public catalogue identity with no viewer-specific hydration.
 * Rate-limited under the `'listings'` scope, the closest read-path budget (the
 * `merchants` precedent).
 *
 * Route ORDER is load-bearing: `/lookup` must precede `/:idOrSlug`, or the
 * parameter route swallows it.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { canonicalProductLookupQuerySchema } from '../middleware/canonical-catalog-schemas.js';
import {
  getCanonicalProduct,
  listCanonicalProductVariants,
  lookupCanonicalProducts,
} from '../controllers/canonical-products.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/**
 * GET /canonical-products/lookup — exactly one criterion.
 *
 * `scheme`+`identifier` is the deterministic path; `alias` is the fuzzy one and
 * answers `ambiguous` rather than picking; `sourceId`+`externalId` is how a
 * marketplace id or a merchant's own product id resolves WITHOUT any of them
 * being a global identifier (ADR 0002 D14).
 */
router.get('/lookup', validateQuery(canonicalProductLookupQuerySchema), lookupCanonicalProducts);

/** GET /canonical-products/:idOrSlug — public projection; merge tombstones redirect. */
router.get('/:idOrSlug', getCanonicalProduct);

/** GET /canonical-products/:idOrSlug/variants — the configurations that exist. */
router.get('/:idOrSlug/variants', listCanonicalProductVariants);

export default router;
