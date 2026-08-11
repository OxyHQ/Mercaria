/**
 * Mercaria-retail offer presentation (#129) — the PUBLIC read of what a page
 * may say about a price Mercaria composes itself.
 *
 * This closes #120's named seam. `docs/retail-pricing.md` assigns #129
 * *"`presentation` + `blockReasons` on every quote"*, and until now those two
 * columns had no reader outside checkout and the operator surface — so a
 * shopper could reach a Mercaria-sold item and be shown the LISTING's own
 * price, which is not what checkout would charge and not a figure the pricing
 * domain ever certified.
 *
 * It reads a stored quote and never composes one. Composing calls a supplier,
 * and a public route that did so would spend a provider call per page view,
 * drain #122's per-supplier lease on people who are not buying, and hand anyone
 * with a URL a way to exhaust it. When there is no current quote the answer is
 * `unquoted`, which says Mercaria is not currently able to state a price —
 * different from blocked, and very different from free.
 *
 * No auth: a price and its disclosures are public commercial information with
 * no viewer-specific hydration, and the destination is a COUNTRY rather than an
 * address (#122 stores no address on a quote either). Rate-limited under the
 * `'listings'` read budget, the `offers` precedent.
 *
 * There is deliberately no write route, no "price this for me" and no quantity
 * parameter: each would be a way to make Mercaria talk to a supplier from an
 * unauthenticated request.
 */

import { Router } from 'express';
import { z } from 'zod';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { sendSuccess } from '../utils/api-response.js';
import { readRetailOfferPresentation } from '../services/commercial-presentation/retail-offer.service.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/**
 * `.strict()`, so no unrecognised parameter is silently accepted.
 *
 * `country` is ISO-3166-1 alpha-2 and nothing finer. A region would narrow the
 * quote lookup without changing what may be claimed, and a postal code is the
 * one piece of the destination #122 deliberately never stores.
 */
const retailOfferQuerySchema = z
  .object({
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'country must be an ISO-3166-1 alpha-2 code')
      .optional(),
  })
  .strict();

/** GET /retail-offers/:canonicalVariantId — what a page may say about the price. */
router.get(
  '/:canonicalVariantId',
  validateQuery(retailOfferQuerySchema),
  async (req, res, next) => {
    try {
      const country = typeof req.query.country === 'string' ? req.query.country : undefined;
      const presentation = await readRetailOfferPresentation({
        canonicalVariantId: String(req.params.canonicalVariantId),
        ...(country ? { destinationCountry: country } : {}),
      });
      sendSuccess(res, presentation);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
