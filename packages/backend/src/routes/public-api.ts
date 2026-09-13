import { Router, type NextFunction, type Request, type Response } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { ErrorCodes, sendError } from '../utils/api-response.js';
import { log } from '../lib/logger.js';
import {
  getCollection,
  getProduct,
  getStore,
  listCollectionProducts,
  listStoreCollections,
  listStoreProducts,
  lookupStore,
  searchProducts,
} from '../controllers/public-api.controller.js';

/**
 * The PUBLIC integration surface (#1017), mounted at
 * `MERCARIA_PUBLIC_API_BASE_PATH` (`/public/v1`) — the routes
 * `@mercaria.co/sdk` calls and nothing else. `docs/public-api.md` is the
 * reference; the wire shapes are `@mercaria/shared-types` `public-api.ts`.
 *
 * GET only. `optionalAuth` attaches a verified Oxy caller when a bearer token is
 * presented (a token that does not verify is read as anonymous), which is what
 * lets `viewer.saved` forward the calling application's own authority. The CORS
 * policy for this prefix is `lib/allowed-origins.ts`'s `isPublicReadCorsRequest`.
 *
 * `/stores/lookup` is registered BEFORE `/stores/:id`, or `lookup` would be read
 * as a store id and answer 404.
 */
const router = Router();

router.use(makeRateLimiter('public-api'), optionalAuth, (_req, res, next) => {
  // `viewer` depends on the bearer token, so a shared cache must key on it.
  res.vary('Authorization');
  next();
});

router.get('/products', searchProducts);
router.get('/products/:id', getProduct);
router.get('/stores/lookup', lookupStore);
router.get('/stores/:id', getStore);
router.get('/stores/:id/products', listStoreProducts);
router.get('/stores/:id/collections', listStoreCollections);
router.get('/collections/:id', getCollection);
router.get('/collections/:id/products', listCollectionProducts);

/**
 * Anything else under the prefix — an unknown path, or a known path with a
 * method other than GET/HEAD — is a JSON `UNKNOWN_ROUTE` 404, never Express's
 * HTML 404 page, because the contract promises a consumer an envelope on every
 * answer. Never `NOT_FOUND`: a route mismatch must not read as a missing entity.
 */
router.use((_req: Request, res: Response) => {
  sendError(res, ErrorCodes.UNKNOWN_ROUTE, 'No such public API route', 404);
});

/**
 * The path-scoped error handler `app.ts` mounts directly behind this router.
 *
 * Every handler catches its own errors, so what reaches this is an error raised
 * ABOVE the router on this prefix — `express.json()` refusing a malformed body
 * sent with a GET, or a middleware throwing. A body-parser refusal carries a 4xx
 * `status` and is the caller's mistake; anything else is `INTERNAL_ERROR` with a
 * generic message.
 */
export function publicApiErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
      ? err.status
      : 500;
  if (status >= 400 && status < 500) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'The request could not be read', 400);
    return;
  }
  log.general.error({ err, path: req.path }, '[public-api] unhandled error');
  sendError(res, ErrorCodes.INTERNAL_ERROR, 'Something went wrong', 500);
}

export default router;
