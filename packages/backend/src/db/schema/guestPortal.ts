/**
 * The guest order portal — ADR 0003 D5/D11/D15/D17, #108.
 *
 * Five tables: `guest_order_access_grants`, `guest_portal_messages`,
 * `guest_contact_suppressions`, `guest_recovery_attempts` and
 * `guest_portal_operator_actions`. They sit ON TOP of `guest_checkouts` (#105)
 * and add nothing to it — the contact stays one row per checkout group, and
 * this domain reads it without ever copying an address out.
 *
 * ## The one property the schema exists to hold
 *
 * **A credential names exactly ONE `checkout_group_id`.** There is no column
 * anywhere below that could describe a grant over an inbox, an email hash, an
 * order number or a person, so "an email address is not a password" is not a
 * check somebody could forget — a request asking for every order at an address
 * has no row shape to be answered from (ADR 0003 I4, T7, T11).
 *
 * ## Two CHECKs carry the verification model
 *
 * `guest_order_access_grants_verification_origin_check` refuses a verification
 * instant on a `post_checkout` row. That is #108 email-verification rules 2 and
 * 3 made structural: paying — by card, by wallet, through Stripe Link — cannot
 * mark a Mercaria contact address proven, because the row minted by paying has
 * nowhere to record that it did.
 *
 * `guest_order_access_grants_unverified_scope_check` restricts an unproven
 * grant to {@link UNVERIFIED_GRANTABLE_SCOPES}. Together they mean the strongest
 * thing possession of the paying device can ever buy is a bounded status view,
 * whatever a service does.
 *
 * ## Tokens are stored as hashes, and the hash is PROTECTED
 *
 * `mgx_`/`mgp_` + 32 CSPRNG bytes; the row keeps the hex SHA-256 and nothing
 * else, keyless for the `guest_sessions` reason (a 256-bit random preimage is
 * neither invertible nor dictionary-attackable, and a pepper makes every stored
 * hash unverifiable the day it rotates). `token_hash` is nonetheless registered
 * in `db/protectedColumns.ts`: an irreversible digest handed to a client is an
 * OFFLINE ORACLE to test guesses against, with no rate limit and no log line —
 * the `channel_api_keys.hash` reasoning exactly.
 *
 * ## What is deliberately ABSENT from every table here
 *
 * No email in any form on a grant, a message or an operator action; no postal
 * address; no IP address (`guest_recovery_attempts` holds a coarse network
 * PREFIX, hashed, and is the only table that touches one at all); no user
 * agent, screen metric or any other device characteristic — #108 recovery rule
 * 2 asks for rate limiting "without fingerprinting" and the absence is the
 * enforcement. Nothing here can hold a plaintext token.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  GUEST_CONTACT_SUPPRESSION_REASONS,
  GUEST_ORDER_EXCHANGE_REASONS,
  GUEST_ORDER_GRANT_ORIGINS,
  GUEST_ORDER_GRANT_PURPOSES,
  GUEST_ORDER_SCOPES,
  GUEST_PORTAL_DELIVERY_FAILURES,
  GUEST_PORTAL_MESSAGE_KINDS,
  GUEST_PORTAL_MESSAGE_STATES,
  GUEST_PORTAL_OPERATOR_ACTIONS,
  GUEST_PORTAL_OPERATOR_OUTCOMES,
  GUEST_RECOVERY_LIMIT_AXES,
  UNVERIFIED_GRANTABLE_SCOPES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { guestCheckouts } from './guests';

/** The SQL array literal a containment CHECK compares against. */
function scopeArrayLiteral(scopes: readonly string[]): string {
  return `array[${scopes.map((scope) => `'${scope}'`).join(', ')}]::text[]`;
}

/**
 * `guest_order_access_grants` — every credential that can reach a placed guest
 * order (ADR 0003 D5).
 *
 * ONE table for both the 15-minute single-use `mgx_` exchange token and the
 * 30-day `mgp_` portal credential, because they are the same five facts — a
 * hashed secret, a checkout group, an expiry, a revocation and an inbox proof —
 * differing only in lifetime and carriage. Two tables would be two places to
 * get a liveness rule wrong, and liveness is the whole of the authorization.
 *
 * ## `email_verified_at` is ONE column, not a boolean beside a timestamp
 *
 * ADR 0003 D5 names `email_verified boolean NOT NULL`. This table stores the
 * INSTANT and derives the boolean, which is the same correction #106 made to
 * `guest_checkouts.contact_verified_at` and the reason `guest_sessions` has no
 * status column: two representations of one fact can disagree, and the place
 * that must not happen is a gate admitting a mutation because a flag was stale.
 * The instant is also what a step-up freshness check needs, so the boolean
 * would have had to sit beside it rather than replace it.
 *
 * ## Consumption is a compare-and-swap, and the index is what makes it one
 *
 * An exchange is `UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND
 * consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`,
 * and the empty-vs-one-row result IS the "already used" answer — the moderation
 * dedupe-claim pattern. Two concurrent exchanges of one link therefore mint one
 * portal grant, and a link scanner that follows the URL cannot consume anything
 * because the token never leaves the fragment (T4).
 *
 * ## Retention
 *
 * Both purge columns carry a leading btree index and both are registered in
 * `db/expiryTargets.ts`: exchange rows 24 h past expiry, portal rows 90 days
 * past expiry or revocation (D11) — kept that long because they ARE the audit
 * trail of who could reach what, and there is no second table recording it.
 */
export const guestOrderAccessGrants = pgTable(
  'guest_order_access_grants',
  {
    id: generatedId(),
    /**
     * THE SCOPE. Correlation with no foreign key — there is no
     * `checkout_groups` table; the group is a shared token
     * (`db/deferredForeignKeys.ts`), exactly as `payments.checkout_group_id`
     * and `orders.checkout_group_id` already are.
     */
    checkoutGroupId: text().notNull(),
    /**
     * The `guest_checkouts` row this grant's contact lives on.
     *
     * A REAL foreign key (`RESTRICT`), unlike the group above: both tables are
     * Mercaria's, and the constraint is what makes "a grant always has a
     * contact record to send to" structural rather than a service assumption.
     * `RESTRICT` rather than `CASCADE` because `guest_checkouts` is retained as
     * long as its orders and is never deleted — erasure NULLs its contact
     * columns (D15) and leaves the row, so a cascade would fire only in a state
     * that must never occur, and firing would destroy the access audit.
     */
    guestCheckoutId: text()
      .notNull()
      .references(() => guestCheckouts.id, { onDelete: 'restrict' }),
    /** Hex SHA-256 of the bearer token. NEVER the plaintext. */
    tokenHash: text().notNull(),
    /** The credential's SHAPE — `exchange` or `portal` (ADR 0003 D5). */
    purpose: text({ enum: asEnumValues(GUEST_ORDER_GRANT_PURPOSES) }).notNull(),
    /** How it was obtained — proof of a DEVICE or proof of an INBOX. */
    createdVia: text({ enum: asEnumValues(GUEST_ORDER_GRANT_ORIGINS) }).notNull(),
    /**
     * WHY an exchange token was minted (#108's own `purpose`). NULL on portal
     * rows: a portal credential's reason for existing is `created_via`, and
     * copying the exchange's reason forward would be a second, staler account
     * of one event.
     */
    exchangeReason: text({ enum: asEnumValues(GUEST_ORDER_EXCHANGE_REASONS) }),
    /**
     * Exactly what this credential may do. Bound SERVER-side at mint time from
     * `services/guest-portal/scopes.ts`, never from a URL parameter or a
     * request body (#108 magic-link rule 7) — no route accepts a scope at all.
     */
    scopes: text().array().notNull(),
    /**
     * WHEN a consumed magic link proved control of the contact inbox; NULL
     * means it never did. The derived boolean is `email_verified_at IS NOT
     * NULL`; see the table docblock for why there is no column beside it.
     */
    emailVerifiedAt: timestamptz(),
    /** Exchange: 15 minutes. Portal: 30 days (`GUEST_PORTAL_GRANT_DAYS`). */
    expiresAt: timestamptz().notNull(),
    /** Single use. Exchange rows only — a portal credential is presented many times. */
    consumedAt: timestamptz(),
    /** Set by "secure my access", by a claim (D14), by a rotation, or by an operator. */
    revokedAt: timestamptz(),
    /**
     * The last time this credential authorized a request, at ≥ 60 s
     * granularity — the `guest_sessions.last_seen_at` bound on write
     * amplification. Audit only: portal expiry is ABSOLUTE and nothing here
     * slides it, so a stolen credential's window cannot be extended by using it.
     */
    lastUsedAt: timestamptz(),
    /**
     * When the retention sweep may DELETE this row — ADR 0003 D11's two
     * different windows, as a column.
     *
     * The ADR gives exchange rows 24 h past expiry and portal rows 90 days past
     * expiry or revocation, and `ExpirySweepTarget` is `{table, column,
     * retentionSeconds}` with no filter — so a single registry entry cannot
     * express two retentions over one table. This is the `notifications`
     * resolution from `db/expiryTargets.ts` reused verbatim: **the condition
     * becomes a column**, stamped by the writer that knows the purpose, and the
     * registry entry is `retentionSeconds: 0` because the column IS the
     * deadline.
     *
     * Stamped at insert from `expires_at` and never advanced, the
     * `moderation_outboxes` decision. Revocation therefore does not pull the
     * deadline in, which is the safe direction: a revoked portal grant is kept
     * at least as long as the ADR asks, and the row is the ONLY record that it
     * ever existed — there is no second table logging who could reach what.
     */
    purgeAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Resolution is ONE indexed lookup by hash, across both purposes — a `mgx_`
    // presented to the portal resolver and a `mgp_` presented to the exchange
    // both fail their shape gate before reaching here, so one index is enough
    // and one presented token can never name two grants.
    uniqueIndex('guest_order_access_grants_token_hash_key').on(t.tokenHash),
    // "Which credentials can reach this group?" — the revoke-all sweep, the
    // operator trace, and the supersede pass on a new recovery link.
    index('guest_order_access_grants_group_idx').on(t.checkoutGroupId, t.createdAt.desc()),
    // The purge column needs a leading btree or the retention sweep is a full
    // scan; `findUnsupportedExpiryColumns` checks this against the real
    // catalogue rather than trusting the convention.
    index('guest_order_access_grants_purge_at_idx').on(t.purgeAt),
    checkOneOf('guest_order_access_grants_purpose_check', t.purpose, GUEST_ORDER_GRANT_PURPOSES),
    checkOneOf(
      'guest_order_access_grants_created_via_check',
      t.createdVia,
      GUEST_ORDER_GRANT_ORIGINS,
    ),
    checkOneOf(
      'guest_order_access_grants_exchange_reason_check',
      t.exchangeReason,
      GUEST_ORDER_EXCHANGE_REASONS,
    ),
    checkEveryElementOf('guest_order_access_grants_scopes_check', t.scopes, GUEST_ORDER_SCOPES),
    // A credential that may do NOTHING is not a credential; it is a row that
    // would pass every liveness check and then answer 403 to everything, which
    // reads in a trace exactly like a scope bug.
    //
    // `cardinality` and NOT `array_length(scopes, 1)`: on an EMPTY array
    // `array_length` returns NULL, `NULL >= 1` is NULL, and a CHECK treats NULL
    // as SATISFIED — so the obvious spelling admits exactly the row it was
    // written to refuse, silently. Caught by `guest-portal.realdb.test.ts`,
    // which is the second thing that suite found on its first run and the
    // reason a constraint without a real server behind it is a comment.
    check('guest_order_access_grants_scopes_present_check', sql`cardinality(${t.scopes}) >= 1`),
    // The two halves of the reason column, stated as a biconditional rather
    // than as two implications: an exchange with no reason cannot say why a
    // link was sent, and a portal row carrying one is claiming an origin it
    // does not have.
    check(
      'guest_order_access_grants_exchange_reason_shape_check',
      sql`(${t.purpose} = 'exchange') = (${t.exchangeReason} is not null)`,
    ),
    // An exchange token exists only inside a link Mercaria mailed. There is no
    // other carriage for one, so `post_checkout` beside `exchange` would
    // describe a credential no code path can produce.
    check(
      'guest_order_access_grants_exchange_origin_check',
      sql`${t.purpose} = 'portal' or ${t.createdVia} = 'magic_link'`,
    ),
    // Single use belongs to exchange rows. A consumed PORTAL row would be a
    // credential in an undefined state — still live by expiry, refused by a
    // consumption check nobody wrote.
    check(
      'guest_order_access_grants_consumed_shape_check',
      sql`${t.consumedAt} is null or ${t.purpose} = 'exchange'`,
    ),
    // #108 email-verification rules 2 and 3, structurally: a credential minted
    // by PAYING can never carry an inbox proof. See the table docblock.
    check(
      'guest_order_access_grants_verification_origin_check',
      sql`${t.emailVerifiedAt} is null or ${t.createdVia} = 'magic_link'`,
    ),
    // ADR 0003 D17's line between prospective and retrospective, as a CHECK: an
    // unproven PORTAL credential may hold only the bounded tracking scope.
    //
    // Restricted to `portal` rows, and the exemption is the point rather than a
    // loophole. An `exchange` row's scopes are a PROMISE — what the credential
    // it mints will carry — and an exchange token can read nothing at all: the
    // only statement that accepts one CONSUMES it. Applying the rule to it
    // would make a verified recovery link impossible to mint, since every such
    // link necessarily promises `orders:read` while being, by definition, not
    // yet exchanged. Caught by `guest-portal.realdb.test.ts` on its first run,
    // which is the case for keeping these constraints under a real server.
    check(
      'guest_order_access_grants_unverified_scope_check',
      sql`${t.purpose} = 'exchange'
          or ${t.emailVerifiedAt} is not null
          or ${t.scopes} <@ ${sql.raw(scopeArrayLiteral(UNVERIFIED_GRANTABLE_SCOPES))}`,
    ),
    // A row cannot be purged while it can still authorize anything. Stated as a
    // strict inequality rather than trusting the writer's arithmetic, because
    // the failure — a live credential swept mid-window — would present as a
    // buyer's portal logging itself out for no reason anyone could reproduce.
    check('guest_order_access_grants_purge_after_expiry_check', sql`${t.purgeAt} > ${t.expiresAt}`),
  ],
);

/**
 * `guest_portal_messages` — the durable transactional-message queue.
 *
 * The moderation outbox, ported once more, and for the same reason: a message
 * that must be sent because an order was paid has to survive the process that
 * decided to send it. The row IS the job — there is no second table pointing at
 * a message — claims are leases with an owner check
 * (`FOR UPDATE SKIP LOCKED`), backoff is capped, and `dead_letter` is visible
 * rather than silent.
 *
 * ## The id is DETERMINISTIC, and that is the whole of "duplicate webhooks
 * converge on one message"
 *
 * `guest_portal_messages.id` has no default. The caller supplies
 * `guest-msg:<kind>:<dedupeKey>`, so a redelivered `payment_intent.succeeded`,
 * a reconciliation sweep re-deriving the same fact, and two ECS tasks racing
 * all collide on the primary key and `ON CONFLICT DO NOTHING` writes nothing at
 * all — no tuple version, no timestamp, no lock (#108 initial-confirmation rule
 * 7). A `DO UPDATE` "writing the same values" would still move `updated_at` and
 * the row's `xmin`, which is why the realdb test asserts both.
 *
 * ## What a message row does NOT hold
 *
 * No recipient address, in any form — the send path decrypts
 * `guest_checkouts.email_ciphertext` at the moment of sending and never writes
 * it down, so a queue that backs up is not a mailing list. No subject line and
 * no body: the TEMPLATE is code (`services/guest-portal/templates.ts`) and the
 * row names a kind, so a locale change or a copy fix applies to queued messages
 * instead of freezing whatever the enqueuing process happened to render. And no
 * token: a link-bearing message mints its `mgx_` grant inside the send
 * transaction, so the plaintext never rests in a queue row.
 */
export const guestPortalMessages = pgTable(
  'guest_portal_messages',
  {
    /** DETERMINISTIC, caller-supplied — deliberately no default. See the docblock. */
    id: text().primaryKey(),
    /** Correlation with no foreign key; the group is a shared token. */
    checkoutGroupId: text().notNull(),
    /**
     * Whose contact this is addressed to. A real foreign key (`RESTRICT`) for
     * the `guest_order_access_grants` reason: the send path needs the contact,
     * and a message with no contact record is unsendable by construction rather
     * than at attempt time.
     */
    guestCheckoutId: text()
      .notNull()
      .references(() => guestCheckouts.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(GUEST_PORTAL_MESSAGE_KINDS) }).notNull(),
    /**
     * The ORDER this message is about, when it is about one.
     *
     * Correlation text with no foreign key, and NULL for group-level messages
     * (a confirmation, an access link). #108's notification requirement that
     * templates "distinguish seller-specific orders while providing one
     * checkout-level entry point" is exactly this column being nullable: a
     * shipping notice names one seller's order, and every message links to the
     * group's portal.
     */
    orderId: text(),
    /**
     * BCP-47, snapshotted from `guest_checkouts.locale` at enqueue.
     *
     * Snapshotted rather than joined, because the language a person asked to be
     * written to in is a property of the checkout they made, and a later
     * checkout in another language must not retranslate a message already
     * queued about this one.
     */
    locale: text(),
    state: text({ enum: asEnumValues(GUEST_PORTAL_MESSAGE_STATES) })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /**
     * Why the last attempt failed — a BOUNDED code, never a provider's error
     * string. A transport's own message is somebody else's vocabulary and
     * routinely quotes the recipient address, which is the one value this
     * domain spends three columns keeping out of reach.
     */
    lastFailure: text({ enum: asEnumValues(GUEST_PORTAL_DELIVERY_FAILURES) }),
    sentAt: timestamptz(),
    /**
     * Set at insert and never advanced, so a row that never reaches a terminal
     * state still leaves — the `moderation_outboxes` decision, with the same
     * consequence stated: a dispatcher down for the whole window loses its
     * backlog silently, and what surfaces that is the ORDER, which is still
     * there and still readable in the portal.
     */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('guest_portal_messages_kind_check', t.kind, GUEST_PORTAL_MESSAGE_KINDS),
    checkOneOf('guest_portal_messages_state_check', t.state, GUEST_PORTAL_MESSAGE_STATES),
    checkOneOf(
      'guest_portal_messages_last_failure_check',
      t.lastFailure,
      GUEST_PORTAL_DELIVERY_FAILURES,
    ),
    check('guest_portal_messages_attempts_check', sql`${t.attempts} >= 0`),
    // A `sent` row has an instant and nothing else does. Without this, a
    // dead-lettered message could carry a send timestamp and the operator trace
    // would report a delivery that never happened.
    check(
      'guest_portal_messages_sent_at_check',
      sql`(${t.state} = 'sent') = (${t.sentAt} is not null)`,
    ),
    // The claim query is the moderation outbox's two-branch `or`: due pending
    // work, and sending work whose lease expired (a dead task's, reclaimed).
    index('guest_portal_messages_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    index('guest_portal_messages_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.state} = 'sending'`),
    // The operator trace opens from a checkout group; nothing enumerates by
    // kind or by recipient, and there is no recipient column to enumerate by.
    index('guest_portal_messages_group_idx').on(t.checkoutGroupId, t.createdAt.desc()),
    index('guest_portal_messages_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `guest_contact_suppressions` — inboxes Mercaria has stopped writing to.
 *
 * Keyed on the email HMAC and never on the address (D12), so the table answers
 * "may I send to this inbox" without being able to say which inbox it is: a
 * leak of the whole suppression list discloses no addresses, and the send path
 * needs no more than a yes or no. `email_hash` is registered in
 * `db/protectedColumns.ts` for the reason every keyed digest in this schema is
 * — it is an exact-match ORACLE, not merely irreversible.
 *
 * ## Suppression is a fact about an ADDRESS, not about an order
 *
 * One row per hash, unique, with no checkout group. A hard bounce means the
 * mailbox does not exist and no order changes that; a complaint means its owner
 * asked Mercaria to stop and scoping the request to one purchase would be
 * answering a different question than the one they asked. The consequence is
 * stated rather than hidden: a suppressed address makes every future message to
 * it terminal (`suppressed`, never retried), and the ORDER stays fully readable
 * in the portal — #108 privacy rule 5, "handle bounces, suppression and
 * complaints without losing the order record".
 *
 * ## Nothing here expires
 *
 * A hard bounce does not heal on a schedule, and a person who complained did not
 * consent again by waiting. Lifting one is an explicit act with a stored
 * `lifted_at`, `lifted_by_oxy_user_id` and reason — the recall-lift shape from
 * retail eligibility.
 */
export const guestContactSuppressions = pgTable(
  'guest_contact_suppressions',
  {
    id: generatedId(),
    /** HMAC-SHA-256 of the NORMALIZED address under `GUEST_EMAIL_HASH_KEY`. */
    emailHash: text().notNull(),
    reason: text({ enum: asEnumValues(GUEST_CONTACT_SUPPRESSION_REASONS) }).notNull(),
    /** The Oxy operator who lifted it. No foreign key — Oxy owns identity. */
    liftedByOxyUserId: text(),
    liftedAt: timestamptz(),
    /** Why it was lifted. Free text, operator-authored, never a recipient value. */
    liftReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One LIVE suppression per address; a lifted one stays as history. Partial,
    // so two operators suppressing the same bouncing address converge on one
    // row rather than racing — the `retail_suppressions` device.
    uniqueIndex('guest_contact_suppressions_email_hash_key')
      .on(t.emailHash)
      .where(sql`${t.liftedAt} is null`),
    checkOneOf(
      'guest_contact_suppressions_reason_check',
      t.reason,
      GUEST_CONTACT_SUPPRESSION_REASONS,
    ),
    // A lift is attributable, dated and explained, or it did not happen.
    check(
      'guest_contact_suppressions_lift_check',
      sql`num_nonnulls(${t.liftedAt}, ${t.liftedByOxyUserId}, ${t.liftReason}) in (0, 3)`,
    ),
  ],
);

/**
 * `guest_recovery_attempts` — durable, cross-task recovery velocity.
 *
 * #108 recovery rule 2 asks for limits by normalized email hash, order
 * reference, IP range and abuse state, and three of those are not questions a
 * per-process Redis bucket can answer: "how often has THIS INBOX been asked
 * for, across every ECS task and every source address" is a fact about the
 * inbox. This is the four-axis model merchant claiming (#83) already uses, with
 * the network axis kept as the per-IP limiter it belongs on and the two durable
 * axes here.
 *
 * ## Every subject is HASHED, and none of them is a fingerprint
 *
 * `subject_hash` is an HMAC under `GUEST_EMAIL_HASH_KEY` of the axis value —
 * the normalized email for `email_hash`, the order number for
 * `order_reference`, the coarse address prefix (IPv4 /24, IPv6 /64) for
 * `network`. So the throttle can count without the table being able to name an
 * address, an order or a client. There is no user agent, no screen metric, no
 * TLS fingerprint and no persistent client identifier of any kind: the absence
 * IS rule 2's "without fingerprinting".
 *
 * ## A row is a WINDOW, not an event
 *
 * One row per (axis, subject, window start), incremented in place. An event log
 * would be a per-inbox activity trail retained for the length of the window,
 * which is precisely the correlation this domain refuses everywhere else.
 */
export const guestRecoveryAttempts = pgTable(
  'guest_recovery_attempts',
  {
    id: generatedId(),
    axis: text({ enum: asEnumValues(GUEST_RECOVERY_LIMIT_AXES) }).notNull(),
    /** Keyed digest of the axis value. Never the value. */
    subjectHash: text().notNull(),
    /** The start of the counting window this row measures. */
    windowStartedAt: timestamptz().notNull(),
    attempts: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The counter's identity. `ON CONFLICT DO UPDATE SET attempts = attempts +
    // 1` on this index is what makes the count race-free across tasks — a
    // read-then-write would let a burst of concurrent requests each read the
    // same value and all pass a limit they collectively exceeded.
    uniqueIndex('guest_recovery_attempts_window_key').on(
      t.axis,
      t.subjectHash,
      t.windowStartedAt,
    ),
    // The purge sweep reads the window start; the counters are worthless once
    // the window has passed and keeping them would be keeping a per-inbox
    // history nobody asked for.
    index('guest_recovery_attempts_window_started_at_idx').on(t.windowStartedAt),
    checkOneOf('guest_recovery_attempts_axis_check', t.axis, GUEST_RECOVERY_LIMIT_AXES),
    check('guest_recovery_attempts_attempts_check', sql`${t.attempts} >= 1`),
  ],
);

/**
 * `guest_portal_operator_actions` — one row per ATTEMPT, refusals included.
 *
 * The `payment_repairs` shape: append-only, a mandatory actor, a mandatory
 * reason, and an outcome that records a refusal rather than swallowing it. #108
 * recovery rule 8 permits operator-assisted recovery "only through audited,
 * narrowly scoped tooling", and this table is the audit half; the narrowness is
 * `GUEST_PORTAL_OPERATOR_ACTIONS` having two members and the request schema
 * having no destination field.
 *
 * A refused attempt is the row worth having. An operator who tried to re-send
 * to a suppressed address, or to a group whose contact was erased, leaves a
 * record either way — and an audit that only recorded successes would answer
 * "did anyone try" with silence.
 */
export const guestPortalOperatorActions = pgTable(
  'guest_portal_operator_actions',
  {
    id: generatedId(),
    /** The group acted on. Correlation with no foreign key. */
    checkoutGroupId: text().notNull(),
    action: text({ enum: asEnumValues(GUEST_PORTAL_OPERATOR_ACTIONS) }).notNull(),
    /** The Oxy operator. No foreign key — Oxy owns identity. Never NULL. */
    actorOxyUserId: text().notNull(),
    /** Why. Mandatory, operator-authored, and never a recipient value. */
    reason: text().notNull(),
    outcome: text({ enum: asEnumValues(GUEST_PORTAL_OPERATOR_OUTCOMES) }).notNull(),
    /**
     * A bounded code when the attempt was refused; NULL when it was performed.
     * Bounded for the `guest_portal_messages.last_failure` reason — a refusal
     * note is read by an operator and must not be able to quote an address.
     */
    refusalCode: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('guest_portal_operator_actions_group_idx').on(t.checkoutGroupId, t.createdAt.desc()),
    checkOneOf(
      'guest_portal_operator_actions_action_check',
      t.action,
      GUEST_PORTAL_OPERATOR_ACTIONS,
    ),
    checkOneOf(
      'guest_portal_operator_actions_outcome_check',
      t.outcome,
      GUEST_PORTAL_OPERATOR_OUTCOMES,
    ),
    // A performed action has nothing to explain; a refused one must say what
    // stopped it, or the audit records that something did not happen without
    // recording why.
    check(
      'guest_portal_operator_actions_refusal_check',
      sql`(${t.outcome} = 'refused') = (${t.refusalCode} is not null)`,
    ),
    check('guest_portal_operator_actions_reason_check', sql`length(btrim(${t.reason})) >= 3`),
  ],
);
