/**
 * Mercaria's HTTP authentication surface — three exports, all composed from
 * `@oxyhq/core/server`, and NOTHING locally implemented (#164).
 *
 * There is deliberately no Mercaria service principal, no shared-secret bearer
 * path, no local scope check and no synthetic user. What used to be here was
 * `authenticateTokenOrApiKey`: a constant-time compare against `SERVICE_SECRET`
 * that, on a match, set `req.userId = 'system'` and a `serviceApp` naming an
 * application id (`internal`) no Oxy Console grant could describe. It had ZERO
 * mounted routes — every `/internal/*` router runs `authenticateToken` plus one
 * of the six operator allow-lists — so it authorized nothing that anybody could
 * reach; it was one `router.use(...)` away from authorizing everything, outside
 * grant audit, with rotation and revocation local to a deployment.
 *
 * Beside it stood `authenticateTelegramBot`, which was worse and had no Telegram
 * integration behind it: it compared a second shared secret and then took the
 * acting user's id from a REQUEST HEADER (`x-oxy-user-id`), so possession of one
 * environment variable impersonated any Oxy account. Also unmounted. Also gone.
 *
 * How a real Oxy-to-Oxy service caller is authenticated when one arrives (#156,
 * #158): mount `oxyClient.serviceAuth(...)` from `@oxyhq/core` on the route that
 * needs it, against a credential issued to a registered Application, and read
 * the principal off the SDK's own `OxyAuthRequest`. There is deliberately no
 * pre-exported, unmounted service-auth middleware sitting here for somebody to
 * reach for — an auth primitive with no route is a primitive nothing exercises.
 *
 * A provider webhook is NOT this. Stripe, Shopify, WooCommerce, CrowdSource and
 * supplier callbacks each verify their own signature on their own raw-body
 * mount, and none of them may be satisfied by an Oxy credential (or the reverse)
 * merely because it arrives as a bearer-shaped string.
 *
 * `__tests__/service-auth-retirement.test.ts` fails the build if any of it
 * returns.
 */

import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyRequestUser,
} from '@oxyhq/core/server';

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

/**
 * Whether the SDK's per-request auth tracing is on.
 *
 * It was hardcoded `true`. The SDK never logs a token — it logs `token: <bool>`
 * — but it does emit a line per request carrying the resolved user id and
 * session id, which in production is a session identifier in the log stream for
 * every authenticated call, for nobody's benefit. Following the environment is
 * what #164 asks for; it is not a kill switch, so there is no variable.
 */
const AUTH_DEBUG = process.env.NODE_ENV !== 'production';

// Extend Express Request with what the Oxy middlewares populate.
//
// Only the USER-principal fields are declared. `apiKey` (a scope bag nothing
// ever wrote), `serviceApp` (written only by the deleted secret path, and
// already declared by the SDK's own `OxyAuthRequest` for code that mounts real
// service auth) and `workspace` (never read or written anywhere) were all
// removed with #164: a global augmentation is what makes a field reachable off a
// plain `Request`, so declaring one nothing populates is how `req.serviceApp`
// reads as a principal a route may trust.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
    }
  }
}

/**
 * Oxy authentication middleware (official @oxyhq/core/server)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, {
  auth: { debug: AUTH_DEBUG },
});

/**
 * Optional auth — attaches the Oxy user when a token verifies, and continues
 * without one otherwise.
 *
 * Measured against the SDK rather than assumed: `createOptionalOxyAuth` passes
 * `optional: true`, and on that path a token that fails to decode OR fails
 * session validation sets `userId`/`user` to `null` and calls `next()`. So this
 * middleware DOES downgrade a bad credential to anonymous. The stricter rule —
 * ADR 0003 D2's "a presented `Bearer` that did not verify is a 401, never a
 * downgrade" — is `resolveCommerceActor`'s own, applied after this runs by
 * re-reading the `Authorization` header. Do not restate it here; a route that
 * needs it mounts that middleware.
 */
const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, { auth: { debug: AUTH_DEBUG } });

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Uses @oxyhq/core/server optional auth — attaches user if valid, continues if not.
  oxyOptionalAuth(req, res, next);
}
