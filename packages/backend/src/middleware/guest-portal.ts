/** Portal grants remain separate from cart and Oxy identities; only explicit headers carry them. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { GuestOrderAccessGrantRow } from '../db/guestPortal/grantRepository.js';
import { resolvePortalGrant } from '../services/guest-portal/grant.service.js';
import { hasLegacyCommerceCookie, sendCommerceUpgradeRequired } from './commerce-transport.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';

/** The portal credential header on every platform, both directions. */
export const PORTAL_TOKEN_HEADER = 'x-mercaria-portal-token';

declare global {
  namespace Express {
    interface Request {
      /** The LIVE portal grant this request presented, if it presented one. */
      portalGrant?: GuestOrderAccessGrantRow;
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

export function setPortalCredential(
  res: Response,
  token: string,
  grant: GuestOrderAccessGrantRow,
): void {
  res.setHeader(PORTAL_TOKEN_HEADER, token);
  res.setHeader('X-Mercaria-Portal-Expires-At', grant.expiresAt.toISOString());
  res.setHeader('X-Mercaria-Portal-Generation', String(grant.createdAt.getTime()));
  res.setHeader('Cache-Control', 'no-store');
}

export function clearPortalCredential(res: Response): void {
  res.setHeader(PORTAL_TOKEN_HEADER, '');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Resolve a presented portal header; refuse an obsolete cookie-only client.
 *
 * Attaching-or-not rather than 401ing is what lets one router serve both the
 * unauthenticated exchange and the authenticated reads: the handlers that need
 * a credential say so with {@link requirePortalSession}, and the ones that do
 * not are not forced to opt out of a gate.
 *
 * Portal-only reads authenticate this grant independently of Oxy. Operations
 * requiring an Oxy actor run the strict CommerceActor resolver separately.
 */
export const resolvePortalSession: RequestHandler = (req, res, next) => {
  void resolve(req, res, next).catch((error: unknown) => next(error));
};

async function resolve(req: Request, res: Response, next: NextFunction): Promise<void> {
  const presented = headerValue(req, PORTAL_TOKEN_HEADER);
  if (!presented && hasLegacyCommerceCookie(req, 'portal')) {
    sendCommerceUpgradeRequired(res);
    return;
  }
  if (!presented) {
    next();
    return;
  }

  const grant = await resolvePortalGrant(presented, new Date());
  if (grant !== null) {
    req.portalGrant = grant;
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
