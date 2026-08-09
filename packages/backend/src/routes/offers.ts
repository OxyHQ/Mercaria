/**
 * Offers API (#57) — PUBLIC reads of the unified offer model.
 *
 * What a thing costs, where, from whom, and how current that is. Native and
 * external offers come back through the SAME shape (issue acceptance 2 wants
 * them unambiguously distinguishable, not separately served): `kind` says which
 * it is, `checkout.eligible` says whether Mercaria can sell it, and
 * `destinationUrl` is where an external one lives. A caller never has to guess
 * from the presence of a field.
 *
 * No auth: an offer is public commercial information with no viewer-specific
 * hydration. Rate-limited under the `'listings'` scope, the closest read-path
 * budget — the `merchants` and `canonical-products` precedent.
 *
 * There is deliberately NO write route. External offers arrive through an
 * in-process ingestion call (#62) that already holds a verified `source_records`
 * row, and native offers are a projection of a listing nobody submits
 * separately — a public write surface here would be a way to publish a price
 * nobody observed.
 *
 * The outbound REDIRECT for an external offer is #37's and is not here: this
 * router models the routing metadata and never performs the routing, which is
 * what keeps the original destination the only URL Mercaria stores.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { offerListQuerySchema } from '../middleware/offer-schemas.js';
import { getOfferHandler, listOffersHandler } from '../controllers/offers.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /offers — the comparison read, cheapest first. Exactly one scope. */
router.get('/', validateQuery(offerListQuerySchema), listOffersHandler);

/** GET /offers/:id — one offer in full. */
router.get('/:id', getOfferHandler);

export default router;
