/**
 * The guest commerce identity domain — `guest_sessions` (ADR 0003 D3, #103).
 *
 * A guest session is Mercaria's own first-party credential for a signed-out
 * buyer. It is NOT Oxy identity — no synthetic Oxy account exists behind it,
 * and its id must be structurally incapable of appearing where an Oxy id is
 * expected (ADR 0003 I1): it lives only in guest-named columns, and
 * `CommerceActor` deliberately has no common `id` field to alias through.
 *
 * ## The token is never stored — only its SHA-256
 *
 * The credential is `mgs_` + base64url of 32 CSPRNG bytes. The server keeps
 * the hex SHA-256 in `token_hash` and resolves by hash equality on the unique
 * index. No constant-time ceremony and NO pepper/HMAC key, deliberately: the
 * preimage carries 256 bits of entropy, so a leaked hash is not invertible and
 * not dictionary-attackable — and a pepper would make every stored hash
 * unverifiable the day it rotated (ADR 0003 "Environment"). Contrast D12,
 * where dictionary-scale EMAILS get a keyed HMAC for exactly the opposite
 * entropy reason.
 *
 * ## Status is DERIVED, never a column
 *
 * `active | converted | expired | revoked` is computed from the timestamp set
 * (`services/guest-session.service.ts`). A status column beside those
 * timestamps would be two representations of one fact — the same reason
 * `provider_accounts` has no `ready` boolean beside `onboarding_state`, and
 * the place it must not happen is a resolver admitting a revoked session
 * because a flag was stale.
 *
 * ## Expiry is two different mechanisms on purpose
 *
 * `expires_at` is the ABSOLUTE deadline (90 days), the only one stored. Idle
 * expiry (30 days from `last_seen_at`) is enforced by the resolver, so the two
 * cannot disagree (D3). Purge is the shared expiry sweep, 7 days after
 * expiry or revocation (`db/expiryTargets.ts`) — hard DELETE; the audit trail
 * lives in OTHER tables' correlation text, never by keeping sessions around.
 *
 * ## Rotation is an in-place swap with a 60-second grace
 *
 * Rotation replaces `token_hash` and parks the old hash in
 * `previous_token_hash` with a short deadline, the dual-secret window pattern
 * `STRIPE_WEBHOOK_SECRET_PREVIOUS` already uses, so a burst of in-flight
 * requests does not race the swap.
 *
 * ## The conversion columns are a SEAM for #104/#109
 *
 * `converted_at` + `converted_to_oxy_user_id` are stamped only by the cart
 * merge (#104) and claim (#109) transactions, which also set `revoked_at`
 * (sign-in REVOKES a guest session rather than upgrading it — D3). They are
 * audit only: no read path resolves a session through them, and the Oxy id
 * carries no foreign key (Oxy owns identity; `db/deferredForeignKeys.ts`).
 *
 * What is deliberately ABSENT: email, address, payment method, device
 * fingerprint, locale/market/currency preferences (a guest's presentment
 * currency rides the request and falls back to FAIR — D8), and any `scope`
 * column (scope is structural: `mgs_` tokens resolve only in the commerce
 * resolver — D3).
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { GUEST_CLIENT_CLASSES } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/** `guest_sessions` — one row per issued guest credential. */
export const guestSessions = pgTable(
  'guest_sessions',
  {
    id: generatedId(),
    /** Hex SHA-256 of the active bearer token. NEVER the plaintext. */
    tokenHash: text().notNull(),
    /** The pre-rotation hash, honoured only until `previousTokenExpiresAt`. */
    previousTokenHash: text(),
    /** Grace deadline for `previousTokenHash` (60 s after rotation). */
    previousTokenExpiresAt: timestamptz(),
    /** The surface the session was issued to. Audit only, never authorization. */
    clientClass: text({ enum: asEnumValues(GUEST_CLIENT_CLASSES) }).notNull(),
    /** Written at ≥ 60 s granularity to bound write amplification (D3). */
    lastSeenAt: timestamptz().notNull(),
    /** When the token was last rotated; NULL before the first rotation. */
    rotatedAt: timestamptz(),
    /** ABSOLUTE deadline. Idle expiry is the resolver's, not a column. */
    expiresAt: timestamptz().notNull(),
    /** Set by merge (#104), "secure my access", or an operator. */
    revokedAt: timestamptz(),
    /** Stamped by the #104/#109 merge/claim transaction. Audit only. */
    convertedAt: timestamptz(),
    /** An Oxy account id — no foreign key (Oxy owns identity). Audit only. */
    convertedToOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Resolution is ONE indexed lookup by hash. Unique so one presented token
    // can never name two sessions — the structural half of "concurrent
    // requests cannot create several active sessions for one token".
    uniqueIndex('guest_sessions_token_hash_key').on(t.tokenHash),
    // The rotation-grace lookup. Partial: only rows inside a grace window
    // carry a previous hash, so the index stays the size of the real set.
    index('guest_sessions_previous_token_hash_idx')
      .on(t.previousTokenHash)
      .where(sql`${t.previousTokenHash} is not null`),
    // Both purge columns need a leading btree index or the retention sweep is
    // a full scan every hour — enforced against the real catalogue by
    // `findUnsupportedExpiryColumns` in `schema.realdb.test.ts`.
    index('guest_sessions_expires_at_idx').on(t.expiresAt),
    index('guest_sessions_revoked_at_idx')
      .on(t.revokedAt)
      .where(sql`${t.revokedAt} is not null`),
    checkOneOf('guest_sessions_client_class_check', t.clientClass, GUEST_CLIENT_CLASSES),
    // A parked previous hash and its deadline exist together or not at all.
    check(
      'guest_sessions_previous_token_check',
      sql`num_nonnulls(${t.previousTokenHash}, ${t.previousTokenExpiresAt}) in (0, 2)`,
    ),
    // The conversion audit pair exists together or not at all.
    check(
      'guest_sessions_conversion_check',
      sql`num_nonnulls(${t.convertedAt}, ${t.convertedToOxyUserId}) in (0, 2)`,
    ),
    // Sign-in REVOKES the session in the same transaction that converts it
    // (ADR 0003 D3) — a converted-but-live session is unrepresentable.
    check(
      'guest_sessions_converted_revoked_check',
      sql`${t.convertedAt} is null or ${t.revokedAt} is not null`,
    ),
  ],
);
