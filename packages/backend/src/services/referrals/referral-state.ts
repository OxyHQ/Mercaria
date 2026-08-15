/**
 * The referral state carrier (#143 web rules 2, 4, 7 and 10) — a short-lived,
 * purpose-specific credential that authorizes nothing.
 *
 * ## Why this exists at all, and why it is not a guest session
 *
 * ADR 0005 D6 stores a guest touch against the checkout-scoped id from
 * #101/#103. ADR 0003 T10 says a page view never creates one: "browsing
 * creates NO row… an anonymous crawler generates zero rows." A referral link
 * click by a stranger is exactly a page view, so the two rules together forbid
 * both available shortcuts — minting a guest session on the redirect, and
 * writing a touch against an invented subject.
 *
 * What is left is this: the click's EVIDENCE travels with the browser, and the
 * touch is written at the first moment there is a subject to attribute
 * (`binding.service.ts`). So an anonymous click writes no row, a crawler writes
 * no row, and a real shopper's touch is recorded against the very session
 * ADR 0005 D6 names.
 *
 * ## It cannot authorize anything, structurally
 *
 * The verified payload is `{linkId, codeId, clickedAt}` — three of Mercaria's
 * own row ids and an instant. There is no user id, no session id, no order id
 * and no scope list in it, so there is nothing an authorization check could
 * read even if one were written; and no resolver outside this file consumes it.
 * That is ADR 0005 A1 ("codes and click ids are attribution evidence, never
 * credentials") as a property of the type rather than a rule to remember.
 *
 * Decoding it discloses nothing new: `linkId` and `codeId` are already inside
 * the signed link token the partner published, and neither names a partner, a
 * program or a person.
 *
 * ## Not `mgs_`, not `mgp_`, not `mgx_`
 *
 * The prefix is `mrf_`, the table is nowhere (this credential is STATELESS),
 * and no guest resolver will look at it — #103's I5 scopes credentials by
 * table, resolver and prefix, and this one shares none of the three with any of
 * them. A `mgs_` cart token presented here fails its shape gate before any
 * signature work, and an `mrf_` presented to the guest resolver does the same.
 *
 * ## The window anchor is INSIDE the signature
 *
 * `clickedAt` is stamped once, at the redirect, and travels signed. Presenting
 * the carrier again does not move it, and neither does re-issuing the cookie —
 * so "do not extend the window forever through every page view" (#143 web rule
 * 7) is arithmetic on a value the client cannot edit, not a rule some later
 * navigation handler has to remember.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import { z } from 'zod';
import type { Response } from 'express';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';

/**
 * The credential's prefix. Distinct from every #103/#108 prefix by
 * construction, and asserted disjoint by `referral-attribution-isolation`.
 */
export const REFERRAL_STATE_PREFIX = 'mrf_';

/** The response header a NATIVE client receives the carrier on. */
export const REFERRAL_STATE_HEADER = 'X-Mercaria-Referral-State';

/** Declared on any response that issues the carrier by header (#103's shape). */
export const REFERRAL_STATE_TRANSPORT_HEADER = 'X-Mercaria-Referral-Transport';

/** The request header a native client presents the carrier back on. */
export const REFERRAL_STATE_REQUEST_HEADER = 'x-mercaria-referral-state';

/** How the carrier reached, or will reach, the client. */
export type ReferralStateTransport = 'cookie' | 'header';

/** The signed claims. Short keys: this travels in a cookie on every request. */
const statePayloadSchema = z
  .object({
    /** `referral_links.id`. */
    l: z.string().min(1).max(64),
    /** `referral_codes.id`. */
    c: z.string().min(1).max(64),
    /** The click instant, epoch SECONDS — the attribution-window anchor. */
    t: z.number().int().positive(),
    /** The carrier's own deadline, epoch seconds. */
    x: z.number().int().positive(),
    /** Per-issue random, so two carriers for one link never share a spelling. */
    n: z.string().min(1).max(32),
  })
  .strict();

/** What a verified carrier yields. */
export interface ReferralStateClaims {
  linkId: string;
  codeId: string;
  clickedAt: Date;
  expiresAt: Date;
}

/** The HMAC key, or a refusal that NAMES the missing variable. */
function stateSecret(): string {
  const secret = config.referrals.stateSecret;
  if (secret === undefined || secret.length === 0) {
    // Unreachable while `REFERRALS_ENABLED` demands it (the half-configuration
    // rule in `config/index.ts`), and stated anyway: signing with an empty key
    // would make every carrier forgeable and nothing would report it.
    throw new Error(
      'Referral state is not configured: set REFERRAL_STATE_SECRET (REFERRALS_ENABLED requires it).',
    );
  }
  return secret;
}

/** HMAC-SHA256 over the encoded payload. */
function sign(payloadB64: string): string {
  return createHmac('sha256', stateSecret()).update(payloadB64).digest('base64url');
}

/**
 * Mint a carrier for one resolved click.
 *
 * `lifetimeSeconds` comes from the program's own attribution window, capped by
 * {@link REFERRAL_STATE_MAX_LIFETIME_SECONDS}: a program may not hand a browser
 * a cookie that outlives any window it could serve.
 */
export function mintReferralState(input: {
  linkId: string;
  codeId: string;
  clickedAt: Date;
  lifetimeSeconds: number;
}): { token: string; expiresAt: Date } {
  const clickedAtSeconds = Math.floor(input.clickedAt.getTime() / 1_000);
  const lifetime = Math.min(
    Math.max(input.lifetimeSeconds, 1),
    REFERRAL_STATE_MAX_LIFETIME_SECONDS,
  );
  const expiresAtSeconds = clickedAtSeconds + lifetime;
  const payload = {
    l: input.linkId,
    c: input.codeId,
    t: clickedAtSeconds,
    x: expiresAtSeconds,
    n: randomBytes(9).toString('base64url'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    token: `${REFERRAL_STATE_PREFIX}${payloadB64}.${sign(payloadB64)}`,
    expiresAt: new Date(expiresAtSeconds * 1_000),
  };
}

/**
 * The absolute ceiling on a carrier's life — 90 days, matching the longest
 * window ADR 0005 D4 describes (30 days touch→signup plus 90 days
 * signup→activation is a MERCHANT runway measured from a stored row, not from
 * a browser's cookie jar).
 */
export const REFERRAL_STATE_MAX_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

/**
 * Verify a presented carrier.
 *
 * Returns `null` for every failure — malformed, wrong prefix, bad signature,
 * unreadable payload, past its deadline. Uniform, because the reasons are
 * interesting only to an attacker: a caller learns whether it has usable state,
 * and nothing about why it does not.
 */
export function verifyReferralState(
  token: string | undefined,
  now: Date,
): ReferralStateClaims | null {
  if (token === undefined || !token.startsWith(REFERRAL_STATE_PREFIX)) return null;
  // Bound the work before any crypto: a cookie is attacker-controlled bytes.
  if (token.length > 1_024) return null;

  const body = token.slice(REFERRAL_STATE_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, providedSig] = parts;
  if (payloadB64 === undefined || providedSig === undefined) return null;
  if (!verifySecret(providedSig, sign(payloadB64))) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = statePayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;

  const expiresAt = new Date(parsed.data.x * 1_000);
  if (expiresAt.getTime() <= now.getTime()) return null;

  return {
    linkId: parsed.data.l,
    codeId: parsed.data.c,
    clickedAt: new Date(parsed.data.t * 1_000),
    expiresAt,
  };
}

/**
 * The web cookie profile — ADR 0003 D9's shape, applied to a different
 * credential.
 *
 * Production: `__Host-mercaria_referral` — `HttpOnly; Secure; SameSite=Lax;
 * Path=/`, no `Domain`. `SameSite=Lax` rather than `Strict` because the carrier
 * is SET on a top-level navigation arriving from a partner's own site, which is
 * exactly the cross-site case `Strict` drops.
 *
 * Development: `mercaria_referral_dev` without `Secure`, under a DIFFERENT
 * name, logged once at first use — an explicit downgrade, never a silent one.
 */
export function referralStateCookieProfile(maxAgeMs: number): {
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
    name: production ? '__Host-mercaria_referral' : 'mercaria_referral_dev',
    options: {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeMs,
    },
  };
}

let devProfileLogged = false;

/** The profile for a WRITE, logging the dev downgrade exactly once. */
function activeCookieProfile(maxAgeMs: number): ReturnType<typeof referralStateCookieProfile> {
  const profile = referralStateCookieProfile(maxAgeMs);
  if (!profile.options.secure && !devProfileLogged) {
    devProfileLogged = true;
    log.general.info(
      { cookieName: profile.name },
      '[Referrals] development referral-state cookie profile in use (no Secure attribute, ' +
        'non-__Host name). Production uses __Host-mercaria_referral with Secure — an explicit ' +
        'dev-only downgrade.',
    );
  }
  return profile;
}

/**
 * Read the carrier out of a `Cookie` header by hand.
 *
 * No global cookie-parser joins this app's middleware chain — the four
 * raw-body webhook mounts depend on it staying that way — so this scans, and
 * bounds its work on adversarial input first (8 KiB is Node's default header
 * cap).
 */
export function readReferralStateCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (cookieHeader === undefined || cookieHeader.length === 0) return undefined;
  if (cookieHeader.length > 8_192) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    if (raw.length === 0) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Attach a freshly minted carrier to the response, in kind. */
export function setReferralState(
  res: Response,
  token: string,
  transport: ReferralStateTransport,
  maxAgeMs: number,
): void {
  if (transport === 'header') {
    res.setHeader(REFERRAL_STATE_HEADER, token);
    res.setHeader(REFERRAL_STATE_TRANSPORT_HEADER, 'header');
    return;
  }
  const profile = activeCookieProfile(maxAgeMs);
  res.cookie(profile.name, token, profile.options);
}

/**
 * Clear the carrier — the supersession half of #143 web rule 8.
 *
 * Called once a carrier has been REDEEMED into a touch, so a second bind of the
 * same click is not even attempted, and when a request declares consent
 * `denied`.
 */
export function clearReferralState(res: Response, transport: ReferralStateTransport): void {
  if (transport === 'header') {
    // A header carrier is cleared by handing back an empty one; a native client
    // stores what it is given, and there is no jar to expire.
    res.setHeader(REFERRAL_STATE_HEADER, '');
    res.setHeader(REFERRAL_STATE_TRANSPORT_HEADER, 'header');
    return;
  }
  const profile = activeCookieProfile(0);
  res.clearCookie(profile.name, {
    httpOnly: profile.options.httpOnly,
    secure: profile.options.secure,
    sameSite: profile.options.sameSite,
    path: profile.options.path,
  });
}
