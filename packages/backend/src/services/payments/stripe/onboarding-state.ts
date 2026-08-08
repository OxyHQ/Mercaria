/**
 * The onboarding round-trip `state` — a stateless, signed, expiring token.
 *
 * Stripe's hosted onboarding takes the seller away and brings them back to a
 * `refresh_url` or a `return_url` with no session, no cookie and no Oxy
 * credential — those handlers must therefore learn WHICH account the round trip
 * belongs to from the URL itself, and a URL parameter is attacker-controlled
 * unless it is signed.
 *
 * Same construction as `connectors/oauth-state.ts` (`<payloadB64>.<sig>`,
 * HMAC-SHA256, constant-time comparison through `verifySecret`), deliberately,
 * so a reader who understands one understands the other.
 *
 * ## What the signature actually buys, and what still has to be true
 *
 * It stops a forged owner. Without it, anyone could call the refresh handler
 * with `state` naming a seller they do not own and be sent into that seller's
 * onboarding — the account-takeover shape issue #46 (security 3) names.
 *
 * It does NOT make the token single-use: that would need server-side state, and
 * the same limitation is recorded on the connector token. The mitigation here is
 * narrower than a TTL alone, and it is in the HANDLER rather than in this file:
 * the refresh path only ever mints a link for the account this token already
 * names, and it never CREATES one. Bringing a new connected account into
 * existence stays behind an authenticated, permission-checked route, so the
 * worst a replayed token can reach is an onboarding flow for an account that
 * already exists — never a new account attached to someone else's store.
 *
 * The TTL is 30 minutes rather than the connector's 10: a seller can genuinely
 * spend that long inside a hosted identity flow before the link they were given
 * expires and the browser lands back on `refresh_url`, and a token that dies
 * mid-flow turns a resumable onboarding into a dead end.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import { z } from 'zod';
import type { ProviderAccountOwnerType } from '@mercaria/shared-types';
import { validationError } from '../../../lib/errors/error-codes.js';
import { stripeOnboardingConfig } from './onboarding-config.js';

/** How long a minted state is valid. See the docblock for why it is not 10 minutes. */
const STATE_TTL_MS = 30 * 60 * 1000;

/** The signed claims carried in an onboarding state token. */
const statePayloadSchema = z.object({
  /** Whether the owner is a store or a P2P seller. */
  ownerType: z.enum(['store', 'user']),
  /** The store id or Oxy user id the flow belongs to. */
  ownerId: z.string().min(1),
  /**
   * The `provider_accounts` row this flow is for.
   *
   * Carried as well as the owner so a replayed token cannot be pointed at a
   * DIFFERENT account the same owner acquired later — the handler checks the row
   * it resolves is the row the token names.
   */
  accountRowId: z.string().min(1),
  /** Random per-flow nonce. */
  nonce: z.string().min(1),
  /** Expiry (epoch ms). */
  exp: z.number().int().positive(),
});

/** The validated claims returned by {@link verifyOnboardingState}. */
export interface OnboardingStateClaims {
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
  accountRowId: string;
}

/** base64url-encode a UTF-8 string. */
function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** HMAC-SHA256 the payload with the onboarding state secret, base64url-encoded. */
function sign(payloadB64: string): string {
  return createHmac('sha256', stripeOnboardingConfig().stateSecret)
    .update(payloadB64)
    .digest('base64url');
}

/** Mint a signed state for one onboarding round trip. */
export function createOnboardingState(params: {
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
  accountRowId: string;
}): string {
  const payload = {
    ownerType: params.ownerType,
    ownerId: params.ownerId,
    accountRowId: params.accountRowId,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a state token and return its claims.
 *
 * @throws `validationError` when the token is malformed, the signature does not
 *   match (compared in constant time), or it has expired.
 */
export function verifyOnboardingState(token: string): OnboardingStateClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw validationError('Malformed onboarding state');
  }
  const [payloadB64, providedSig] = parts;
  if (!verifySecret(providedSig, sign(payloadB64))) {
    throw validationError('Onboarding state signature mismatch');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw validationError('Unreadable onboarding state payload');
  }

  const parsed = statePayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw validationError('Invalid onboarding state payload');
  }
  if (parsed.data.exp <= Date.now()) {
    throw validationError('Onboarding state expired');
  }

  return {
    ownerType: parsed.data.ownerType,
    ownerId: parsed.data.ownerId,
    accountRowId: parsed.data.accountRowId,
  };
}
