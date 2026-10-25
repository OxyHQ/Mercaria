/** Resolve one commerce actor from shared Oxy auth or an explicit guest header.
 * Oxy wins; any unverified Authorization header fails instead of downgrading.
 * Cookies never authenticate ordinary commerce operations (ADR 0003 D9/D10).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getOxyUserId } from '@oxy.so/core/server';
import type { GuestClientClass } from '@mercaria/shared-types';
import { GUEST_CLIENT_CLASSES } from '@mercaria/shared-types';
import { config } from '../config/index.js';
// Discovery analytics (#77). The emitter only, and it cannot throw or be
// awaited — a telemetry failure must never turn a guest's first add-to-cart
// into an error.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import { checkGuestAbuse } from '../services/guest-governance/abuse.service.js';
import { recordSecuritySignal } from '../services/guest-governance/security-signals.service.js';
import { networkRangeOf } from '../services/guest-governance/subject.js';
import type { CommerceActor } from '../services/commerce-actor.js';
import {
  issueGuestSession,
  resolveGuestSessionByToken,
  rotateGuestSession,
  rotationDue,
  type ResolvedGuestSession,
} from '../services/guest-session.service.js';
import { optionalAuth } from './auth.js';
import {
  hasLegacyCommerceCookie,
  requireHeaderTransport,
  sendCommerceUpgradeRequired,
} from './commerce-transport.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';

/** The explicit credential header on every platform, both directions (D9). */
export const GUEST_TOKEN_HEADER = 'x-mercaria-guest-token';

/**
 * OPTIONAL issuance-time client-class declaration (`web | ios | android |
 * other`), an audit dimension only — never authorization, never a binding.
 * Undeclared clients retain the historical header-client default `other`.
 */
export const GUEST_CLIENT_HEADER = 'x-mercaria-guest-client';

/** Whether a guest credential was presented, and whether it resolved (D2). */
export type GuestCredentialState = 'absent' | 'invalid' | 'valid';

/** What the resolver leaves for route handlers, beside `req.commerceActor`. */
export interface GuestSessionRequestContext {
  resolved: ResolvedGuestSession;
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

/** First value of a possibly-repeated request header, trimmed; else undefined. */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Issuance-time operational class; later headers cannot overwrite the stored value. */
function declaredClientClass(req: Request): GuestClientClass {
  const declared = headerValue(req, GUEST_CLIENT_HEADER);
  if (declared !== undefined && (GUEST_CLIENT_CLASSES as readonly string[]).includes(declared)) {
    return declared as GuestClientClass;
  }
  return 'other';
}

/** Credentials are returned only to explicit header clients, with immutable expiry. */
export function setGuestCredential(
  res: Response,
  token: string,
  session: ResolvedGuestSession['session'],
): void {
  res.setHeader(GUEST_TOKEN_HEADER, token);
  res.setHeader('X-Mercaria-Guest-Expires-At', session.expiresAt.toISOString());
  res.setHeader(
    'X-Mercaria-Guest-Generation',
    String((session.rotatedAt ?? session.createdAt).getTime()),
  );
  res.setHeader('Cache-Control', 'no-store');
}

/** The client discards only the credential this response revokes. */
export function clearGuestCredential(res: Response): void {
  res.setHeader(GUEST_TOKEN_HEADER, '');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Resolve the guest half and attach the final actor. Runs AFTER Oxy auth.
 */
async function resolveGuestHalf(req: Request, res: Response, next: NextFunction): Promise<void> {
  const oxyUserId = getOxyUserId(req);
  req.guestCredential = 'absent';

  // With guest commerce off there is no credential to honour — but D2's
  // refusal above (bearer-fail-401) has already run, so nothing downgrades.
  const presented = config.guest.enabled ? headerValue(req, GUEST_TOKEN_HEADER) : undefined;

  // Reads can rotate a guest bearer too. A client that cannot durably retain
  // its successor must fail before lookup/touch/rotation, never become anonymous.
  // Oxy ownership still wins; its accompanying guest proof is inert here.
  if (presented && !oxyUserId && req.headers['x-mercaria-guest-persistence'] === 'unavailable') {
    res.setHeader('Cache-Control', 'no-store');
    sendError(
      res,
      ErrorCodes.COMMERCE_STORAGE_UNAVAILABLE,
      'Storage is unavailable. Enable storage and reload to continue with your existing cart.',
      503,
    );
    return;
  }

  if (!presented && !oxyUserId && hasLegacyCommerceCookie(req, 'guest')) {
    sendCommerceUpgradeRequired(res);
    return;
  }

  if (!presented) {
    req.commerceActor = oxyUserId ? { kind: 'oxy', oxyUserId } : { kind: 'anonymous' };
    next();
    return;
  }

  const now = new Date();
  const resolved = await resolveGuestSessionByToken(presented, now);

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
    // rotated, and no other code may read it. Both operations return a scoped
    // credential-clear response after their transaction succeeds.
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
    rotatedInFlight: false,
  };

  // The 7-day activity rotation (D3), answered in kind. Never on a
  // grace-window match — that presented token is already being replaced.
  if (!resolved.matchedPrevious && rotationDue(resolved.session, now)) {
    const rotated = await rotateGuestSession(resolved.session, now);
    if (rotated) {
      setGuestCredential(res, rotated.token, rotated.session);
      context = {
        resolved: { session: rotated.session, matchedPrevious: false },
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
    clientClass: context.resolved.session.clientClass,
  };
  next();
}

/**
 * The resolver middleware. Mount ONCE per router that serves buyer commerce;
 * every handler behind it reads `req.commerceActor` and nothing else.
 */
export const resolveCommerceActor: RequestHandler = (req, res, next) => {
  // Even an anonymous cart response must not be reused for a later custom-header owner.
  // Public catalog routes do not pass through this buyer-context boundary.
  res.setHeader('Cache-Control', 'no-store');
  optionalAuth(req, res, (authError?: unknown) => {
    if (authError !== undefined && authError !== null) {
      next(authError);
      return;
    }

    // D2: a PRESENTED Oxy credential that did not verify is a 401 — never a
    // silent downgrade to guest or anonymous. Absence of the header is what
    // makes guest resolution reachable at all.
    const credentialPresented = req.headers.authorization !== undefined;
    if (credentialPresented && !getOxyUserId(req)) {
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
 * Requires explicit header-transport negotiation before issuance, returns
 * the credential with its absolute expiry, and sets the current guest actor.
 *
 * @returns The issued session context, or `undefined` when the response has
 *   already been answered with a refusal.
 */
export async function issueGuestActor(
  req: Request,
  res: Response,
): Promise<GuestSessionRequestContext | undefined> {
  if (!requireHeaderTransport(req, res, 'guest')) return undefined;

  const now = new Date();

  // #111 abuse control 1 and 4 — session FARMING, bounded on a COARSE network
  // range and never on a device.
  //
  // The check runs BEFORE anything is minted, which is the whole point: a
  // refusal after issuance would have created the row it was refusing. The
  // friction is explicit (a stated wait the response carries) rather than a
  // silent failure, and the refusal names the MEASURE without naming the
  // threshold — a buyer can act on "wait 15 minutes" and cannot act on "you
  // are the 201st".
  const verdict = await checkGuestAbuse({
    scope: 'session_issuance',
    subjectValue: networkRangeOf(req.ip ?? ''),
    now,
  });
  if (verdict.outcome === 'friction') {
    recordSecuritySignal('session_issuance_rate');
    sendError(
      res,
      ErrorCodes.RATE_LIMITED,
      `Too many new sessions from this network. Try again after ${verdict.retryAt.toISOString()}.`,
      429,
    );
    return undefined;
  }

  const { session, token } = await issueGuestSession({
    clientClass: declaredClientClass(req),
    now,
  });

  setGuestCredential(res, token, session);

  const context: GuestSessionRequestContext = {
    resolved: { session, matchedPrevious: false },
    rotatedInFlight: false,
  };
  req.guestSessionContext = context;
  req.guestCredential = 'valid';
  req.commerceActor = {
    kind: 'guest',
    guestSessionId: session.id,
    clientClass: session.clientClass,
  };

  // #77 guest event 1. Emitted AFTER the actor is swapped, so the event's own
  // pseudonym is derived from the session that was just issued rather than from
  // the anonymous state that preceded it — otherwise the first event of a guest's
  // life would sit in a different pseudonym than every event after it, and the
  // funnel would start one step in.
  //
  // The event carries no session id and no token: the pseudonym is a one-way
  // hash under a rotating server salt, and `analytics_events` has no column
  // either could arrive in.
  emitAnalyticsEvent(req, { eventType: 'guest_session_issued' });
  return context;
}
