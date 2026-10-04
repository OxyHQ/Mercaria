import { Router, type Request, type Response } from 'express';
import { MERCARIA_PUBLIC_ROUTES, expressRoutePath } from '@mercaria/contracts';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { publicApiRoute, sendPublicError } from '../controllers/public-api.controller.js';

/**
 * The PUBLIC integration surface (#1017), mounted at
 * `MERCARIA_PUBLIC_API_BASE_PATH` (`/public/v1`) — the routes
 * `@mercaria.co/sdk` calls and nothing else. `docs/public-api.md` is the
 * reference; the contract, the route table and the OpenAPI document are
 * `@mercaria/contracts`.
 *
 * The route table is NOT spelled here: every entry of `MERCARIA_PUBLIC_ROUTES`
 * is mounted, in registry order, against the controller's handler for its
 * `operationId` — so the routes served and the routes documented cannot differ.
 * Registry order is what puts `/stores/lookup` before `/stores/:id`.
 *
 * GET only. `optionalAuth` attaches a verified Oxy caller when a bearer token is
 * presented (a token that does not verify is read as anonymous), which is what
 * lets `viewer.saved` forward the calling application's own authority. The CORS
 * policy for this prefix is `lib/allowed-origins.ts`'s `isPublicReadCorsRequest`.
 */
const router = Router();

router.use(makeRateLimiter('public-api'), optionalAuth, (_req, res, next) => {
  // `viewer` depends on the bearer token, so a shared cache must key on it.
  res.vary('Authorization');
  next();
});

for (const route of MERCARIA_PUBLIC_ROUTES) {
  router[route.method](expressRoutePath(route.path), publicApiRoute(route));
}

/**
 * Anything else under the prefix — an unknown path, or a known path with a
 * method other than GET/HEAD — is a JSON `unknown_route` 404, never Express's
 * HTML 404 page. Never `not_found`: a route mismatch must not read as a missing
 * entity. An error raised ABOVE the router (a malformed body sent with a GET)
 * is answered by `app.ts`'s global handler, in the same contract shape.
 */
router.use((_req: Request, res: Response) => {
  sendPublicError(res, 'unknown_route', 'No such public API route');
});

export default router;
