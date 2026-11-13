/** Temporary transfer of signed attribution evidence; never cart, portal or Oxy authority. */
import { Router, type Request, type Response } from 'express';
import { verifySecret } from '@oxy.so/core/server';
import { isAllowedBrowserOrigin } from '../lib/allowed-origins.js';
import { verifyReferralState } from '../services/referrals/referral-state.js';

// The live issuer was disabled at this readback. Rollout rechecks that fact.
// No config knob can slide these dates forward or admit new header-issued state.
export const REFERRAL_COOKIE_CUTOFF = Date.parse('2026-10-25T15:00:46Z');
export const REFERRAL_COOKIE_DEADLINE = REFERRAL_COOKIE_CUTOFF + 90 * 24 * 60 * 60 * 1000;
export const REFERRAL_COOKIE_MIGRATION_PATHS = [
  '/referrals/legacy-cookie-exchange',
  '/referrals/legacy-cookie-ack',
] as const;

function cookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? '__Host-mercaria_referral'
    : 'mercaria_referral_dev';
}

function presentedCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header || header.length > 8192) return undefined;
  const matches = header.split(';').filter((part) => part.trim().startsWith(`${cookieName()}=`));
  if (matches.length !== 1) return undefined;
  const raw = matches[0].trim().slice(cookieName().length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function liveLegacyState(token: string | undefined, now: Date) {
  try {
    const state = verifyReferralState(token, now);
    return state &&
      state.clickedAt.getTime() <= REFERRAL_COOKIE_CUTOFF &&
      state.expiresAt.getTime() <= REFERRAL_COOKIE_DEADLINE
      ? state
      : null;
  } catch {
    // Missing/retired signing keys reveal nothing and never mint substitute state.
    return null;
  }
}

function gate(req: Request, res: Response): Date | null {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (
    typeof req.headers.origin !== 'string' ||
    !isAllowedBrowserOrigin(req.headers.origin) ||
    req.headers['x-mercaria-referral-migration'] !== 'header-v1' ||
    !req.is('application/json')
  ) {
    res.sendStatus(403);
    return null;
  }
  if (
    !req.body ||
    typeof req.body !== 'object' ||
    Array.isArray(req.body) ||
    Object.keys(req.body).length
  ) {
    res.sendStatus(400);
    return null;
  }
  const now = new Date();
  if (now.getTime() >= REFERRAL_COOKIE_DEADLINE) {
    res.sendStatus(410);
    return null;
  }
  return now;
}

const router = Router();
router.post('/legacy-cookie-exchange', (req, res) => {
  const now = gate(req, res);
  if (!now) return;
  // An explicit carrier, including a malformed one, never falls back to another owner/click.
  if (req.headers['x-mercaria-referral-state'] !== undefined) {
    res.status(204).end();
    return;
  }
  const token = presentedCookie(req);
  const state = liveLegacyState(token, now);
  if (token && state) {
    res.setHeader('X-Mercaria-Referral-State', token);
    res.setHeader('X-Mercaria-Referral-Expires-At', state.expiresAt.toISOString());
  }
  // A lost response can be retried with exactly the original bytes and deadline.
  res.status(204).end();
});

router.post('/legacy-cookie-ack', (req, res) => {
  const now = gate(req, res);
  if (!now) return;
  const token = presentedCookie(req);
  const persisted = req.headers['x-mercaria-referral-state'];
  if (
    !token ||
    typeof persisted !== 'string' ||
    !verifySecret(token, persisted) ||
    !liveLegacyState(token, now)
  ) {
    res.sendStatus(409);
    return;
  }
  // Expiration only, after the client confirms durable persistence. A changed
  // cookie from another tab cannot be cleared by an acknowledgement of this one.
  res.clearCookie(cookieName(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
  res.status(204).end();
});

export default router;
