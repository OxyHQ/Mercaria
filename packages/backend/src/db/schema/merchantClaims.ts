/**
 * Merchant claiming — issue #83, the flow ADR 0002 D9 named and deferred.
 *
 * Five tables: `merchant_claims`, `merchant_claim_scopes`,
 * `merchant_claim_challenges`, `merchant_claim_evidence`,
 * `merchant_claim_events`. They sit ON TOP of #54's `merchants` layer and add
 * nothing to it — `merchants.claim_state` stays the ONE stored verdict a gate
 * reads (D9), and this domain is the only thing that moves it.
 *
 * ## The two indexes that carry the security properties
 *
 * `merchant_claims_merchant_verified_key` — a partial unique on
 * `(merchant_id) WHERE state = 'verified'` — is the whole of issue acceptance
 * 4: two conflicting claimants cannot BOTH become the sole verified operator,
 * because the second one's write is refused by the database rather than by a
 * read-then-write two racers would walk straight past. The service turns that
 * refusal into a DISPUTE (scope rule 6) instead of replacing the incumbent.
 * Several verified operators per merchant still arrive, through the native
 * store's own membership after linkage (#84) — which is a `store_members`
 * fact, never a second verified claim.
 *
 * `merchant_claim_challenges_claim_id_open_key` — a partial unique on
 * `(claim_id) WHERE closed_at IS NULL` — is what "single-use" means
 * mechanically: at most one challenge is ever open for a claim, issuing a new
 * one must close the old one in the same transaction, and consuming one is a
 * compare-and-swap on `closed_at IS NULL`. A replayed or stolen token
 * therefore cannot verify anything, and cannot verify ANOTHER claim at all,
 * because the row the token hashes to names its own claim.
 *
 * ## There is deliberately no `challenge_id` column on the claim
 *
 * Issue model field 5 asks for "verification method and challenge id". The
 * method is a column; the challenge is NOT, because the partial unique above
 * already defines "this claim's current challenge" exactly, and a pointer
 * beside it would be a second representation of that fact — the
 * `provider_accounts` no-`ready`-boolean rule. The claim's open challenge is
 * resolved through the index; the DTO carries it derived.
 *
 * ## Assurance is derived, and private evidence never rides a public read
 *
 * How much a method's proof is worth is a property of the METHOD
 * (`services/merchant-claims/claim-methods.ts`), so there is no `assurance`
 * column that could disagree with it. Documents, notes and token digests live
 * on `merchant_claim_evidence` / `merchant_claim_challenges` and their
 * sensitive columns are registered in `db/protectedColumns.ts`, so a whole-row
 * read cannot ship them and a serializer that reaches for one fails `tsc`.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  MERCHANT_CLAIM_ACTIVE_STATES,
  MERCHANT_CLAIM_ACTOR_KINDS,
  MERCHANT_CLAIM_CHALLENGE_CLOSE_REASONS,
  MERCHANT_CLAIM_CHALLENGE_SUBJECT_KINDS,
  MERCHANT_CLAIM_EVENT_ACTIONS,
  MERCHANT_CLAIM_EVIDENCE_KINDS,
  MERCHANT_CLAIM_METHODS,
  MERCHANT_CLAIM_REVOKE_REASONS,
  MERCHANT_CLAIM_SCOPE_KINDS,
  MERCHANT_CLAIM_SCOPE_STATES,
  MERCHANT_CLAIM_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { merchants } from './merchants';
import { stores } from './stores';

/**
 * `merchant_claims` — one attempt by one Oxy account to operate one merchant.
 *
 * `merchant_id` is RESTRICT: a merchant with claim history cannot be deleted
 * out from under it, which matches the rest of the canonical graph (nothing
 * hard-deletes a canonical row; retirement is a status, ADR 0002 D12/D20).
 * `native_store_id` is RESTRICT for the `native_store_links` reason — an
 * intended linkage is a fact a future store deletion must confront.
 *
 * Terminal states (`rejected`, `expired`, `revoked`) are never edited into a
 * different meaning: another attempt is a NEW row, so the decision record
 * survives verbatim.
 */
export const merchantClaims = pgTable(
  'merchant_claims',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    claimantOxyUserId: text().notNull(),
    /**
     * The native store this claim intends to link to once verified (#84).
     * Optional: a claimant may prove control of a merchant before they have a
     * native store, and the LINK itself is still `native_store_links`' — this
     * column records an intent, never a grant.
     */
    nativeStoreId: text().references(() => stores.id, { onDelete: 'restrict' }),
    method: text({ enum: asEnumValues(MERCHANT_CLAIM_METHODS) }).notNull(),
    /**
     * WHAT the claim's proof is about — a domain, a platform connection, or a
     * role address. It lives on the CLAIM and not on the challenge, so
     * re-issuing an expired challenge cannot quietly change what is being
     * proved: the subject is the claim's identity, and a challenge is only a
     * window on it.
     *
     * NULL exactly for `business_document`, which has nothing for a claimant
     * to publish or present — a CHECK below states that rather than leaving it
     * to whoever writes the next method.
     */
    subjectKind: text({ enum: asEnumValues(MERCHANT_CLAIM_CHALLENGE_SUBJECT_KINDS) }),
    subjectRef: text(),
    state: text({ enum: asEnumValues(MERCHANT_CLAIM_STATES) })
      .notNull()
      .default('draft'),
    /**
     * Deadline for finishing the attempt. Cleared when the claim goes
     * terminal, so a stale deadline can never expire a decided claim.
     */
    expiresAt: timestamptz(),
    /** When a VERIFIED claim must prove itself again (issue model field 9). */
    revalidateAfter: timestamptz(),
    /** An Oxy account id — no foreign key. The reviewer, when a human decided. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
    /** The reviewer's words, written to be read by the claimant. */
    decisionReason: text(),
    verifiedAt: timestamptz(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text({ enum: asEnumValues(MERCHANT_CLAIM_REVOKE_REASONS) }),
    /**
     * The claim this one conflicts with — the INCUMBENT, never a peer. A
     * self-FK, declared per-table because it needs the table constant.
     * RESTRICT: the record a dispute is about cannot vanish from under it.
     *
     * Singular rather than a set, deliberately: the verified-claim partial
     * unique guarantees at most one incumbent, and two pending claims on an
     * unclaimed merchant are not in conflict until one of them verifies.
     */
    conflictingClaimId: text().references((): AnyPgColumn => merchantClaims.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchant_claims_method_check', t.method, MERCHANT_CLAIM_METHODS),
    checkOneOf('merchant_claims_state_check', t.state, MERCHANT_CLAIM_STATES),
    checkOneOf(
      'merchant_claims_subject_kind_check',
      t.subjectKind,
      MERCHANT_CLAIM_CHALLENGE_SUBJECT_KINDS,
    ),
    // The subject's two columns are one fact and travel together.
    check(
      'merchant_claims_subject_presence_check',
      sql`num_nonnulls(${t.subjectKind}, ${t.subjectRef}) in (0, 2)`,
    ),
    // Exactly one method has no subject. Stating it here rather than trusting
    // the method registry means a future subjectless method needs a migration
    // — which is the visible decision, not an obstacle.
    check(
      'merchant_claims_document_subject_check',
      sql`(${t.method} = 'business_document') = (${t.subjectKind} is null)`,
    ),
    // A domain subject is stored in the ONE normalized form the collision gate
    // on `merchant_domains` uses, so a case variant cannot name a subject the
    // graph would never match.
    check(
      'merchant_claims_subject_domain_normalized_check',
      sql`${t.subjectKind} <> 'domain' or ${t.subjectRef} = lower(btrim(${t.subjectRef}))`,
    ),
    checkOneOf('merchant_claims_revoke_reason_check', t.revokeReason, MERCHANT_CLAIM_REVOKE_REASONS),
    // A verification nobody can date is not a verification anybody can audit —
    // the `merchant_domains_verified_state_check` shape.
    check(
      'merchant_claims_verified_state_check',
      sql`${t.state} <> 'verified' or ${t.verifiedAt} is not null`,
    ),
    // A revocation without a time, an actor and a coded reason cannot be
    // counted, alerted on, or told apart from an operator correcting a mistake.
    check(
      'merchant_claims_revoked_state_check',
      sql`${t.state} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null and ${t.revokeReason} is not null)`,
    ),
    // A rejection is ALWAYS a human decision: an automatic refusal is an
    // expiry, and the two must not be confusable in the record.
    check(
      'merchant_claims_rejected_state_check',
      sql`${t.state} <> 'rejected' or (${t.reviewedByOxyUserId} is not null and ${t.reviewedAt} is not null and ${t.decisionReason} is not null)`,
    ),
    // A dispute names what it is a dispute WITH, or it is just a stuck claim.
    check(
      'merchant_claims_disputed_state_check',
      sql`${t.state} <> 'disputed' or ${t.conflictingClaimId} is not null`,
    ),
    // A claim cannot conflict with itself; the self-FK alone permits it.
    check('merchant_claims_conflict_self_check', sql`${t.conflictingClaimId} <> ${t.id}`),
    // THE acceptance-4 gate: one verified operator claim per merchant, ever, at
    // a time. Additional operators arrive through store membership (#84).
    uniqueIndex('merchant_claims_merchant_verified_key')
      .on(t.merchantId)
      .where(sql`${t.state} = 'verified'`),
    // One live attempt per (merchant, claimant) — a retry converges on the row
    // that already exists instead of minting a queue of drafts to review.
    // The predicate is rendered from MERCHANT_CLAIM_ACTIVE_STATES so it cannot
    // drift from the tuple the service reads.
    uniqueIndex('merchant_claims_merchant_claimant_active_key')
      .on(t.merchantId, t.claimantOxyUserId)
      .where(sql`${t.state} in (${sql.raw(inList(MERCHANT_CLAIM_ACTIVE_STATES))})`),
    index('merchant_claims_merchant_id_created_at_idx').on(t.merchantId, t.createdAt.desc()),
    index('merchant_claims_claimant_created_at_idx').on(t.claimantOxyUserId, t.createdAt.desc()),
    // The operator review queue reads by state, oldest first.
    index('merchant_claims_state_created_at_idx').on(t.state, t.createdAt),
    // The lazy expiry CAS narrows on this; partial because a terminal claim
    // carries no deadline at all.
    index('merchant_claims_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
    // The per-DOMAIN issuance budget joins challenges to their claim and counts
    // by subject; this is the side of that join that narrows.
    index('merchant_claims_subject_idx')
      .on(t.subjectKind, t.subjectRef)
      .where(sql`${t.subjectKind} is not null`),
  ],
);

/**
 * `merchant_claim_scopes` — what was asked for, and what the evidence reached.
 *
 * Requested and verified scope are two STATES of one row rather than two
 * tables, so a storefront a proof missed is visible as `out_of_scope` instead
 * of silently absent — which is the difference between "your Shopify proof
 * does not cover your Amazon presence" and a claimant wondering why nothing
 * happened. The unique key makes re-running a verification converge.
 *
 * `scope_ref` deliberately carries NO foreign key even for the storefront and
 * merchant kinds: one polymorphic column cannot reference two tables, and the
 * alternative (three nullable columns plus a CHECK) buys a constraint on rows
 * whose targets are never hard-deleted anyway.
 */
export const merchantClaimScopes = pgTable(
  'merchant_claim_scopes',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => merchantClaims.id, { onDelete: 'cascade' }),
    scopeKind: text({ enum: asEnumValues(MERCHANT_CLAIM_SCOPE_KINDS) }).notNull(),
    /** A merchant id, a storefront id, or a normalized lowercase hostname. */
    scopeRef: text().notNull(),
    state: text({ enum: asEnumValues(MERCHANT_CLAIM_SCOPE_STATES) })
      .notNull()
      .default('requested'),
    verifiedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchant_claim_scopes_kind_check', t.scopeKind, MERCHANT_CLAIM_SCOPE_KINDS),
    checkOneOf('merchant_claim_scopes_state_check', t.state, MERCHANT_CLAIM_SCOPE_STATES),
    check(
      'merchant_claim_scopes_verified_state_check',
      sql`${t.state} <> 'verified' or ${t.verifiedAt} is not null`,
    ),
    // A domain scope is stored in the ONE normalized form the collision gate on
    // `merchant_domains` uses, so a case variant cannot describe a scope the
    // graph would never match.
    check(
      'merchant_claim_scopes_domain_normalized_check',
      sql`${t.scopeKind} <> 'domain' or ${t.scopeRef} = lower(btrim(${t.scopeRef}))`,
    ),
    uniqueIndex('merchant_claim_scopes_claim_kind_ref_key').on(t.claimId, t.scopeKind, t.scopeRef),
    index('merchant_claim_scopes_ref_idx').on(t.scopeKind, t.scopeRef),
  ],
);

/**
 * `merchant_claim_challenges` — one outstanding proof request.
 *
 * The token is NEVER stored: `token_hash` holds the hex SHA-256 of `mcc_` plus
 * 32 CSPRNG bytes, the `guest_sessions.token_hash` decision exactly (256 bits
 * of preimage entropy means a leaked digest is neither invertible nor
 * dictionary-attackable, and a pepper would make every stored hash
 * unverifiable the day it rotated). The column is PROTECTED, so no whole-row
 * read can ship it.
 *
 * `attempt_count` is a real column rather than a log scrape because it is a
 * BOUND: a claimant polling a DNS record that does not exist must stop costing
 * lookups, and "how many times has this been tried" has to be answerable
 * inside the transaction that refuses the next one.
 *
 * It carries NEITHER the method NOR the subject: both belong to the claim, and
 * a copy here could disagree with it — which is precisely how re-issuing a
 * challenge would become a way to change what a claim is about.
 */
export const merchantClaimChallenges = pgTable(
  'merchant_claim_challenges',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => merchantClaims.id, { onDelete: 'cascade' }),
    /** Hex SHA-256 of the one-time token. NEVER the plaintext. */
    tokenHash: text().notNull(),
    expiresAt: timestamptz().notNull(),
    /** Set the moment the challenge stops being open — the single-use CAS target. */
    closedAt: timestamptz(),
    closedReason: text({ enum: asEnumValues(MERCHANT_CLAIM_CHALLENGE_CLOSE_REASONS) }),
    attemptCount: integer().notNull().default(0),
    lastAttemptAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_claim_challenges_closed_reason_check',
      t.closedReason,
      MERCHANT_CLAIM_CHALLENGE_CLOSE_REASONS,
    ),
    // Closed-ness and its reason are one fact in two columns, so their
    // agreement is a CHECK — the `merchants_merged_state_check` shape.
    check(
      'merchant_claim_challenges_closed_state_check',
      sql`(${t.closedAt} is not null) = (${t.closedReason} is not null)`,
    ),
    check('merchant_claim_challenges_attempt_count_check', sql`${t.attemptCount} >= 0`),
    // Resolution by digest is ONE indexed lookup, and unique so a presented
    // token can never name two challenges.
    uniqueIndex('merchant_claim_challenges_token_hash_key').on(t.tokenHash),
    // "Single-use", structurally: at most one OPEN challenge per claim.
    uniqueIndex('merchant_claim_challenges_claim_id_open_key')
      .on(t.claimId)
      .where(sql`${t.closedAt} is null`),
    index('merchant_claim_challenges_claim_id_idx').on(t.claimId),
    // The three issuance budgets all count rows in a window, joined to their
    // claim for the user/merchant/subject they belong to.
    index('merchant_claim_challenges_created_at_idx').on(t.createdAt.desc()),
  ],
);

/**
 * `merchant_claim_evidence` — private evidence, outside every public DTO.
 *
 * Documents themselves never enter Mercaria: the row carries an Oxy `file_id`
 * and a declared digest, the `moderation` evidence decision exactly (a
 * reviewer's browser resolving a `mercaria.co` URL would tell this host when
 * its content is under review). `note`, `oxy_file_id` and `url` are
 * PROTECTED columns, so the operator surface names them explicitly and nothing
 * else can read them by accident.
 *
 * Append-only by shape: `collected_at` and no `updated_at`, the
 * `order_status_history` contract. Evidence is added, never rewritten.
 */
export const merchantClaimEvidence = pgTable(
  'merchant_claim_evidence',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => merchantClaims.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(MERCHANT_CLAIM_EVIDENCE_KINDS) }).notNull(),
    /** An Oxy media file id — Oxy owns the file; Mercaria stores only the id. */
    oxyFileId: text(),
    /** Digest of the referenced document, so the claim survives the file changing. */
    sha256: text(),
    /** Free text a claimant or reviewer wrote. Protected; never public. */
    note: text(),
    /** A URL the evidence points at. Protected; never fetched by a reviewer's browser. */
    url: text(),
    /** An Oxy account id — no foreign key. */
    collectedByOxyUserId: text(),
    collectedAt: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('merchant_claim_evidence_kind_check', t.kind, MERCHANT_CLAIM_EVIDENCE_KINDS),
    // A declared digest is a sha-256 or it is not a digest — the
    // `source_records` content-hash shape check.
    check('merchant_claim_evidence_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    // Evidence that references nothing is not evidence.
    check(
      'merchant_claim_evidence_reference_check',
      sql`num_nonnulls(${t.oxyFileId}, ${t.url}, ${t.note}) > 0`,
    ),
    index('merchant_claim_evidence_claim_id_idx').on(t.claimId),
  ],
);

/**
 * `merchant_claim_events` — the append-only audit timeline (issue model field
 * 10, security control 6).
 *
 * `at` and no `updated_at`: the `order_status_history` / `payment_repairs`
 * contract. One row per ATTEMPT and per ACCESS, refusals included — a reviewer
 * opening a claim's private evidence writes an `evidence_accessed` row before
 * the evidence is returned, so "who looked" is answerable without trusting
 * anybody to remember to log it.
 */
export const merchantClaimEvents = pgTable(
  'merchant_claim_events',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => merchantClaims.id, { onDelete: 'cascade' }),
    action: text({ enum: asEnumValues(MERCHANT_CLAIM_EVENT_ACTIONS) }).notNull(),
    actorKind: text({ enum: asEnumValues(MERCHANT_CLAIM_ACTOR_KINDS) }).notNull(),
    /** An Oxy account id — no foreign key. NULL exactly when the actor is `system`. */
    actorOxyUserId: text(),
    fromState: text({ enum: asEnumValues(MERCHANT_CLAIM_STATES) }),
    toState: text({ enum: asEnumValues(MERCHANT_CLAIM_STATES) }),
    reason: text(),
    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('merchant_claim_events_action_check', t.action, MERCHANT_CLAIM_EVENT_ACTIONS),
    checkOneOf('merchant_claim_events_actor_kind_check', t.actorKind, MERCHANT_CLAIM_ACTOR_KINDS),
    checkOneOf('merchant_claim_events_from_state_check', t.fromState, MERCHANT_CLAIM_STATES),
    checkOneOf('merchant_claim_events_to_state_check', t.toState, MERCHANT_CLAIM_STATES),
    // A human action names its human. `system` is the only actorless kind, and
    // making that a CHECK stops an unattributed operator decision existing.
    check(
      'merchant_claim_events_actor_presence_check',
      sql`(${t.actorKind} = 'system') = (${t.actorOxyUserId} is null)`,
    ),
    index('merchant_claim_events_claim_id_at_idx').on(t.claimId, t.at),
  ],
);
