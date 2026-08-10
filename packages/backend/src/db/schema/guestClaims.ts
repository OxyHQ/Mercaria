/**
 * Claiming a guest checkout group into an Oxy account (#109, ADR 0003 D14).
 *
 * Three tables: the claim itself, the audited compensating operation that
 * detaches one, and the durable follow-up work a completed claim owes.
 *
 * ## What the CLAIM row is, and what it is not
 *
 * The authoritative ownership fact lives on `orders`
 * (`claimed_by_oxy_user_id` / `claimed_at`, #106) and this table does NOT
 * duplicate it — that would be two representations of one fact, which this
 * schema refuses everywhere. What the claim row adds is everything the order
 * columns cannot carry: a stable id to cite, which credential proved
 * possession, which policy version required which proofs, how many siblings the
 * claim covered, and the contests and corrections that are not ownership at all.
 *
 * The two never disagree in the direction that matters, because the claim
 * transaction writes both under one lock and
 * `readGuestClaimConsistency` counts the drift a future write path could
 * introduce.
 *
 * ## The partial unique index IS acceptance 8
 *
 * `guest_order_claims_active_group_key` — `UNIQUE(checkout_group_id) WHERE
 * state = 'completed'`. Two accounts racing for one group produce one winner
 * and one refusal FROM THE DATABASE, so "concurrent and conflicting claims
 * cannot silently transfer ownership" does not depend on a service comparison
 * running in the right order. It is the `merchant_claims` device (#83) and the
 * reasoning is identical: the loser lands in a visible contested state rather
 * than replacing the incumbent.
 *
 * A `revoked` row does not occupy the index, which is what lets a corrected
 * group be claimed again — by the rightful buyer, through the ordinary
 * two-sided proof, never by an operator naming an account.
 *
 * ## No contact, no credential, anywhere
 *
 * There is no email column, no hash, no phone, no address and no token in any
 * form. `source_grant_id` is a `guest_order_access_grants` ROW id — an audit
 * handle that authorizes nothing and cannot be presented anywhere, which is
 * exactly why #108's own session projection is willing to carry one.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  GUEST_CLAIM_CONFLICT_REASONS,
  GUEST_CLAIM_OUTBOX_STATES,
  GUEST_CLAIM_OUTBOX_TYPES,
  GUEST_CLAIM_POLICY_VERSION,
  GUEST_CLAIM_REVOCATION_REASONS,
  GUEST_CLAIM_REVOCATION_STATES,
  GUEST_ORDER_CLAIM_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { guestCheckouts } from './guests';

/** How long a bounded failure note on an outbox row may be. */
const MAX_CLAIM_OUTBOX_ERROR_LENGTH = 500;

/** How long an operator's evidence REFERENCE may be. A case number, not a story. */
const MAX_CLAIM_EVIDENCE_REF_LENGTH = 200;

/**
 * `guest_order_claims` — one row per claim ATTEMPT that got past both proofs.
 *
 * A repeat by the SAME account creates nothing: the service reads the existing
 * `completed` row and converges on it, so idempotency is a read plus a unique
 * index rather than an upsert that would have to decide what to overwrite.
 */
export const guestOrderClaims = pgTable(
  'guest_order_claims',
  {
    /** The stable claim id every downstream record cites (#109 claim-model 1). */
    id: generatedId(),
    /**
     * The ONE checkout group claimed. Correlation with no foreign key — there
     * is no `checkout_groups` table; the group is a shared token
     * (`db/deferredForeignKeys.ts`), exactly as `guest_checkouts` records it.
     */
    checkoutGroupId: text().notNull(),
    /**
     * The contact record the group names. A real foreign key (`RESTRICT`), the
     * `guest_portal_messages` decision: a claim of a group with no contact
     * record is unrepresentable rather than refused at execution time, and the
     * contact is what the claim notification is addressed to.
     *
     * `RESTRICT` and not `CASCADE`: ADR 0003 D15 ANONYMIZES a contact rather
     * than deleting it, so nothing legitimate ever removes this parent — and a
     * cascade would make an erasure request quietly delete the audit of who
     * took ownership of a purchase.
     */
    guestCheckoutId: text()
      .notNull()
      .references(() => guestCheckouts.id, { onDelete: 'restrict' }),
    /** The Oxy account the claim moved order ACCESS into. No FK — Oxy owns identity. */
    claimedByOxyUserId: text().notNull(),
    /**
     * The `guest_order_access_grants` row that proved possession (#109
     * claim-model 4).
     *
     * Correlation with NO foreign key, deliberately, and this one is worth
     * stating because a foreign key looks obviously right: grants are hard
     * DELETED by the retention sweep at their own `purge_at`, so a `RESTRICT`
     * would block the purge forever and a `CASCADE` would erase the claim's
     * proof the day the credential aged out. Recorded in
     * `db/deferredForeignKeys.ts` with that reason.
     */
    sourceGrantId: text().notNull(),
    state: text({ enum: asEnumValues(GUEST_ORDER_CLAIM_STATES) }).notNull(),
    /**
     * Which version of the claim policy required which proofs.
     *
     * The `guest_checkouts.contact_policy_version` device: what a claim revokes
     * and what it leaves alone is policy, and a stored claim must say which
     * version produced it rather than being silently reinterpreted later.
     */
    policyVersion: text().notNull().default(GUEST_CLAIM_POLICY_VERSION),
    /** How many sibling orders the claim covered. A claim is group-atomic. */
    orderCount: integer().notNull(),
    /** Present exactly on a `conflicted` row. */
    conflictReason: text({ enum: asEnumValues(GUEST_CLAIM_CONFLICT_REASONS) }),
    /** Present on `completed` and preserved through `revoked`. */
    completedAt: timestamptz(),
    /** Present on `revoked`. */
    revokedAt: timestamptz(),
    /** The operator who executed the detach. No FK — Oxy owns identity. */
    revokedByOxyUserId: text(),
    /** Bounded, never free text — see the shared-types tuple for why. */
    revocationReason: text({ enum: asEnumValues(GUEST_CLAIM_REVOCATION_REASONS) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ACCEPTANCE 8, as an index rather than as a comparison. See the docblock.
    uniqueIndex('guest_order_claims_active_group_key')
      .on(t.checkoutGroupId)
      .where(sql`${t.state} = 'completed'`),
    // The operator trace opens from a checkout group and reads newest first.
    index('guest_order_claims_group_created_at_idx').on(t.checkoutGroupId, t.createdAt.desc()),
    // "What has this account claimed" — the account-history read and the
    // consistency probe's join side.
    index('guest_order_claims_account_created_at_idx').on(
      t.claimedByOxyUserId,
      t.createdAt.desc(),
    ),
    checkOneOf('guest_order_claims_state_check', t.state, GUEST_ORDER_CLAIM_STATES),
    checkOneOf(
      'guest_order_claims_conflict_reason_check',
      t.conflictReason,
      GUEST_CLAIM_CONFLICT_REASONS,
    ),
    checkOneOf(
      'guest_order_claims_revocation_reason_check',
      t.revocationReason,
      GUEST_CLAIM_REVOCATION_REASONS,
    ),
    // A claim is group-atomic and a group with no orders is a 404 before
    // anything is written, so every recorded attempt names at least one order.
    check('guest_order_claims_order_count_check', sql`${t.orderCount} >= 1`),
    /**
     * The three shapes, stated as ONE constraint over the whole row.
     *
     * Written as a disjunction rather than as three implications because the
     * states are mutually exclusive and a set of implications admits a row that
     * satisfies none of them — a `completed` row carrying a revocation reason
     * would pass "revoked ⇒ reason" vacuously.
     *
     * `revoked` keeps `completed_at`: the claim DID happen, and a correction
     * that erased when it happened would be the "delete history" #109
     * revocation rule 4 forbids.
     */
    check(
      'guest_order_claims_state_shape_check',
      sql`(${t.state} = 'completed'
             and ${t.completedAt} is not null
             and ${t.conflictReason} is null
             and num_nonnulls(${t.revokedAt}, ${t.revokedByOxyUserId}, ${t.revocationReason}) = 0)
          or (${t.state} = 'conflicted'
             and ${t.completedAt} is null
             and ${t.conflictReason} is not null
             and num_nonnulls(${t.revokedAt}, ${t.revokedByOxyUserId}, ${t.revocationReason}) = 0)
          or (${t.state} = 'revoked'
             and ${t.completedAt} is not null
             and ${t.conflictReason} is null
             and num_nonnulls(${t.revokedAt}, ${t.revokedByOxyUserId}, ${t.revocationReason}) = 3)`,
    ),
  ],
);

/**
 * `guest_order_claim_revocations` — the audited compensating operation (#109
 * revocation rules 3 and 4).
 *
 * ## Why a table rather than four columns on the claim
 *
 * A revocation is a REQUEST before it is an outcome, and the request has an
 * author, a reason and an evidence reference that exist while nothing has
 * happened yet. Folding it into the claim would mean a claim row carrying a
 * proposal — a `pending` shape the claim's own state machine deliberately does
 * not have (see `GUEST_ORDER_CLAIM_STATES`) — and it would lose every WITHDRAWN
 * request, which is exactly the record that says an operator considered
 * detaching somebody's purchase and decided not to.
 *
 * ## Four eyes is two CHECKs and a SNAPSHOT
 *
 * `approved_by <> requested_by` makes self-approval unrepresentable, and the
 * execute shape refuses an unapproved execution while `four_eyes_required` is
 * true. That flag is SNAPSHOTTED at request time (the `catalog_merge_jobs`
 * device, #59): flipping the deployment flag must not retroactively unapprove a
 * correction somebody already made, nor silently approve one already pending.
 */
export const guestOrderClaimRevocations = pgTable(
  'guest_order_claim_revocations',
  {
    id: generatedId(),
    /**
     * The claim being detached. A real foreign key, `RESTRICT`: this domain
     * issues no DELETE against `guest_order_claims`, so the parent is
     * permanent, and stating it means a future deletion path fails loudly
     * rather than orphaning the correction record.
     */
    claimId: text()
      .notNull()
      .references(() => guestOrderClaims.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(GUEST_CLAIM_REVOCATION_STATES) })
      .notNull()
      .default('pending_approval'),
    reason: text({ enum: asEnumValues(GUEST_CLAIM_REVOCATION_REASONS) }).notNull(),
    /** A case or ticket reference. Length-bounded; never a description of a person. */
    evidenceRef: text().notNull(),
    /** No FK — Oxy owns identity. Mandatory: an unattributable correction is not one. */
    requestedByOxyUserId: text().notNull(),
    /** Whether a SECOND operator was required, as of the request. Snapshotted. */
    fourEyesRequired: boolean().notNull(),
    /** The second operator. NULL while pending, and while four eyes is off. */
    approvedByOxyUserId: text(),
    executedAt: timestamptz(),
    withdrawnAt: timestamptz(),
    withdrawnByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ONE open request per claim, so two operators reaching the same conclusion
    // converge on one record instead of racing to detach twice. Partial, so a
    // withdrawn request does not block a later, better-evidenced one.
    uniqueIndex('guest_order_claim_revocations_open_key')
      .on(t.claimId)
      .where(sql`${t.state} = 'pending_approval'`),
    index('guest_order_claim_revocations_claim_created_at_idx').on(
      t.claimId,
      t.createdAt.desc(),
    ),
    checkOneOf(
      'guest_order_claim_revocations_state_check',
      t.state,
      GUEST_CLAIM_REVOCATION_STATES,
    ),
    checkOneOf(
      'guest_order_claim_revocations_reason_check',
      t.reason,
      GUEST_CLAIM_REVOCATION_REASONS,
    ),
    check(
      'guest_order_claim_revocations_evidence_ref_check',
      sql`length(${t.evidenceRef}) between 1 and ${sql.raw(String(MAX_CLAIM_EVIDENCE_REF_LENGTH))}`,
    ),
    // Four eyes, at the row. An approver who is the requester is unrepresentable
    // whatever the service does — a comparison in code is one refactor from
    // being skipped.
    check(
      'guest_order_claim_revocations_four_eyes_check',
      sql`${t.approvedByOxyUserId} is null
          or ${t.approvedByOxyUserId} <> ${t.requestedByOxyUserId}`,
    ),
    check(
      'guest_order_claim_revocations_state_shape_check',
      sql`(${t.state} = 'pending_approval'
             and num_nonnulls(${t.executedAt}, ${t.withdrawnAt}, ${t.withdrawnByOxyUserId}) = 0
             and ${t.approvedByOxyUserId} is null)
          or (${t.state} = 'executed'
             and ${t.executedAt} is not null
             and num_nonnulls(${t.withdrawnAt}, ${t.withdrawnByOxyUserId}) = 0
             and (${t.fourEyesRequired} = false or ${t.approvedByOxyUserId} is not null))
          or (${t.state} = 'withdrawn'
             and ${t.executedAt} is null
             and num_nonnulls(${t.withdrawnAt}, ${t.withdrawnByOxyUserId}) = 2)`,
    ),
  ],
);

/**
 * `guest_order_claim_outbox` — the durable follow-up work a completed claim
 * owes (#109 claim-transaction rules 10 and 14, conflict case 11).
 *
 * The moderation outbox, ported: a DETERMINISTIC caller-supplied id so a repeat
 * converges on the primary key, `FOR UPDATE SKIP LOCKED` leases with an owner
 * check so N tasks drain without handing each other a row, capped exponential
 * backoff, and a visible `dead_letter` rather than a silent drop.
 *
 * ## Why the rows exist at all
 *
 * Conflict case 11 is "claim event emitted but downstream history projection
 * failed". A claim that granted review eligibility inline would have exactly
 * that failure mode with no record of it: the transaction commits, the grant
 * throws, the buyer owns the orders and can never review them, and nothing
 * anywhere says so. These rows commit WITH the claim, so the work is owed
 * durably and a failure is a row an operator can see.
 *
 * ## Gate the LOOP, never the record
 *
 * `GUEST_CLAIM_PROJECTION_ENABLED` stops the dispatcher and never the insert.
 * Claims made while it is off leave their work queued and it drains when the
 * lever comes back.
 */
export const guestOrderClaimOutbox = pgTable(
  'guest_order_claim_outbox',
  {
    /**
     * DETERMINISTIC, caller-supplied — `guest-claim:<type>:<claimId>`, so a
     * retried claim transaction, a replay and two racing requests all collide
     * on the primary key rather than queueing the same work twice.
     */
    id: text().primaryKey(),
    claimId: text()
      .notNull()
      .references(() => guestOrderClaims.id, { onDelete: 'restrict' }),
    /** Correlation, so the operator trace can open from a group without a join. */
    checkoutGroupId: text().notNull(),
    type: text({ enum: asEnumValues(GUEST_CLAIM_OUTBOX_TYPES) }).notNull(),
    state: text({ enum: asEnumValues(GUEST_CLAIM_OUTBOX_STATES) }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /**
     * A BOUNDED note about the last failure.
     *
     * Length-capped rather than free: a handler's error text is the only place
     * in this domain where somebody else's string reaches a column, and an
     * uncapped one is where a stack trace quoting a buyer's row eventually
     * lands. The handlers write a short classification and the length CHECK is
     * the backstop.
     */
    lastError: text(),
    completedAt: timestamptz(),
    /**
     * Set at insert and never advanced — the `moderation_outboxes` decision,
     * with the same consequence stated: a dispatcher down for the whole window
     * loses its backlog, and what surfaces that is the CLAIM, which is still
     * there and still readable in the operator trace.
     */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('guest_order_claim_outbox_type_check', t.type, GUEST_CLAIM_OUTBOX_TYPES),
    checkOneOf('guest_order_claim_outbox_state_check', t.state, GUEST_CLAIM_OUTBOX_STATES),
    check('guest_order_claim_outbox_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'guest_order_claim_outbox_last_error_length_check',
      sql`${t.lastError} is null
          or length(${t.lastError}) <= ${sql.raw(String(MAX_CLAIM_OUTBOX_ERROR_LENGTH))}`,
    ),
    check(
      'guest_order_claim_outbox_completed_check',
      sql`(${t.state} = 'completed') = (${t.completedAt} is not null)`,
    ),
    // The claim query is a two-branch `or`: due PENDING work, and PROCESSING
    // work whose lease has expired. One partial index per branch, so neither
    // scans the other's rows — the `moderation_outboxes` pair.
    index('guest_order_claim_outbox_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    index('guest_order_claim_outbox_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.state} = 'processing'`),
    index('guest_order_claim_outbox_claim_idx').on(t.claimId),
    // The leading btree the retention sweep needs; see `expiresAt`.
    index('guest_order_claim_outbox_expires_at_idx').on(t.expiresAt),
  ],
);
