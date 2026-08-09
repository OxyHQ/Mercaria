/**
 * The two portal credentials, in one place (#108, ADR 0003 D5/I5).
 *
 * `mgx_` — the single-use, 15-minute EXCHANGE token that rides in the fragment
 * of a link Mercaria mails.
 * `mgp_` — the durable PORTAL credential the exchange mints, carried in an
 * `HttpOnly` cookie or `expo-secure-store`.
 *
 * Both are `<prefix>` + base64url of 32 CSPRNG bytes, and the server stores
 * only the hex SHA-256 — `services/guest-session.service.ts`'s decisions
 * verbatim, including the absence of a pepper: a 256-bit random preimage is
 * neither invertible nor dictionary-attackable, and a pepper would make every
 * stored hash unverifiable the day it rotated. (Contrast `guestEmailHash`,
 * which IS keyed, for the opposite entropy reason.)
 *
 * ## Scope is STRUCTURAL, and this file is where that is true
 *
 * ADR 0003 D3 says a `mgs_` cart token resolves only in the commerce resolver
 * and a portal token only in the portal resolver. {@link readPortalToken} and
 * {@link readExchangeToken} are two functions with two anchored patterns, so a
 * cart credential presented to the portal fails its shape gate BEFORE any
 * hashing or database work, and an exchange token presented as a portal
 * credential does too. There is no shared "read any token" helper for a caller
 * to reach for, which is what makes invariant I3 a property of the call graph
 * rather than of a `WHERE purpose = …` somebody could forget.
 *
 * ## The accept decision is constant-time, and the lookup is not the decision
 *
 * Resolution narrows on the unique index over `token_hash` — one indexed
 * equality on an irreversible digest. Where a caller PRESENTS a token, the
 * accept decision is then re-made with `verifySecret` against the digest the
 * row carries, so the code path that says yes never compares secrets with
 * `!==`. That is `services/merchant-claims/challenge-token.ts`'s posture, and
 * it costs one comparison on a path that already did a database round trip.
 */

import { createHash, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';

/** The EXCHANGE token prefix — the one that travels in a link's fragment. */
export const EXCHANGE_TOKEN_PREFIX = 'mgx_';

/** The PORTAL token prefix — the durable credential the exchange mints. */
export const PORTAL_TOKEN_PREFIX = 'mgp_';

/** 32 CSPRNG bytes — 256 bits of entropy (ADR 0003 I5). */
const TOKEN_BYTES = 32;

/** 32 bytes of base64url is exactly 43 characters, unpadded. */
const TOKEN_BODY_LENGTH = 43;

/** Anchored and fixed-length, so garbage costs a length check and nothing more. */
const EXCHANGE_TOKEN_PATTERN = /^mgx_[A-Za-z0-9_-]{43}$/;
const PORTAL_TOKEN_PATTERN = /^mgp_[A-Za-z0-9_-]{43}$/;

/** A freshly minted credential — the ONLY shape a plaintext token travels in. */
export interface MintedPortalCredential {
  /** The plaintext bearer token. Returned once; never stored, never logged. */
  readonly token: string;
  /** Hex SHA-256 of {@link token} — what the database keeps. */
  readonly tokenHash: string;
}

/** Hex SHA-256 of a token — the only form of it that may touch storage or SQL. */
export function hashPortalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint an exchange (`mgx_`) credential. */
export function mintExchangeToken(): MintedPortalCredential {
  const token = EXCHANGE_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashPortalToken(token) };
}

/** Mint a portal (`mgp_`) credential. */
export function mintPortalToken(): MintedPortalCredential {
  const token = PORTAL_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashPortalToken(token) };
}

/**
 * A presented value, if it is a well-formed EXCHANGE token; else `undefined`.
 *
 * Returns the token rather than a boolean so a caller cannot accidentally hash
 * an unchecked string: the only way to obtain the value in a shape this module
 * blesses is to go through the gate.
 */
export function readExchangeToken(value: string | undefined): string | undefined {
  return matches(value, EXCHANGE_TOKEN_PREFIX, EXCHANGE_TOKEN_PATTERN) ? value : undefined;
}

/** A presented value, if it is a well-formed PORTAL token; else `undefined`. */
export function readPortalToken(value: string | undefined): string | undefined {
  return matches(value, PORTAL_TOKEN_PREFIX, PORTAL_TOKEN_PATTERN) ? value : undefined;
}

function matches(
  value: string | undefined,
  prefix: string,
  pattern: RegExp,
): value is string {
  // Length first: the patterns are anchored and linear anyway, but refusing on
  // length keeps the cost of an adversarial megabyte cookie constant.
  if (value === undefined || value.length !== prefix.length + TOKEN_BODY_LENGTH) return false;
  return pattern.test(value);
}

/**
 * Whether a presented token matches a stored digest, compared in constant time.
 *
 * Never `!==`, and never a bare database equality as the ACCEPT decision — the
 * lookup narrows, this decides.
 */
export function portalTokenMatches(presented: string, storedHash: string): boolean {
  return verifySecret(hashPortalToken(presented), storedHash);
}
