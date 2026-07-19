/**
 * OAuth `state` — a stateless, signed, expiring CSRF token.
 *
 * The connect route mints a `state` bound to the initiating {store, provider,
 * user, shop} plus a random nonce and short expiry, HMAC-SHA256-signed with
 * `CONNECTOR_OAUTH_STATE_SECRET`. The public callback re-validates the signature
 * (constant-time via `verifySecret`) and expiry before creating any connection,
 * so an attacker cannot forge the `storeId` the callback writes to.
 *
 * It is stateless (no server-side store), which keeps it multi-instance-safe
 * without a shared cache. It is NOT single-use — binding the flow to the browser
 * session would additionally defeat a replay/login-CSRF within the token's short
 * window; that hardening is deferred to the deploy phase (see HANDOFF).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import { z } from 'zod';
import type { ConnectorProviderId } from '@mercaria/shared-types';
import { getOAuthStateSecret } from './config.js';
import { validationError } from '../lib/errors/error-codes.js';

/** How long a minted state is valid (10 minutes — an OAuth round-trip is seconds). */
const STATE_TTL_MS = 10 * 60 * 1000;

/** The signed claims carried in an OAuth state token. */
const statePayloadSchema = z.object({
  /** Mercaria store the connection will be written to. */
  storeId: z.string().min(1),
  /** Platform being connected. */
  provider: z.string().min(1),
  /** The Oxy user who initiated the connect (audit / future session binding). */
  userId: z.string().min(1),
  /** The external shop host the flow is for. */
  shopDomain: z.string().min(1),
  /** Random per-flow nonce. */
  nonce: z.string().min(1),
  /** Expiry (epoch ms). */
  exp: z.number().int().positive(),
});

/** The validated claims returned by {@link verifyOAuthState}. */
export interface OAuthStateClaims {
  storeId: string;
  provider: ConnectorProviderId;
  userId: string;
  shopDomain: string;
}

/** base64url-encode a UTF-8 string. */
function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** HMAC-SHA256 the payload with the state secret, base64url-encoded. */
function sign(payloadB64: string): string {
  return createHmac('sha256', getOAuthStateSecret()).update(payloadB64).digest('base64url');
}

/**
 * Mint a signed `state` token for an OAuth connect flow. The `<payload>.<sig>`
 * form is opaque to the platform and echoed back on the callback.
 */
export function createOAuthState(params: {
  storeId: string;
  provider: ConnectorProviderId;
  userId: string;
  shopDomain: string;
}): string {
  const payload = {
    storeId: params.storeId,
    provider: params.provider,
    userId: params.userId,
    shopDomain: params.shopDomain,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a `state` token and return its claims. Throws `validationError` when
 * the token is malformed, the signature does not match (constant-time), or it
 * has expired.
 */
export function verifyOAuthState(token: string): OAuthStateClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw validationError('Malformed OAuth state');
  }
  const [payloadB64, providedSig] = parts;
  if (!verifySecret(providedSig, sign(payloadB64))) {
    throw validationError('OAuth state signature mismatch');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw validationError('Unreadable OAuth state payload');
  }

  const parsed = statePayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw validationError('Invalid OAuth state payload');
  }
  if (parsed.data.exp <= Date.now()) {
    throw validationError('OAuth state expired');
  }

  return {
    storeId: parsed.data.storeId,
    provider: parsed.data.provider as ConnectorProviderId,
    userId: parsed.data.userId,
    shopDomain: parsed.data.shopDomain,
  };
}
