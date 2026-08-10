/**
 * `GET /search` — canonical multi-entity product discovery (#70).
 *
 * Public and unauthenticated: everything served is catalogue identity plus
 * commercial facts already published on `GET /offers`, with no viewer-specific
 * hydration. Rate-limited under the `'listings'` scope, the closest read-path
 * budget and the one `/canonical-products`, `/offers` and `/merchants` share.
 *
 * The router is MOUNTED unconditionally and the ROLLOUT LEVER lives in the
 * handler, unlike every other canonical surface — see
 * `controllers/search.controller.ts` for why (`shadow` has to compute an answer
 * a middleware would have refused before the handler ran). The observable
 * behaviour is the same 404 either way.
 *
 * There is deliberately NO write route and no suggestion/autocomplete route.
 * Autocomplete is a different latency budget and a different privacy posture —
 * it emits a query event per KEYSTROKE — and #77's retention rules were written
 * for submitted searches. It belongs to its own issue with its own numbers.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { searchQuerySchema } from '../middleware/search-schemas.js';
import { canonicalSearchHandler } from '../controllers/search.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

router.get('/', validateQuery(searchQuerySchema), canonicalSearchHandler);

export default router;
