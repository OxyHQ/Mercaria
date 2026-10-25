import type { Request, Response } from 'express';
import { ErrorCodes, sendError } from '../utils/api-response.js';

export type CommerceCredentialKind = 'guest' | 'portal';

/** Reject old bundles before they consume a one-time link or create an orphan cart. */
export function requireHeaderTransport(
  req: Request,
  res: Response,
  kind: CommerceCredentialKind,
): boolean {
  if (req.headers[`x-mercaria-${kind}-transport`] === 'header') return true;
  sendCommerceUpgradeRequired(res);
  return false;
}

export function sendCommerceUpgradeRequired(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  sendError(
    res,
    ErrorCodes.COMMERCE_CLIENT_UPDATE_REQUIRED,
    'Update or reload Mercaria to continue with your existing access.',
    426,
  );
}

/** Names only: an old cookie must not silently become an empty or replacement cart. */
export function hasLegacyCommerceCookie(req: Request, kind: CommerceCredentialKind): boolean {
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  if (cookie.length > 8192) return true;
  return cookie.split(';').some((part) => {
    const name = part.slice(0, part.indexOf('=')).trim();
    return name === `__Host-mercaria_${kind}` || name === `mercaria_${kind}_dev`;
  });
}
