/**
 * The `CommerceActor` resolver — ONE middleware that turns a request's
 * credentials into exactly one actor (ADR 0003 D1/D2/D9/D10, #103).
 *
 * Composition, not reimplementation: Oxy auth is the existing
 * `createOptionalOxyAuth` instance from `middleware/auth.ts`, run first;
 * this module adds only the guest credential's transport, validation and the
 * precedence between the two. It is consumed by the guest session routes
 * today and by cart/checkout when #104 lands (M7) — services receive
 * `req.commerceActor` and never parse a credential themselves.
 *
 * ## Precedence (D2) — binding
 *
 *  - **Oxy wins.** A verified Oxy user is the actor; a valid guest credential
 *    beside it is surfaced only as `presentedGuestSessionId` and is otherwise
 *    inert (its session is neither touched nor rotated).
 *  - **A failed Oxy credential is a 401, never a downgrade.** A `Bearer`
 *    header that did not verify must not fall through to the guest cookie —
 *    a silently expired Oxy session degrading to a guest actor would split
 *    one person across two carts with no visible error.
 *  - **An invalid guest credential resolves as if absent** — anonymous, or
 *    plain Oxy. Expiry and revocation are normal, not errors; the request is
 *    marked `guestCredential: 'invalid'` so surfaces that must distinguish
 *    "no actor" from "invalid credential" (the inspect endpoint) can.
 *
 * ## Transports (D9)
 *
 * ONE opaque token, two carriages. The header `X-Mercaria-Guest-Token` is
 * read FIRST, else the cookie; from there the path is identical. Responses
 * answer in kind: `Set-Cookie` for cookie transport, the same header name
 * for header transport. A client declares header transport on the issuing
 * write with `X-Mercaria-Guest-Transport: header`; absent means cookie.
 *
 * ## CSRF (D10)
 *
 * Strict Origin verification against the ONE origin authority the CORS layer
 * already reads (`lib/allowed-origins.ts`), applied to every state-changing
 * request that is guest-COOKIE-authenticated (and to cookie-transport
 * issuance, which SETS one): `Origin`, else `Referer`'s origin, must be
 * allow-listed; neither header present is a refusal. Header transport is
 * untouched — a custom header forces a CORS preflight, which the existing
 * allowlist already refuses cross-site. `SameSite=Lax` is defence in depth,
 * not the control.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getOxyUserId } from '@oxyhq/core/server';
import type { GuestClientClass } from '@mercaria/shared-types';
import { GUEST_CLIENT_CLASSES } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { isAllowedBrowserOrigin } from '../lib/allowed-origins.js';
import { log } from '../lib/logger.js';
import type { CommerceActor } from '../services/commerce-actor.js';
import {
  issueGuestSession,
  resolveGuestSessionByToken,
  rotateGuestSession,
  rotationDue,
  type ResolvedGuestSession,
} from '../services/guest-session.service.js';
import { optionalAuth } from './auth.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';

/** The one documented native/header carriage for the token, both directions (D9). */
export const GUEST_TOKEN_HEADER = 'x-mercaria-guest-token';

/** Declares header transport on the issuing write; absent means cookie (D9). */
export const GUEST_TRANSPORT_HEADER = 'x-mercaria-guest-transport';

/**
 * OPTIONAL issuance-time client-class declaration (`web | ios | android |
 * other`), an audit dimension only — never authorization, never a binding.
 * Undeclared defaults: cookie transport is `web`, header transport `other`.
 */
export const GUEST_CLIENT_HEADER = 'x-mercaria-guest-client';

/** How the guest credential (if any) reached this request. */
export type GuestTransport = 'cookie' | 'header';

/** Whether a guest credential was presented, and whether it resolved (D2). */
export type GuestCredentialState = 'absent' | 'invalid' | 'valid';

/** What the resolver leaves for route handlers, beside `req.commerceActor`. */
export interface GuestSessionRequestContext {
  resolved: ResolvedGuestSession;
  transport: GuestTransport;
  /**
   * The middleware already rotated this session on the 7-day cadence and
   * answered in kind — the explicit rotate handler must not rotate again on
   * top (its CAS would fail against the fresh hash anyway).
   */
  rotatedInFlight: boolean;
}

declare global {
  namespace Express {
    interface Request {
      /** The resolved actor — exactly one per request (ADR 0003 D1). */
      commerceActor?: CommerceActor;
      /** Distinguishes no-credential from invalid-credential (D2). */
      guestCredential?: GuestCredentialState;
      /** Present iff a guest credential RESOLVED (valid) on this request. */
      guestSessionContext?: GuestSessionRequestContext;
    }
  }
}

/**
 * The web cookie profile (D9), decided per environment EXPLICITLY.
 *
 * Production: `__Host-mercaria_guest` — `HttpOnly; Secure; SameSite=Lax;
 * Path=/`, no `Domain` (the `__Host-` prefix forbids one, so a sibling
 * subdomain can never plant or shadow the cookie — T1).
 *
 * Development: `mercaria_guest_dev` without `Secure`, because a browser
 * refuses a `Secure`/`__Host-` cookie over `http://localhost` and dev would
 * silently have no guest sessions at all. The downgrade is a DIFFERENT NAME
 * and is logged once at first use — dev works without silently weakening
 * production defaults (#103 web transport rule 5).
 */
export function guestCookieProfile(): {
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
    name: production ? '__Host-mercaria_guest' : 'mercaria_guest_dev',
    options: {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      // `__Host-` requires Path=/ and no Domain; dev mirrors it exactly.
      path: '/',
      // The cookie may outlive the SESSION (idle expiry strikes first); the
      // resolver answers uniformly for a dead session, so a stale cookie is
      // inert, and capping at the absolute window keeps the jar honest.
      maxAge: config.guest.sessionAbsoluteDays * 24 * 60 * 60 * 1_000,
    },
  };
}

let devProfileLogged = false;

function activeCookieProfile(): ReturnType<typeof guestCookieProfile> {
  const profile = guestCookieProfile();
  if (!profile.options.secure && !devProfileLogged) {
    devProfileLogged = true;
    log.guest.info(
      { cookieName: profile.name },
      '[Guest] development cookie profile in use (no Secure attribute, non-__Host name). ' +
        'Production uses __Host-mercaria_guest with Secure — this is an explicit dev-only downgrade.',
    );
  }
  return profile;
}

/**
 * Read the guest cookie's raw value from the `Cookie` header.
 *
 * Scoped on purpose: no global cookie-parser joins the middleware chain (the
 * raw-body webhook mounts stay exactly as they are), and this server only
 * ever reads THIS one cookie, whose value it minted itself from a base64url
 * alphabet — so a targeted scan of the header is the entire requirement.
 * Values another site's server quoted or encoded differently simply fail the
 * well-formedness check downstream, which is the correct uniform answer.
 */
export function readGuestCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined || cookieHeader.length === 0) return undefined;
  // Bound the work on adversarial input before any parsing (issue #103,
  // "reject oversized … before expensive work"): a legitimate jar carrying
  // our ~50-char cookie fits comfortably; 8 KiB is Node's default header cap.
  if (cookieHeader.length > 8_192) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // RFC 6265 permits optional double quotes around a cookie-value.
    return raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
      ? raw.slice(1, -1)
      : raw;
  }
  return undefined;
}

/** First value of a possibly-repeated request header, trimmed; else undefined. */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
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
    // An unparseable Referer identifies no origin — same as absent, which the
    // caller refuses for cookie writes; nothing to log at request volume.
    return undefined;
  }
}

/** Methods that change state — the set the D10 CSRF gate covers. */
function isStateChanging(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * The D10 refusal: a cookie-carried guest credential on a state-changing
 * request must present an allow-listed browser origin. Returns `true` when
 * the request may proceed.
 */
function passesCookieCsrf(req: Request, res: Response): boolean {
  const origin = requestBrowserOrigin(req);
  if (isAllowedBrowserOrigin(origin)) return true;
  log.guest.warn(
    { origin: origin ?? null, path: req.path, method: req.method },
    '[Guest] cookie-authenticated write refused: Origin/Referer not allow-listed (CSRF)',
  );
  sendError(
    res,
    ErrorCodes.FORBIDDEN,
    'Cookie-authenticated guest writes require an allow-listed Origin',
    403,
  );
  return false;
}

/** Declared client class, allow-listed; else the transport's default. */
function declaredClientClass(req: Request, transport: GuestTransport): GuestClientClass {
  const declared = headerValue(req, GUEST_CLIENT_HEADER);
  if (declared !== undefined && (GUEST_CLIENT_CLASSES as readonly string[]).includes(declared)) {
    return declared as GuestClientClass;
  }
  return transport === 'cookie' ? 'web' : 'other';
}

/**
 * Attach the freshly issued (or rotated) credential to the response, in kind
 * (D9): `Set-Cookie` for cookie transport, the response header for header
 * transport. The token NEVER enters a response body on either transport.
 */
export function setGuestCredential(res: Response, token: string, transport: GuestTransport): void {
  if (transport === 'header') {
    res.setHeader(GUEST_TOKEN_HEADER, token);
    return;
  }
  const profile = activeCookieProfile();
  res.cookie(profile.name, token, profile.options);
}

/**
 * Clear the credential on revocation/conversion (#103 web transport rule 6).
 * Header transport has nothing server-side to clear — the client discards
 * from secure storage; the 204/instruction is the signal.
 */
export function clearGuestCredential(res: Response, transport: GuestTransport): void {
  if (transport === 'header') return;
  const profile = activeCookieProfile();
  res.clearCookie(profile.name, {
    httpOnly: profile.options.httpOnly,
    secure: profile.options.secure,
    sameSite: profile.options.sameSite,
    path: profile.options.path,
  });
}

/** The presented guest credential, header first, else cookie (D9). */
function presentedGuestCredential(
  req: Request,
): { token: string; transport: GuestTransport } | undefined {
  const headerToken = headerValue(req, GUEST_TOKEN_HEADER);
  if (headerToken !== undefined) return { token: headerToken, transport: 'header' };
  const profile = guestCookieProfile();
  const cookieToken = readGuestCookie(req.headers.cookie, profile.name);
  if (cookieToken !== undefined) return { token: cookieToken, transport: 'cookie' };
  return undefined;
}

/**
 * Resolve the guest half and attach the final actor. Runs AFTER Oxy auth.
 */
async function resolveGuestHalf(req: Request, res: Response, next: NextFunction): Promise<void> {
  const oxyUserId = getOxyUserId(req);
  req.guestCredential = 'absent';

  // With guest commerce off there is no credential to honour — but D2's
  // refusal above (bearer-fail-401) has already run, so nothing downgrades.
  const presented = config.guest.enabled ? presentedGuestCredential(req) : undefined;

  if (!presented) {
    req.commerceActor = oxyUserId ? { kind: 'oxy', oxyUserId } : { kind: 'anonymous' };
    next();
    return;
  }

  // CSRF BEFORE validation: a cross-site write must not even reach the
  // database. Only the cookie carriage is CSRF-able (D10).
  if (
    presented.transport === 'cookie' &&
    isStateChanging(req.method) &&
    !passesCookieCsrf(req, res)
  ) {
    return;
  }

  const now = new Date();
  const resolved = await resolveGuestSessionByToken(presented.token, now);

  if (!resolved) {
    // Invalid resolves as ABSENT (D2) — normal, not an error; and no session
    // is auto-minted for it on reads, so a revoked token cannot farm fresh
    // sessions. The marker is what lets the inspect surface answer honestly.
    req.guestCredential = 'invalid';
    req.commerceActor = oxyUserId ? { kind: 'oxy', oxyUserId } : { kind: 'anonymous' };
    next();
    return;
  }

  req.guestCredential = 'valid';

  if (oxyUserId) {
    // Oxy wins (D2). The guest session is surfaced ONLY as the possession
    // proof for merge (#104) and claim (#109); it is not touched, not
    // rotated, and no other code may read it.
    req.commerceActor = {
      kind: 'oxy',
      oxyUserId,
      presentedGuestSessionId: resolved.session.id,
    };
    next();
    return;
  }

  let context: GuestSessionRequestContext = {
    resolved,
    transport: presented.transport,
    rotatedInFlight: false,
  };

  // The 7-day activity rotation (D3), answered in kind. Never on a
  // grace-window match — that presented token is already being replaced.
  if (!resolved.matchedPrevious && rotationDue(resolved.session, now)) {
    const rotated = await rotateGuestSession(resolved.session, now);
    if (rotated) {
      setGuestCredential(res, rotated.token, presented.transport);
      context = {
        resolved: { session: rotated.session, matchedPrevious: false },
        transport: presented.transport,
        rotatedInFlight: true,
      };
    }
    // A lost race means a concurrent request rotated first; this request's
    // session row is stale but its id is not, and the actor stands.
  }

  req.guestSessionContext = context;
  req.commerceActor = {
    kind: 'guest',
    guestSessionId: context.resolved.session.id,
    transport: presented.transport,
  };
  next();
}

/**
 * The resolver middleware. Mount ONCE per router that serves buyer commerce;
 * every handler behind it reads `req.commerceActor` and nothing else.
 */
export const resolveCommerceActor: RequestHandler = (req, res, next) => {
  optionalAuth(req, res, (authError?: unknown) => {
    if (authError !== undefined && authError !== null) {
      next(authError);
      return;
    }

    // D2: a PRESENTED Oxy credential that did not verify is a 401 — never a
    // silent downgrade to guest or anonymous. Absence of the header is what
    // makes guest resolution reachable at all.
    const bearerPresented =
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ');
    if (bearerPresented && !getOxyUserId(req)) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Invalid or expired Oxy credential', 401);
      return;
    }

    resolveGuestHalf(req, res, next).catch((error: unknown) => next(error));
  });
};

/**
 * LAZY issuance for the CURRENT request — the primitive behind "issue on the
 * first eligible stateful write" (D3). Only explicitly allowed routes call
 * it: the ensure endpoint today, cart writes when #104 lands. Never called
 * on a read, so a page view cannot create a row.
 *
 * Enforces the D10 origin rule for cookie-transport issuance (the write that
 * SETS the cookie is as CSRF-relevant as one authenticated by it), issues,
 * attaches the credential in kind, and swaps `req.commerceActor` to the new
 * guest actor.
 *
 * @returns The issued session context, or `undefined` when the response has
 *   already been answered with a refusal.
 */
export async function issueGuestActor(
  req: Request,
  res: Response,
): Promise<GuestSessionRequestContext | undefined> {
  const transport: GuestTransport =
    headerValue(req, GUEST_TRANSPORT_HEADER) === 'header' ? 'header' : 'cookie';

  if (transport === 'cookie' && !passesCookieCsrf(req, res)) {
    return undefined;
  }

  const now = new Date();
  const { session, token } = await issueGuestSession({
    clientClass: declaredClientClass(req, transport),
    now,
  });

  setGuestCredential(res, token, transport);

  const context: GuestSessionRequestContext = {
    resolved: { session, matchedPrevious: false },
    transport,
    rotatedInFlight: false,
  };
  req.guestSessionContext = context;
  req.guestCredential = 'valid';
  req.commerceActor = { kind: 'guest', guestSessionId: session.id, transport };
  return context;
}
