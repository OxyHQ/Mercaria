/**
 * The guest commerce identity domain — `guest_sessions` (ADR 0003 D3, #103)
 * and `cart_merges` (#104).
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
 * #104 filled the seam in: `services/cart-merge.service.ts` is now the only
 * writer of the pair, and `cart_merges` below is the event it records.
 *
 * What is deliberately ABSENT: email, address, payment method, device
 * fingerprint, locale/market/currency preferences (a guest's presentment
 * currency rides the request and falls back to FAIR — D8), and any `scope`
 * column (scope is structural: `mgs_` tokens resolve only in the commerce
 * resolver — D3).
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CART_MERGE_REASON_CODES,
  GUEST_CLIENT_CLASSES,
  GUEST_CONTACT_VERIFICATION_STAGES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';

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

/**
 * `cart_merges` — the durable, append-only record of one guest→Oxy cart merge
 * (#104, ADR 0003 D3 diagram 3).
 *
 * ## `UNIQUE(guest_session_id)` IS the idempotency mechanism
 *
 * #104 asks for "a durable merge operation id OR unique source-session
 * constraint"; this is the second, and it is the stronger of the two because
 * it needs no client cooperation. A merge is a fact about a SESSION — one
 * guest session can be merged exactly once, ever — so the constraint states
 * the invariant instead of trusting a header a retrying native client might
 * regenerate. The merge transaction takes `SELECT … FOR UPDATE` on the session
 * row first, which serializes concurrent attempts; this index is the
 * structural backstop that a lost lock (a new connection, a future refactor)
 * still cannot get past.
 *
 * ## Counts only, never items
 *
 * The row carries six counters and a bounded reason vocabulary and NOTHING
 * else: no listing id, no variant id, no title, no price, no discount code.
 * That is #104 merge requirement 12 ("counts and bounded reason codes, not
 * item-sensitive logs") made structural — an operator reading this table
 * cannot learn what anyone is buying, because there is no column for it.
 *
 * ## Append-only, and that is what makes the counters REPAIRABLE
 *
 * A trigger refuses UPDATE and DELETE (the `order_fee_snapshots` /
 * `payment_repairs` posture). Every counter is written ONCE, inside the merge
 * transaction, computed from what that transaction actually did — so a crashed
 * merge leaves no half-counted row rather than a row to correct. Any aggregate
 * anyone wants is a QUERY over these rows, which is precisely what makes it
 * repairable: recompute it from the events, never patch a stored total.
 *
 * ## Three id columns, no foreign keys, three different reasons
 *
 * `oxy_user_id` is a foreign service's primary key (Oxy owns identity).
 * `guest_session_id` is CORRELATION: the session is hard-deleted by the
 * retention sweep 7 days after the revocation this merge performs, and the
 * audit must outlive it — the same rule `guest_checkouts.guest_session_id`
 * follows (ADR 0003 D4/D11). `target_cart_id` is correlation for the same
 * class of reason: this row records an EVENT, and a cascade from `carts` would
 * let a cart's disappearance erase the history of what was merged into it.
 */
export const cartMerges = pgTable(
  'cart_merges',
  {
    id: generatedId(),
    /** The SOURCE guest session. Correlation, no FK — see the table docblock. */
    guestSessionId: text().notNull(),
    /** The Oxy account the cart merged INTO — no foreign key (Oxy owns identity). */
    oxyUserId: text().notNull(),
    /** The receiving `carts` row. Correlation, no FK — see the table docblock. */
    targetCartId: text().notNull(),
    /** Guest lines with no counterpart, moved across whole. */
    linesAdded: integer().notNull().default(0),
    /** Guest lines whose variant the authenticated cart already held. */
    linesCombined: integer().notNull().default(0),
    /** Lines whose resulting quantity landed below the plain sum. */
    linesClamped: integer().notNull().default(0),
    /** Lines carried across but flagged for the buyer to review. */
    linesFlagged: integer().notNull().default(0),
    /** Guest discount codes added to the authenticated cart's pending set. */
    discountCodesAdded: integer().notNull().default(0),
    /** Guest discount codes that did not survive revalidation. */
    discountCodesDropped: integer().notNull().default(0),
    /** Bounded, deduplicated, sorted reason codes. Never free text. */
    reasons: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('cart_merges_guest_session_id_key').on(t.guestSessionId),
    index('cart_merges_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    checkEveryElementOf('cart_merges_reasons_check', t.reasons, CART_MERGE_REASON_CODES),
    check(
      'cart_merges_counts_check',
      sql`${t.linesAdded} >= 0 and ${t.linesCombined} >= 0 and ${t.linesClamped} >= 0
          and ${t.linesFlagged} >= 0 and ${t.discountCodesAdded} >= 0
          and ${t.discountCodesDropped} >= 0`,
    ),
  ],
);

/**
 * `guest_checkouts` — ONE contact identity per checkout GROUP (ADR 0003 D4,
 * #105).
 *
 * This row is the reason guest commerce survives the credential that started
 * it. A `guest_sessions` row is purged 7 days after it expires; a placed order
 * is retained for the statutory commercial window. Between those two facts sits
 * the question "who do we send this receipt to, in three weeks, after the
 * session is gone" — and the answer is a durable row correlated by
 * `checkout_group_id`, which is exactly what the payment path already keys on
 * (`payments.checkout_group_id`). Nothing in the paid path reads
 * `guest_sessions` (ADR 0003 diagram 6, ADR 0006 G9), and this table is why it
 * does not have to.
 *
 * ## One per GROUP, never one per order
 *
 * `guest_checkouts_checkout_group_id_key`. A multi-seller cart splits into
 * sibling orders that share a `checkout_group_id`, and they share this contact
 * too — copying it onto each order would be two representations of one fact,
 * which is the shape this schema refuses everywhere. Each ORDER still carries
 * its own immutable FULFILMENT snapshot (`shipping_address_*`,
 * `shipping_method`), because those genuinely can differ per seller; the
 * contact cannot.
 *
 * ## Three forms of one email, three different jobs (ADR 0003 D12)
 *
 * `email_ciphertext` is AES-256-GCM under `GUEST_PII_ENCRYPTION_KEY`, key-id
 * prefixed, and is the only form a transactional mail can be sent to.
 * `email_hash` is HMAC-SHA-256 under the SEPARATE `GUEST_EMAIL_HASH_KEY` —
 * keyed, unlike this schema's token hashes, because an email has
 * dictionary-scale entropy and a plain hash column would be offline-reversible
 * the day the table leaked. `email_redacted` (`j***@example.com`) is the only
 * form a support surface ever renders (T15). All three are registered in
 * `db/protectedColumns.ts`, so a whole-row select cannot ship them.
 *
 * `email_hash` has exactly TWO permitted uses and neither is implemented here:
 * routing a magic-link request to its checkouts (#108) and abuse velocity
 * counting. It is NEVER an authorization input (I2/I4) and never a join key to
 * an Oxy account (I6) — and #105 correspondingly exposes no projection field
 * for it and no endpoint that takes one.
 *
 * ## The `guest_session_id` correlation has NO foreign key, on purpose
 *
 * Sessions are hard-deleted by the retention sweep and this row must outlive
 * them — the same rule `cart_merges.guest_session_id` follows, recorded in
 * `db/deferredForeignKeys.ts`.
 *
 * ## What is deliberately ABSENT
 *
 * No name, no address (that is the ORDER's fulfilment snapshot, which sellers
 * see and this does not), no payment detail, no IP, no device fingerprint, no
 * Oxy user id in any form, and no referral or partner column — attribution is
 * #142/#143's own model and can never be derived from a contact (#105 privacy
 * rule 9). There is no `status` column either: whether a checkout completed is
 * a property of its ORDERS.
 */
export const guestCheckouts = pgTable(
  'guest_checkouts',
  {
    id: generatedId(),
    /**
     * The checkout group this contact belongs to. Correlation with no foreign
     * key — there is no `checkout_groups` table; the group is a shared token
     * (`db/deferredForeignKeys.ts`).
     */
    checkoutGroupId: text().notNull(),
    /** The session that placed it. Correlation only — see the docblock. */
    guestSessionId: text().notNull(),
    /** AES-256-GCM, `v1:`-prefixed. NULL only after anonymization (D15). */
    emailCiphertext: text(),
    /** HMAC-SHA-256 of the NORMALIZED address. NULL only after anonymization. */
    emailHash: text(),
    /** `j***@example.com`, or the literal `deleted` after anonymization. */
    emailRedacted: text().notNull(),
    /** AES-256-GCM contact phone, when the buyer gave one. */
    phoneCiphertext: text(),
    /** `***42`, or absent. */
    phoneRedacted: text(),
    /**
     * Whether the contact inbox was proven before or after the payment, or not
     * at all yet (#105 GuestCheckout rule 8).
     *
     * RECORDED, never enforced: ADR 0003 D17 puts payment deliberately on the
     * pre-verification side of the line. #108 owns the transition.
     */
    contactVerificationStage: text({ enum: asEnumValues(GUEST_CONTACT_VERIFICATION_STAGES) })
      .notNull()
      .default('pending'),
    /**
     * Marketing consent, captured at this checkout.
     *
     * A column of its OWN and defaulting to false, because permission to send a
     * receipt comes from the purchase and permission to market comes from an
     * unticked box the buyer ticked (#105 privacy rules 1-2). Storing them as
     * one field would make every transactional send look like consent to
     * market — and the audit question "did they agree" would have no answer.
     */
    marketingOptIn: boolean().notNull().default(false),
    /** BCP-47, for the language a transactional mail is written in. */
    locale: text(),
    /** ADR 0003 D15's post-payment erasure stamp. */
    anonymizedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ONE contact per group — the structural half of "sibling orders share it".
    uniqueIndex('guest_checkouts_checkout_group_id_key').on(t.checkoutGroupId),
    // #108's magic-link routing walks this. NON-unique: one inbox, many
    // checkouts. Partial, because an anonymized row has no hash to find.
    index('guest_checkouts_email_hash_idx')
      .on(t.emailHash)
      .where(sql`${t.emailHash} is not null`),
    // "Which checkouts did this session place?" — the operator trace, and the
    // read #109's claim will need.
    index('guest_checkouts_guest_session_id_idx').on(t.guestSessionId),
    checkOneOf(
      'guest_checkouts_contact_verification_stage_check',
      t.contactVerificationStage,
      GUEST_CONTACT_VERIFICATION_STAGES,
    ),
    // The two encrypted forms of the email move TOGETHER: a row with ciphertext
    // and no hash could never be found by #108's recovery, and a row with a
    // hash and no ciphertext could be found and not written to. Anonymization
    // clears both, which is why the count is `in (0, 2)` and not `= 2`.
    check(
      'guest_checkouts_email_pair_check',
      sql`num_nonnulls(${t.emailCiphertext}, ${t.emailHash}) in (0, 2)`,
    ),
    // Anonymization is a THREE-column transition and the CHECK states it whole:
    // once `anonymized_at` is set there is no contact left, and while it is
    // NULL there is. Without this, "anonymized" would be a timestamp somebody
    // could set while the ciphertext stayed readable — a deletion record that
    // did not delete.
    check(
      'guest_checkouts_anonymization_check',
      sql`(${t.anonymizedAt} is null and ${t.emailCiphertext} is not null)
          or (${t.anonymizedAt} is not null
              and ${t.emailCiphertext} is null
              and ${t.emailHash} is null
              and ${t.phoneCiphertext} is null
              and ${t.emailRedacted} = 'deleted')`,
    ),
    // The phone's two forms move together, same reasoning as the email pair.
    check(
      'guest_checkouts_phone_pair_check',
      sql`num_nonnulls(${t.phoneCiphertext}, ${t.phoneRedacted}) in (0, 2)`,
    ),
  ],
);
