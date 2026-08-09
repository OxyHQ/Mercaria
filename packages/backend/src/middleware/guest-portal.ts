/**
 * The portal credential's transport and resolution (#108, ADR 0003 D9/D10).
 *
 * Deliberately a SECOND resolver beside `middleware/commerce-actor.ts` rather
 * than a branch inside it. ADR 0003 D3 makes scope structural — "`mgs_` tokens
 * resolve only in the commerce-session resolver; portal tokens only in the
 * portal resolver; the two tables share nothing" — and two functions with two
 * anchored token patterns is what that sentence means mechanically. A cart
 * credential presented here fails its shape gate before any hashing; a portal
 * credential presented to the cart resolver does the same. Invariant I3 is
 * therefore a property of the call graph, not of a `WHERE` clause.
 *
 * Everything else is `commerce-actor.ts`'s decisions, reused verbatim because
 * they were argued once and a second answer could only disagree: the cookie
 * profile and its explicit dev downgrade, the header-first read, the answer-in-
 * kind rule, and the Origin check against `lib/allowed-origins.ts` — the ONE
 * origin authority CORS already reads.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config/index.js';
import { isAllowedBrowserOrigin } from '../lib/allowed-origins.js';
import { log } from '../lib/logger.js';
import type { GuestOrderAccessGrantRow } from '../db/guestPortal/grantRepository.js';
import { resolvePortalGrant } from '../services/guest-portal/grant.service.js';
import { readGuestCookie } from './commerce-actor.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';

/** The native carriage for the portal credential, both directions. */
export const PORTAL_TOKEN_HEADER = 'x-mercaria-portal-token';

/** Declares header transport on the exchange; absent means cookie. */
export const PORTAL_TRANSPORT_HEADER = 'x-mercaria-portal-transport';

/** How a portal credential reached (or should leave) a request. */
export type PortalTransport = 'cookie' | 'header';

declare global {
  namespace Express {
    interface Request {
      /** The LIVE portal grant this request presented, if it presented one. */
      portalGrant?: GuestOrderAccessGrantRow;
      /** Which carriage it arrived in — decides how a rotation answers (D9). */
      portalTransport?: PortalTransport;
    }
  }
}

/**
 * The portal cookie profile, decided per environment EXPLICITLY.
 *
 * Production: `__Host-mercaria_portal` — `HttpOnly; Secure; SameSite=Lax;
 * Path=/`, no `Domain`. The `__Host-` prefix forbids one, so a sibling
 * subdomain can never plant or shadow it (ADR 0003 T1).
 *
 * Development: `mercaria_portal_dev` WITHOUT `Secure`, because a browser
 * refuses a `Secure`/`__Host-` cookie over `http://localhost` and dev would
 * silently have no portal sessions at all. A DIFFERENT NAME and a log line at
 * first use, so the downgrade is explicit and cannot leak into production by
 * being the same cookie with a weaker flag.
 *
 * `SameSite=Lax` rather than `Strict`, matching the guest session: the portal
 * is reached by clicking a link in an email client, and `Strict` would drop the
 * cookie on exactly that navigation — the one every recovery flow ends with.
 */
export function portalCookieProfile(): {
  name: string;
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    maxAge: number;
  };
} {
  const production = process.env.NODE_ENV === 'production';
  return {
    name: production ? '__Host-mercaria_portal' : 'mercaria_portal_dev',
    options: {
      httpOnly: true,
      secure: production,
      path: '/',
      sameSite: 'lax',
      // The cookie may outlive the GRANT; the resolver answers uniformly for a
      // dead one, so a stale cookie is inert. Capping at the grant window keeps
      // the jar honest rather than leaving a permanent artefact in a browser.
      maxAge: config.guest.portal.grantDays * 24 * 60 * 60 * 1_000,
    },
  };
}

let devProfileLogged = false;

function activeCookieProfile(): ReturnType<typeof portalCookieProfile> {
  const profile = portalCookieProfile();
  if (!profile.options.secure && !devProfileLogged) {
    devProfileLogged = true;
    log.guest.info(
      { cookieName: profile.name },
      '[GuestPortal] development cookie profile in use (no Secure attribute, non-__Host name). ' +
        'Production uses __Host-mercaria_portal with Secure — an explicit dev-only downgrade.',
    );
  }
  return profile;
}

/** First value of a possibly-repeated request header, trimmed; else undefined. */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** The presented portal credential, header first, else cookie (D9). */
function presentedPortalCredential(
  req: Request,
): { token: string; transport: PortalTransport } | undefined {
  const headerToken = headerValue(req, PORTAL_TOKEN_HEADER);
  if (headerToken !== undefined) return { token: headerToken, transport: 'header' };
  const cookieToken = readGuestCookie(req.headers.cookie, portalCookieProfile().name);
  if (cookieToken !== undefined) return { token: cookieToken, transport: 'cookie' };
  return undefined;
}

/** The request's browser origin: `Origin`, else the `Referer` URL's origin (D10). */
function requestBrowserOrigin(req: Request): string | undefined {
  const origin = headerValue(req, 'origin');
  if (origin !== undefined) return origin;
  const referer = headerValue(req, 'referer');
  if (referer === undefined) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    // An unparseable Referer identifies no origin — the same as absent, which
    // the caller refuses for cookie writes.
    return undefined;
  }
}

/** Methods that change state — the set the D10 CSRF gate covers. */
function isStateChanging(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * The D10 refusal, for the portal's cookie carriage.
 *
 * Applied to every cookie-authenticated state change AND to the EXCHANGE, which
 * sets a cookie: a write that establishes a credential is as CSRF-relevant as
 * one authenticated by it. Header transport is untouched — a custom header
 * forces a CORS preflight, which the existing allowlist already refuses
 * cross-site.
 */
export function passesPortalCookieCsrf(req: Request, res: Response): boolean {
  const origin = requestBrowserOrigin(req);
  if (isAllowedBrowserOrigin(origin)) return true;
  log.guest.warn(
    { origin: origin ?? null, path: req.path, method: req.method },
    '[GuestPortal] cookie-authenticated write refused: Origin/Referer not allow-listed (CSRF)',
  );
  sendError(
    res,
    ErrorCodes.FORBIDDEN,
    'Cookie-authenticated portal writes require an allow-listed Origin',
    403,
  );
  return false;
}

/**
 * Attach the freshly minted credential to the response, in kind (D9).
 *
 * The token NEVER enters a response body on either transport, on any path.
 */
export function setPortalCredential(
  res: Response,
  token: string,
  transport: PortalTransport,
): void {
  if (transport === 'header') {
    res.setHeader(PORTAL_TOKEN_HEADER, token);
    return;
  }
  const profile = activeCookieProfile();
  res.cookie(profile.name, token, profile.options);
}

/** Clear the credential on sign-out. Header transport has nothing to clear. */
export function clearPortalCredential(res: Response, transport: PortalTransport): void {
  if (transport === 'header') return;
  const profile = activeCookieProfile();
  res.clearCookie(profile.name, {
    httpOnly: profile.options.httpOnly,
    secure: profile.options.secure,
    sameSite: profile.options.sameSite,
    path: profile.options.path,
  });
}

/** Which transport a client asked for on the exchange; absent means cookie. */
export function declaredPortalTransport(req: Request): PortalTransport {
  return headerValue(req, PORTAL_TRANSPORT_HEADER) === 'header' ? 'header' : 'cookie';
}

/**
 * Resolve a presented portal credential, if any. NEVER refuses on its own.
 *
 * Attaching-or-not rather than 401ing is what lets one router serve both the
 * unauthenticated exchange and the authenticated reads: the handlers that need
 * a credential say so with {@link requirePortalSession}, and the ones that do
 * not are not forced to opt out of a gate.
 *
 * The CSRF check runs BEFORE resolution for cookie-carried state changes, so a
 * cross-site write never reaches the database.
 */
export const resolvePortalSession: RequestHandler = (req, res, next) => {
  void resolve(req, res, next).catch((error: unknown) => next(error));
};

async function resolve(req: Request, res: Response, next: NextFunction): Promise<void> {
  const presented = presentedPortalCredential(req);
  if (!presented) {
    next();
    return;
  }

  if (
    presented.transport === 'cookie' &&
    isStateChanging(req.method) &&
    !passesPortalCookieCsrf(req, res)
  ) {
    return;
  }

  const grant = await resolvePortalGrant(presented.token, new Date());
  if (grant !== null) {
    req.portalGrant = grant;
    req.portalTransport = presented.transport;
  }
  next();
}

/**
 * Refuse a request that presented no LIVE portal credential.
 *
 * The 401 is UNIFORM across absent, malformed, expired, consumed and revoked —
 * the body never says which (#108 magic-link rule 8). The distinction exists
 * only in the security log, which carries grant row ids and never a token.
 */
export const requirePortalSession: RequestHandler = (req, res, next) => {
  if (req.portalGrant === undefined) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Portal access is not valid', 401);
    return;
  }
  next();
};
