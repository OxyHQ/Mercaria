/**
 * The signed referral link token — a stateless, HMAC-signed locator.
 *
 * Same construction as `services/payments/stripe/onboarding-state.ts` and
 * `connectors/oauth-state.ts` (`<payloadB64>.<sig>`, HMAC-SHA256, constant-time
 * comparison through `verifySecret`), deliberately, so a reader who understands
 * one understands the other.
 *
 * ## What is inside, and what is deliberately not
 *
 * The payload is `{linkId, codeId, nonce}` — Mercaria's OWN row ids and
 * nothing else. No partner identity, no customer data, no destination, no
 * secret of any kind (issue #142, identity/uniqueness 3): the ids are already
 * meaningless outside this database, and everything the resolution needs is
 * read from the ROW the token names.
 *
 * ## No expiry inside the token, on purpose
 *
 * The link ROW is the lifecycle authority — status, `expires_at`,
 * `revoked_at`, the click ceiling. A token-side expiry would be a second
 * representation of one fact: a revoked link must die immediately whatever its
 * token says, so resolution consults the row regardless, and an expiry claim
 * in the token could only ever disagree with it. What the signature buys is
 * narrower and real: nobody can MINT a token naming a link id they guessed,
 * so the resolution path never touches the database for garbage.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { validationError } from '../../lib/errors/error-codes.js';

/** The signed claims carried in a referral link token. */
const tokenPayloadSchema = z.object({
  /** The `referral_links` row this token names. */
  linkId: z.string().min(1),
  /** The code the link wraps — carried so resolution can cross-check the pair. */
  codeId: z.string().min(1),
  /** Random per-link nonce, so two links to one code never share a spelling. */
  nonce: z.string().min(1),
});

/** The validated claims returned by {@link verifyReferralLinkToken}. */
export interface ReferralLinkTokenClaims {
  linkId: string;
  codeId: string;
}

/** The HMAC key, or a refusal that NAMES the missing variable. */
function linkTokenSecret(): string {
  const secret = config.referrals.linkTokenSecret;
  if (secret === undefined || secret.length === 0) {
    throw validationError(
      'Referral link tokens are not configured: set REFERRAL_LINK_TOKEN_SECRET.',
    );
  }
  return secret;
}

/** base64url-encode a UTF-8 string. */
function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** HMAC-SHA256 the payload with the link token secret, base64url-encoded. */
function sign(payloadB64: string): string {
  return createHmac('sha256', linkTokenSecret()).update(payloadB64).digest('base64url');
}

/** Mint the signed opaque token for one link. */
export function mintReferralLinkToken(params: { linkId: string; codeId: string }): string {
  const payload = {
    linkId: params.linkId,
    codeId: params.codeId,
    nonce: randomBytes(12).toString('hex'),
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a link token and return its claims.
 *
 * @throws `validationError` when the token is malformed or the signature does
 *   not match (compared in constant time). Lifecycle questions — revoked,
 *   expired, over its click limit — are the ROW's to answer, not the token's.
 */
export function verifyReferralLinkToken(token: string): ReferralLinkTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw validationError('Malformed referral link token');
  }
  const [payloadB64, providedSig] = parts;
  if (!verifySecret(providedSig, sign(payloadB64))) {
    throw validationError('Referral link token signature mismatch');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw validationError('Unreadable referral link token payload');
  }

  const parsed = tokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw validationError('Invalid referral link token payload');
  }
  return { linkId: parsed.data.linkId, codeId: parsed.data.codeId };
}
