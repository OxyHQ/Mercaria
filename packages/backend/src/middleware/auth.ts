/**
 * Mercaria's HTTP authentication surface — three exports, all composed from
 * `@oxy.so/core/server`, and NOTHING locally implemented (#164).
 *
 * There is deliberately no Mercaria service principal, no shared-secret bearer
 * path, no local scope check and no synthetic user. What used to be here was
 * `authenticateTokenOrApiKey`: a constant-time compare against `SERVICE_SECRET`
 * that, on a match, set `req.userId = 'system'` and a `serviceApp` naming an
 * application id (`internal`) no Oxy Console grant could describe. It had ZERO
 * mounted routes — every `/internal/*` router runs `authenticateToken` plus one
 * of the `*_OPERATOR_OXY_USER_IDS` allow-lists — so it authorized nothing that
 * anybody could reach; it was one `router.use(...)` away from authorizing
 * everything, outside grant audit, with rotation and revocation local to a
 * deployment.
 *
 * Beside it stood `authenticateTelegramBot`, which was worse and had no Telegram
 * integration behind it: it compared a second shared secret and then took the
 * acting user's id from a REQUEST HEADER (`x-oxy-user-id`), so possession of one
 * environment variable impersonated any Oxy account. Also unmounted. Also gone.
 *
 * How a real Oxy-to-Oxy service caller is authenticated when one arrives (#156,
 * #158): mount `oxyClient.middleware.service(...)` from `@oxy.so/core/server` on the route that
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

import type { Request, Response, NextFunction } from 'express';
import { MERCARIA_SERVICE_AUDIENCE } from '../config/oxy-identity.js';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  OxyServer,
  type OxyRequestUser,
} from '@oxy.so/core/server';

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServer({
  baseURL: OXY_API_URL,
  workloadCredentials: createAwsWorkloadCredentialProvider(),
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
 * Oxy authentication middleware (official @oxy.so/core/server)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, {
  auth: { debug: AUTH_DEBUG, expectedAudience: MERCARIA_SERVICE_AUDIENCE },
});

/** Anonymous public reads stay available. A supplied bearer must verify:
 * malformed/expired credentials are 401, explicit policy denial is 403, and an
 * authority outage is 503. All of those decisions remain inside the Oxy SDK.
 */
const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, {
  auth: {
    debug: AUTH_DEBUG,
    strictOptionalBearer: true,
    expectedAudience: MERCARIA_SERVICE_AUDIENCE,
  },
});

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  // Authenticated policy denials must never be reused by a shared public cache.
  res.vary('Authorization');
  // Only a request without a credential may continue anonymously.
  oxyOptionalAuth(req, res, next);
}
