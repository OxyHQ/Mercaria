/**
 * The guest-session surface — the MINIMUM public surface ADR 0003 permits
 * (#103): ensure/create, inspect safe state, rotate, revoke. Nothing else.
 *
 * Conversion (merge into an Oxy cart, claiming orders) deliberately does NOT
 * live here: those are #104's `/cart/merge` and #109's claim endpoint, each
 * re-verifying possession at its own boundary. A generic "reassign this
 * session" route is the unprotected shape the ADR exists to refuse.
 *
 * Cart routes will issue LAZILY through `issueGuestActor` when #104 lands
 * (M7); this explicit ensure endpoint exists for clients that want the
 * credential before their first write, and it is a WRITE — a page view never
 * reaches it, so acceptance 7 ("no page view alone creates a guest row")
 * holds by construction.
 *
 * The bearer token appears ONLY in `Set-Cookie` (cookie transport) or the
 * `X-Mercaria-Guest-Token` response header (header transport) — never in a
 * response body, on any path here (D9).
 */

import { Router, type Request, type Response } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';
import {
  clearGuestCredential,
  issueGuestActor,
  resolveCommerceActor,
  setGuestCredential,
} from '../middleware/commerce-actor.js';
import {
  GuestIssuanceDisabledError,
  revokeGuestSession,
  rotateGuestSession,
  toGuestSessionState,
} from '../services/guest-session.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';

const router = Router();

// ONE resolver for the whole surface (D1: resolved once per request).
router.use(resolveCommerceActor);

/**
 * POST /guest/session — ensure a guest session exists for this caller.
 *
 * - A VALID presented session is REUSED (200) — issuance never mints a
 *   duplicate beside a live credential, and a retried ensure converges on the
 *   same session.
 * - An anonymous caller gets a fresh session (201), credential answered in
 *   the declared transport. An INVALID presented credential does not block
 *   re-issuance: this is a rate-limited WRITE, and a buyer whose cookie
 *   expired must be able to start over (D2's no-minting rule is about READS).
 * - An Oxy-authenticated caller is refused (409): guest sessions exist for
 *   the person with no Oxy session, and nothing holds both actors at once.
 */
async function ensureGuestSession(req: Request, res: Response): Promise<void> {
  try {
    const actor = req.commerceActor;
    if (actor?.kind === 'oxy') {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'An Oxy-authenticated caller already has an identity; guest sessions are for signed-out buyers',
        409,
      );
      return;
    }

    if (actor?.kind === 'guest' && req.guestSessionContext) {
      sendSuccess(res, toGuestSessionState(req.guestSessionContext.resolved.session, new Date()));
      return;
    }

    const context = await issueGuestActor(req, res);
    if (!context) return; // refused (CSRF) — already answered
    sendSuccess(res, toGuestSessionState(context.resolved.session, new Date()), 201);
  } catch (err) {
    if (err instanceof GuestIssuanceDisabledError) {
      sendError(
        res,
        ErrorCodes.GUEST_ISSUANCE_DISABLED,
        'Guest session issuance is temporarily disabled',
        503,
      );
      return;
    }
    log.guest.error({ err }, 'Failed to ensure guest session');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to create a guest session', 500);
  }
}

/**
 * GET /guest/session — the SAFE state of the presented session.
 *
 * The one surface that must distinguish NO actor from an INVALID credential
 * (D2): absent → 404, invalid → 401. The 401 is UNIFORM across expired,
 * revoked and malformed — the body never says which. An Oxy caller gets 404:
 * their presented guest credential is inert by precedence, and the only
 * consumers of it are merge (#104) and claim (#109).
 */
function inspectGuestSession(req: Request, res: Response): void {
  const actor = req.commerceActor;
  if (actor?.kind === 'guest' && req.guestSessionContext) {
    sendSuccess(res, toGuestSessionState(req.guestSessionContext.resolved.session, new Date()));
    return;
  }
  if (actor?.kind !== 'oxy' && req.guestCredential === 'invalid') {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Guest session is not valid', 401);
    return;
  }
  sendError(res, ErrorCodes.NOT_FOUND, 'No guest session', 404);
}

/**
 * POST /guest/session/rotate — rotate the token (D3), answered in kind.
 *
 * Refusals: no/invalid credential → uniform 401; an Oxy caller → 409 (their
 * guest credential is inert); a grace-window match or a lost CAS race → 409,
 * because the presented token is already being replaced and handing out a
 * SECOND fresh token would strand one of the two holders.
 */
async function rotatePresentedSession(req: Request, res: Response): Promise<void> {
  try {
    const actor = req.commerceActor;
    if (actor?.kind === 'oxy') {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'Guest sessions are inert for Oxy-authenticated callers',
        409,
      );
      return;
    }
    const context = req.guestSessionContext;
    if (actor?.kind !== 'guest' || !context) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Guest session is not valid', 401);
      return;
    }

    const now = new Date();

    // The resolver may already have rotated on the 7-day cadence and answered
    // in kind; rotating again here would immediately strand that fresh token.
    if (context.rotatedInFlight) {
      sendSuccess(res, toGuestSessionState(context.resolved.session, now));
      return;
    }

    if (context.resolved.matchedPrevious) {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'A rotation is already in progress for this session',
        409,
      );
      return;
    }

    const rotated = await rotateGuestSession(context.resolved.session, now);
    if (!rotated) {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'A rotation is already in progress for this session',
        409,
      );
      return;
    }

    setGuestCredential(res, rotated.token, context.transport);
    sendSuccess(res, toGuestSessionState(rotated.session, now));
  } catch (err) {
    log.guest.error({ err }, 'Failed to rotate guest session');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to rotate the guest session', 500);
  }
}

/**
 * DELETE /guest/session — revoke the presented session and clear its cookie.
 *
 * Always 204, deliberately: revocation is idempotent, and answering
 * differently for a live, expired or absent credential would make this a
 * validity oracle. An Oxy caller's presented session is NOT revoked here —
 * that is the merge transaction's job (#104) — but the cookie is cleared,
 * since a signed-in browser has no use for it.
 */
async function revokePresentedSession(req: Request, res: Response): Promise<void> {
  try {
    const actor = req.commerceActor;
    if (actor?.kind === 'guest' && req.guestSessionContext) {
      await revokeGuestSession(req.guestSessionContext.resolved.session.id, new Date());
      clearGuestCredential(res, req.guestSessionContext.transport);
    } else {
      // Without a valid session the transport is unknowable; clearing the
      // cookie unconditionally is a no-op when none was set.
      clearGuestCredential(res, 'cookie');
    }
    res.status(204).end();
  } catch (err) {
    log.guest.error({ err }, 'Failed to revoke guest session');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to revoke the guest session', 500);
  }
}

router.post('/', makeRateLimiter('guest-issue'), ensureGuestSession);
router.get('/', makeRateLimiter('guest'), inspectGuestSession);
router.post('/rotate', makeRateLimiter('guest'), rotatePresentedSession);
router.delete('/', makeRateLimiter('guest'), revokePresentedSession);

export default router;
