/**
 * The merchant-claim challenge token: random, hashed at rest, single-use,
 * scoped and short-lived (issue #83, "Verification methods").
 *
 * Each of those five words is a different mechanism and only one of them lives
 * in this file:
 *
 *  - **random** — 32 CSPRNG bytes, here.
 *  - **hashed at rest** — the server keeps the hex SHA-256 and never the
 *    plaintext, here. No pepper, for `guest_sessions.token_hash`'s reason: 256
 *    bits of preimage entropy is neither invertible nor dictionary-attackable,
 *    and a pepper makes every stored hash unverifiable the day it rotates.
 *  - **single-use** — the partial unique on `(claim_id) WHERE closed_at IS
 *    NULL` plus a compare-and-swap on `closed_at`, in the schema and the
 *    repository.
 *  - **scoped** — the row the digest resolves to names its OWN claim and its
 *    own subject, so a token published on one domain cannot verify a claim
 *    about another (issue acceptance 3).
 *  - **short-lived** — `expires_at`, `MERCHANT_CLAIM_CHALLENGE_TTL_MINUTES`.
 *
 * ## Comparison is by digest LOOKUP, and the accept decision is constant-time
 *
 * Resolution narrows on the unique index over `token_hash` — one indexed
 * equality on an irreversible digest, the `guest_sessions` shape. Where a
 * caller PRESENTS a token (`role_email`) the accept decision is then re-made
 * with `verifySecret` against the digest the row carries, so the code path
 * that says yes never compares secrets with `!==`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';

/** Human-visible marker + namespace for every merchant-claim challenge token. */
const TOKEN_PREFIX = 'mcc_';

/** Random secret length in bytes. */
const TOKEN_RANDOM_BYTES = 32;

/** Total plaintext length: `mcc_` + 43 base64url characters of 32 bytes. */
const TOKEN_LENGTH = TOKEN_PREFIX.length + 43;

/**
 * The DNS label a `dns_txt` challenge is published under. An underscore-led
 * label so it can never collide with a real host, and the same name for every
 * claim so a merchant's operator can find it in their zone file.
 */
export const CLAIM_DNS_RECORD_LABEL = '_mercaria-challenge';

/** The path a `well_known_file` challenge must be served from. */
export const CLAIM_WELL_KNOWN_PATH = '/.well-known/mercaria-merchant-verification.txt';

/** The `name` attribute a `meta_tag` challenge must carry. */
export const CLAIM_META_TAG_NAME = 'mercaria-merchant-verification';

/** A freshly minted token and the digest that is all the server keeps. */
export interface MintedChallengeToken {
  /** Returned to the claimant exactly once, at issuance. */
  token: string;
  /** Hex SHA-256 — the stored form. */
  tokenHash: string;
}

/** The irreversible hex SHA-256 of a value — the stored form of a token. */
export function hashChallengeToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Mint one challenge token. The plaintext exists only in the caller's frame. */
export function mintChallengeToken(): MintedChallengeToken {
  const token = TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
  return { token, tokenHash: hashChallengeToken(token) };
}

/**
 * Shape gate for a presented token — refuses obvious garbage before any
 * database work, the `channel-key.service.verifyKey` opening.
 */
export function hasChallengeTokenShape(raw: string): boolean {
  return raw.startsWith(TOKEN_PREFIX) && raw.length === TOKEN_LENGTH;
}

/**
 * Whether a presented token matches a stored digest, compared in constant
 * time. Never `!==`, and never a bare database equality as the ACCEPT
 * decision — the lookup narrows, this decides.
 */
export function challengeTokenMatches(presented: string, storedHash: string): boolean {
  return verifySecret(hashChallengeToken(presented), storedHash);
}
