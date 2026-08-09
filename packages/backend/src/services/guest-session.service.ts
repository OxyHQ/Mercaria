/**
 * Guest session issuance, resolution, rotation and revocation
 * (ADR 0003 D3, #103).
 *
 * ## The token, in one place
 *
 * `mgs_` + base64url of 32 CSPRNG bytes. The plaintext exists in the issuance
 * response and the client's storage, NOWHERE else: this module hands the
 * repository only the hex SHA-256, returns the plaintext exactly once from
 * {@link issueGuestSession} / {@link rotateGuestSession}, and never logs it.
 * There is no key and no pepper — a 256-bit random preimage needs neither,
 * and a pepper would make every stored hash unverifiable the day it rotated
 * (ADR 0003 "Environment"). Lookup is hash equality on a unique index; no
 * constant-time ceremony is needed for the same entropy reason (D3 —
 * contrast the keyed email HMAC of D12).
 *
 * ## Rejection is UNIFORM
 *
 * Malformed, oversized, unknown, expired, idle-expired, revoked and converted
 * credentials all resolve to the same `null` — a caller (and therefore a
 * network observer) cannot distinguish them (issue #103 "reject expired,
 * revoked or malformed credentials uniformly"). The DISTINCTION lives only in
 * the structured security log, which carries the reason category and the
 * session row id — never the token, in any form.
 *
 * ## Expiry model (D3/D11)
 *
 * `expires_at` is the stored ABSOLUTE deadline (90 days). Idle expiry — 30
 * days from `last_seen_at` — is enforced HERE, so a session kept alive by a
 * crawler still dies at the absolute deadline: sliding extension is bounded
 * by construction, not by a counter. `last_seen_at` advances at ≥ 60 s
 * granularity to bound write amplification.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { GuestClientClass, GuestSessionState, GuestSessionStatus } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDb } from '../db/postgres.js';
import {
  findGuestSessionByTokenHash,
  insertGuestSession,
  revokeGuestSession as repoRevokeGuestSession,
  rotateGuestSessionToken,
  touchGuestSessionLastSeen,
  type GuestSessionRow,
} from '../db/guests/guestSessionRepository.js';
import { log } from '../lib/logger.js';

/** The commerce-session token prefix. Scope is STRUCTURAL (D3): `mgs_` tokens
 * resolve only here; portal (`mgp_`) and exchange (`mgx_`) tokens (#108) will
 * resolve only in their own resolver, and the two tables share nothing. */
export const GUEST_TOKEN_PREFIX = 'mgs_';

/** 32 CSPRNG bytes — 256 bits of entropy (D3, I5). */
const GUEST_TOKEN_BYTES = 32;

/**
 * The EXACT shape of a well-formed token: prefix + 43 base64url chars (32
 * bytes). Anchored and fixed-length, so oversized or malformed credentials
 * are rejected here — before any hashing or database work (issue #103,
 * "reject oversized, malformed and unsupported credentials before expensive
 * work").
 */
const GUEST_TOKEN_PATTERN = /^mgs_[A-Za-z0-9_-]{43}$/;

/** The D3 rotation-grace window for the outgoing hash. */
export const PREVIOUS_TOKEN_GRACE_MS = 60_000;

/** D3: rotation fires every 7 days of activity (besides elevation/operator). */
export const ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

/** D3: `last_seen_at` is written at ≥ 60 s granularity. */
export const LAST_SEEN_GRANULARITY_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A freshly minted credential — the ONLY shape the plaintext ever travels in. */
export interface MintedGuestCredential {
  /** The plaintext bearer token. Returned exactly once; never stored, never logged. */
  token: string;
  /** Hex SHA-256 of {@link token} — what the database keeps. */
  tokenHash: string;
}

/** Generate a fresh guest token and its storage hash. */
export function mintGuestToken(): MintedGuestCredential {
  const token = GUEST_TOKEN_PREFIX + randomBytes(GUEST_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashGuestToken(token) };
}

/** Hex SHA-256 of a token — the only form of it that may touch storage or SQL. */
export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Cheap structural check, run before hashing. Length is pinned exactly, so a
 * megabyte cookie value is refused without reading past the first characters.
 */
export function isWellFormedGuestToken(value: string): boolean {
  // Length first: the regex is anchored and linear anyway, but refusing on
  // length keeps the cost of garbage input constant and obvious.
  if (value.length !== GUEST_TOKEN_PREFIX.length + 43) return false;
  return GUEST_TOKEN_PATTERN.test(value);
}

/** The moment idle expiry strikes a session: `last_seen_at` + the idle window. */
function idleDeadline(session: GuestSessionRow): Date {
  return new Date(session.lastSeenAt.getTime() + config.guest.sessionIdleDays * DAY_MS);
}

/**
 * The DERIVED lifecycle status (never a column — see `db/schema/guests.ts`).
 *
 * Precedence: converted > revoked > expired > active. A converted session is
 * also revoked by CHECK, so `converted` must be asked first or it could never
 * be observed.
 */
export function guestSessionStatus(session: GuestSessionRow, now: Date): GuestSessionStatus {
  if (session.convertedAt !== null) return 'converted';
  if (session.revokedAt !== null) return 'revoked';
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (idleDeadline(session).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** A resolved, LIVE session and how the presented hash matched it. */
export interface ResolvedGuestSession {
  session: GuestSessionRow;
  /**
   * The presented token matched `previous_token_hash` inside the rotation
   * grace — a rotation is in flight for this session, so the presented token
   * is about to die. Rotation-dependent surfaces refuse on this rather than
   * racing the swap.
   */
  matchedPrevious: boolean;
}

/**
 * Resolve a presented token to a live session, or `null` — uniformly.
 *
 * Touches `last_seen_at` (≥ 60 s granularity) on success, which is what makes
 * idle expiry sliding. The extension is bounded by the ABSOLUTE `expires_at`,
 * checked first, so no amount of traffic keeps a session past 90 days.
 */
export async function resolveGuestSessionByToken(
  presented: string,
  now: Date,
): Promise<ResolvedGuestSession | null> {
  if (!isWellFormedGuestToken(presented)) {
    logRejection('malformed');
    return null;
  }

  const hash = hashGuestToken(presented);
  const session = await findGuestSessionByTokenHash(getDb(), hash, now);
  if (!session) {
    logRejection('unknown');
    return null;
  }

  const status = guestSessionStatus(session, now);
  if (status !== 'active') {
    // The row id is the audit handle (D16) — safe to log; the token is not.
    logRejection(status, session.id);
    return null;
  }

  await touchGuestSessionLastSeen(getDb(), session.id, now, LAST_SEEN_GRANULARITY_MS);
  return { session, matchedPrevious: session.tokenHash !== hash };
}

/** Why {@link issueGuestSession} refused — the two config gates. */
export class GuestIssuanceDisabledError extends Error {
  constructor(reason: 'disabled' | 'kill_switch') {
    super(
      reason === 'disabled'
        ? 'Guest commerce is not enabled on this deployment'
        : 'Guest session issuance is temporarily disabled',
    );
    this.name = 'GuestIssuanceDisabledError';
  }
}

/**
 * Mint a session — the LAZY issuance primitive.
 *
 * Callers reach this only from an eligible stateful write or the explicit
 * ensure endpoint, never from a page view (D3: browsing creates NO row), and
 * only behind the per-IP `rl:guest-issue:` rate limit. Both config gates are
 * re-checked here as defence in depth: a route wired past its own gate still
 * cannot mint with the kill switch thrown.
 */
export async function issueGuestSession(input: {
  clientClass: GuestClientClass;
  now: Date;
}): Promise<{ session: GuestSessionRow; token: string }> {
  if (!config.guest.enabled) throw new GuestIssuanceDisabledError('disabled');
  if (!config.guest.issuanceEnabled) throw new GuestIssuanceDisabledError('kill_switch');

  const { token, tokenHash } = mintGuestToken();
  const session = await insertGuestSession(getDb(), {
    tokenHash,
    clientClass: input.clientClass,
    expiresAt: new Date(input.now.getTime() + config.guest.sessionAbsoluteDays * DAY_MS),
    lastSeenAt: input.now,
  });

  log.guest.info(
    { guestSessionId: session.id, clientClass: input.clientClass },
    '[Guest] session issued',
  );
  return { session, token };
}

/** Is the 7-day activity rotation due? Measured from the LAST rotation, else creation. */
export function rotationDue(session: GuestSessionRow, now: Date): boolean {
  const since = session.rotatedAt ?? session.createdAt;
  return now.getTime() - since.getTime() >= ROTATION_INTERVAL_MS;
}

/**
 * Rotate a session's token in place (D3): new token, old hash parked for a
 * 60-second grace.
 *
 * Compare-and-swaps on the session's CURRENT hash, so two concurrent
 * rotations mint exactly one credential; the loser gets `null` and its
 * holder's token still resolves through the grace window.
 */
export async function rotateGuestSession(
  session: GuestSessionRow,
  now: Date,
): Promise<{ session: GuestSessionRow; token: string } | null> {
  const { token, tokenHash } = mintGuestToken();
  const rotated = await rotateGuestSessionToken(getDb(), {
    id: session.id,
    currentTokenHash: session.tokenHash,
    newTokenHash: tokenHash,
    previousTokenExpiresAt: new Date(now.getTime() + PREVIOUS_TOKEN_GRACE_MS),
    now,
  });
  if (!rotated) {
    log.guest.warn({ guestSessionId: session.id }, '[Guest] rotation lost a concurrent race');
    return null;
  }

  log.guest.info({ guestSessionId: session.id }, '[Guest] token rotated');
  return { session: rotated, token };
}

/** Revoke by row id. Idempotent — a second call reports `false`, not an error. */
export async function revokeGuestSession(id: string, now: Date): Promise<boolean> {
  const revoked = await repoRevokeGuestSession(getDb(), id, now);
  if (revoked) {
    log.guest.info({ guestSessionId: id }, '[Guest] session revoked');
  }
  return revoked;
}

/**
 * The SAFE projection (`GuestSessionState`) — what the inspect surface
 * answers. Names every field; carries no hash and no token, by construction.
 */
export function toGuestSessionState(session: GuestSessionRow, now: Date): GuestSessionState {
  return {
    id: session.id,
    status: guestSessionStatus(session, now),
    clientClass: session.clientClass,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    rotatedAt: session.rotatedAt === null ? null : session.rotatedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * The structured security event for a rejected credential (#103 "structured
 * security events … without logging secrets"). The reason category exists for
 * operators; the HTTP answer stays uniform whatever it says.
 */
function logRejection(
  reason: 'malformed' | 'unknown' | 'expired' | 'revoked' | 'converted',
  guestSessionId?: string,
): void {
  log.guest.warn(
    { reason, ...(guestSessionId !== undefined ? { guestSessionId } : {}) },
    '[Guest] credential rejected',
  );
}
