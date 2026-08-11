/**
 * Guest-commerce governance (#111): retention, privacy requests, abuse controls,
 * security counters and the staged rollout.
 *
 * Nine tables, and the shape of the domain is easiest to see through what is
 * ABSENT from all nine. There is no email column, no phone, no address, no
 * token, no device identifier, no user agent and no IP address anywhere here.
 * The three places a person's own value would otherwise have to appear are a
 * keyed digest under this domain's own key (`subject_hash`), a Mercaria-minted
 * row id, or a COARSE network range — and each is in `PROTECTED_COLUMNS` for
 * the reason `guest_checkouts.email_hash` is: a keyed digest is still an
 * exact-match ORACLE, so anybody holding an address can test it.
 *
 * ## Why counters rather than events
 *
 * Every measurement here is a COUNT per window, never a row per attempt.
 * That is a privacy decision before it is an efficiency one: a row per
 * token-verification failure is a log of activity nobody consented to AND an
 * amplification primitive an attacker controls the volume of. A count answers
 * "is this happening more than usual", which is the only question an alert
 * asks, and answers "who did it" with nothing.
 *
 * The shape is `guest_recovery_attempts` (#108) generalised — a subject, a
 * window start, a count, and an upsert that increments — which is also why the
 * retention on it is expressed the same way.
 *
 * ## Why a retention POLICY table when `expiryTargets.ts` already exists
 *
 * They answer different questions and neither can answer the other's.
 * `db/expiryTargets.ts` is the MECHANISM: which column on which table the sweep
 * reads, compiled into the image. This is the POLICY: which data class a
 * retention belongs to, what its lawful basis is, whether a legal hold pauses
 * it, and — the part a code constant cannot carry — WHEN a change to any of
 * that took effect and who published it. #111 retention rule 10 asks for
 * exactly that separation ("policy changes are versioned and applied through
 * controlled migration jobs"), and the `fee_schedules` device is how every
 * other versioned policy in this repository is held.
 *
 * The two are checked against each other by `retention-policy-census.test.ts`,
 * so a class published here with no mechanism, or a guest table swept with no
 * class, fails the build.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  GUEST_ABUSE_AXES,
  GUEST_ABUSE_PATTERNS,
  GUEST_ABUSE_SCOPES,
  GUEST_DATA_CLASSES,
  GUEST_DATA_DISPOSITIONS,
  GUEST_DATA_REQUEST_KINDS,
  GUEST_DATA_REQUEST_PROOFS,
  GUEST_DATA_REQUEST_STATES,
  GUEST_DATA_RETENTION_REASONS,
  GUEST_FRICTION_MEASURES,
  GUEST_INTERVENTION_STATES,
  GUEST_LAUNCH_GATES,
  GUEST_RETENTION_CLASSES,
  GUEST_RETENTION_MECHANISMS,
  GUEST_ROLLOUT_STAGES,
  GUEST_SECURITY_SIGNALS,
  GUEST_SIGNOFF_DISCIPLINES,
  GUEST_STAGE_ADVANCE_REFUSALS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';

/** A bounded operator reason. A sentence, never a story. */
const MAX_GOVERNANCE_REASON_LENGTH = 500;

/** A bounded evidence REFERENCE — a case number or a document id, never a document. */
const MAX_GOVERNANCE_EVIDENCE_REF_LENGTH = 200;

/**
 * A retention-policy version key. ONE key, a code constant, for the reason
 * every policy key in this repository is one: a table of keys would let
 * somebody publish a policy whose rules nobody shipped.
 */
export const GUEST_RETENTION_POLICY_KEY = 'guest-commerce-retention';

/* -------------------------------------------------------------------------- */
/*  Retention policy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `guest_retention_policy_versions` — one immutable row per published version
 * of the retention schedule.
 *
 * The `fee_schedules` shape: a trigger freezes every field once the version
 * leaves `draft`, and a partial unique index holds exactly one ACTIVE version
 * per key. Both matter for the same reason they do there — a retention somebody
 * relied on must still be readable after it is superseded, because "how long
 * was this kept, and under what rule" is a question asked months later about
 * data that has already gone.
 *
 * One row per (version, retention CLASS). A version is therefore a SET of rows
 * sharing a `version` string, which is what lets a change to one class be
 * published without restating the other twelve — and what lets the census
 * assert that an active version covers every class rather than most of them.
 */
export const guestRetentionPolicyVersions = pgTable(
  'guest_retention_policy_versions',
  {
    id: generatedId(),
    /** The policy key. One value today; a column so a second scope is a row. */
    policyKey: text().notNull().default(GUEST_RETENTION_POLICY_KEY),
    /** The version string every published row of this version shares. */
    version: text().notNull(),
    /** Which class this row governs. */
    retentionClass: text({ enum: asEnumValues(GUEST_RETENTION_CLASSES) }).notNull(),
    /**
     * How long, in seconds. NULL means retained indefinitely, which is a real
     * and deliberate answer for the transaction records — and one that has to be
     * representable, because a class with no deletion and a class nobody
     * classified must not look the same.
     */
    retentionSeconds: bigint({ mode: 'number' }),
    /** How the deletion is actually performed. */
    mechanism: text({ enum: asEnumValues(GUEST_RETENTION_MECHANISMS) }).notNull(),
    /**
     * Whether a legal hold PAUSES this class (#111 retention rule 7).
     *
     * Per class rather than per policy, deliberately: a hold on an order's
     * financial evidence must not also freeze the cart TTL, or one dispute pins
     * an unbounded amount of unrelated temporary data for as long as it stays
     * open.
     */
    pausableByLegalHold: text({ enum: ['yes', 'no'] }).notNull(),
    /** Why this figure. The field an auditor reads. */
    rationale: text().notNull(),
    /** `draft` until published; then frozen. */
    status: text({ enum: ['draft', 'active', 'superseded'] })
      .notNull()
      .default('draft'),
    /** Who published it. Mandatory from the moment it leaves `draft`. */
    publishedByOxyUserId: text(),
    publishedAt: timestamptz(),
    supersededAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf(
      'guest_retention_policy_versions_class_check',
      table.retentionClass,
      GUEST_RETENTION_CLASSES,
    ),
    checkOneOf(
      'guest_retention_policy_versions_mechanism_check',
      table.mechanism,
      GUEST_RETENTION_MECHANISMS,
    ),
    /**
     * A `none` mechanism cannot carry a retention figure. An IMPLICATION and
     * deliberately NOT a biconditional, which is the correction worth reading
     * because the biconditional is the tempting spelling and is wrong in a way
     * that only a real schedule exposes.
     *
     * The dangerous direction is a class that says "this is never deleted" and
     * carries a TTL anyway — a contradiction whichever half a reader believes,
     * and the one that would put a cart clock in front of a statutory record.
     * That is what this refuses.
     *
     * The other direction is LEGITIMATE and common: a `expiry_sweep` class may
     * have no fixed offset because the deadline is already stamped ON THE ROW
     * (`db/expiryTargets.ts`'s `retentionSeconds: 0` — the column IS the
     * deadline, so the class decides the age and the registry does not), or
     * because the row leaves by `ON DELETE CASCADE` with its parent, which is
     * how a guest cart is retained correctly by construction. Three of the
     * thirteen classes are in exactly that state, and a biconditional would
     * have made all three unrepresentable.
     */
    check(
      'guest_retention_policy_versions_mechanism_shape_check',
      sql`${table.mechanism} <> 'none' or ${table.retentionSeconds} is null`,
    ),
    check(
      'guest_retention_policy_versions_seconds_positive_check',
      sql`${table.retentionSeconds} is null or ${table.retentionSeconds} > 0`,
    ),
    /**
     * A published version names its publisher, and a draft does not. The
     * biconditional is what stops a version being activated by an UPDATE that
     * left the attribution behind.
     */
    check(
      'guest_retention_policy_versions_publication_check',
      sql`(${table.status} = 'draft') = (${table.publishedByOxyUserId} is null and ${table.publishedAt} is null)`,
    ),
    check(
      'guest_retention_policy_versions_superseded_check',
      sql`(${table.status} = 'superseded') = (${table.supersededAt} is not null)`,
    ),
    /** One row per class per version. */
    uniqueIndex('guest_retention_policy_versions_row_key').on(
      table.policyKey,
      table.version,
      table.retentionClass,
    ),
    /**
     * Exactly ONE active version per (key, class). A partial unique rather than
     * a service comparison, the `fee_schedules` and `match_policy_versions`
     * device: two operators publishing at once converge on one winner from the
     * database rather than on whichever transaction committed last.
     */
    uniqueIndex('guest_retention_policy_versions_active_key')
      .on(table.policyKey, table.retentionClass)
      .where(sql`status = 'active'`),
    index('guest_retention_policy_versions_version_idx').on(table.policyKey, table.version),
  ],
);

/**
 * `guest_retention_runs` — one row per pass of the controlled retention job.
 *
 * #111 retention rules 1 and 6: bounded indexed batches, with auditable counts
 * and failures and no deleted value in any of them. The columns are counts and
 * a bounded failure code; there is deliberately nowhere to put a row that was
 * removed, which is what makes "without logging deleted sensitive values" a
 * property of the schema rather than of whoever writes the log line.
 *
 * ## The vacuity floor is a CHECK
 *
 * `examined = minimized + deleted + skipped_held + failed`, an EQUALITY and
 * never `<=` — #60's `catalog_backfill_runs_counters_total_check`, and for the
 * same reason: a pass that swallowed a row cannot write a row. A retention job
 * that silently did nothing and one that correctly found nothing produce the
 * same output otherwise, and the first is the failure this whole domain exists
 * to make visible.
 */
export const guestRetentionRuns = pgTable(
  'guest_retention_runs',
  {
    id: generatedId(),
    /** The class this pass worked on. One class per run, so a failure is attributable. */
    retentionClass: text({ enum: asEnumValues(GUEST_RETENTION_CLASSES) }).notNull(),
    /** The policy version the pass applied. */
    policyVersion: text().notNull(),
    /**
     * `dry_run` computes and writes the identical counters and changes nothing —
     * the `CROWDSOURCE_ENFORCEMENT_MODE=observe` posture, which is what makes a
     * retention change reviewable before it deletes anything.
     */
    mode: text({ enum: ['dry_run', 'apply'] }).notNull(),
    status: text({ enum: ['running', 'completed', 'failed'] })
      .notNull()
      .default('running'),
    /** Rows the pass looked at. */
    examinedCount: integer().notNull().default(0),
    /** Rows whose identifying columns were overwritten. */
    minimizedCount: integer().notNull().default(0),
    /** Rows deleted. */
    deletedCount: integer().notNull().default(0),
    /** Rows a legal hold protected. */
    skippedHeldCount: integer().notNull().default(0),
    /** Rows that raised. */
    failedCount: integer().notNull().default(0),
    /**
     * The LAST id the pass reached, so a resumed run starts where it stopped.
     *
     * A keyset cursor and not an offset — an offset over a set the pass is
     * DELETING from skips rows, which is the specific way a retention job
     * silently leaves data behind. Named `cursor` rather than `cursor_id`, the
     * `catalog_backfill_runs` name: it is a position, not a reference, and the
     * id-column gate is right to ask what a `_id` column points at.
     */
    cursor: text(),
    /** A bounded failure code. Never a message carrying a value. */
    failureCode: text(),
    startedAt: timestamptz().notNull().defaultNow(),
    finishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf('guest_retention_runs_class_check', table.retentionClass, GUEST_RETENTION_CLASSES),
    check(
      'guest_retention_runs_counters_total_check',
      sql`${table.examinedCount} = ${table.minimizedCount} + ${table.deletedCount} + ${table.skippedHeldCount} + ${table.failedCount}`,
    ),
    check(
      'guest_retention_runs_counters_nonnegative_check',
      sql`${table.examinedCount} >= 0 and ${table.minimizedCount} >= 0 and ${table.deletedCount} >= 0 and ${table.skippedHeldCount} >= 0 and ${table.failedCount} >= 0`,
    ),
    /** A dry run may compute every counter and must never report a DELETE. */
    check(
      'guest_retention_runs_dry_run_check',
      sql`${table.mode} = 'apply' or ${table.deletedCount} = 0`,
    ),
    check(
      'guest_retention_runs_finished_check',
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    check(
      'guest_retention_runs_failure_code_check',
      sql`${table.failureCode} is null or (${table.status} = 'failed' and length(${table.failureCode}) <= ${sql.raw(String(MAX_GOVERNANCE_REASON_LENGTH))})`,
    ),
    index('guest_retention_runs_class_started_idx').on(table.retentionClass, table.startedAt),
  ],
);

/**
 * `guest_legal_holds` — a hold that PAUSES one class's deletion for one
 * subject (#111 retention rule 7).
 *
 * Scoped to a class AND a checkout group, which is the whole point: "only the
 * relevant deletion" means a dispute over one order cannot freeze every
 * abandoned cart on the deployment. A hold with no class would be exactly that,
 * so there is no way to express one — the column is NOT NULL.
 */
export const guestLegalHolds = pgTable(
  'guest_legal_holds',
  {
    id: generatedId(),
    /**
     * The checkout GROUP the hold is about. Correlation with no foreign key —
     * there is no `checkout_groups` table; the group is a shared token
     * (`db/deferredForeignKeys.ts`), exactly as `guest_checkouts` records it.
     */
    checkoutGroupId: text().notNull(),
    /** Which class is paused. */
    retentionClass: text({ enum: asEnumValues(GUEST_RETENTION_CLASSES) }).notNull(),
    /** Why. Bounded, and it reaches an operator surface. */
    reason: text({ enum: asEnumValues(GUEST_DATA_RETENTION_REASONS) }).notNull(),
    /** Who raised it. Mandatory: an unattributable hold is one nobody can lift. */
    raisedByOxyUserId: text().notNull(),
    /** A case number or ticket reference, never the case itself. */
    evidenceRef: text(),
    liftedAt: timestamptz(),
    liftedByOxyUserId: text(),
    /** Why it was lifted. Mandatory with the lift, for the reason the raise is. */
    liftReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf('guest_legal_holds_class_check', table.retentionClass, GUEST_RETENTION_CLASSES),
    checkOneOf('guest_legal_holds_reason_check', table.reason, GUEST_DATA_RETENTION_REASONS),
    /**
     * A lift is attributable, dated and explained — all three or none. The
     * `retail_suppressions` device: an operator lifting a hold is making a
     * decision somebody may have to defend.
     */
    check(
      'guest_legal_holds_lift_shape_check',
      sql`(${table.liftedAt} is null) = (${table.liftedByOxyUserId} is null) and (${table.liftedAt} is null) = (${table.liftReason} is null)`,
    ),
    check(
      'guest_legal_holds_evidence_ref_length_check',
      sql`${table.evidenceRef} is null or length(${table.evidenceRef}) <= ${sql.raw(String(MAX_GOVERNANCE_EVIDENCE_REF_LENGTH))}`,
    ),
    check(
      'guest_legal_holds_reason_length_check',
      sql`${table.liftReason} is null or length(${table.liftReason}) <= ${sql.raw(String(MAX_GOVERNANCE_REASON_LENGTH))}`,
    ),
    /**
     * ONE live hold per (group, class), so two operators raising the same hold
     * converge rather than stacking two that must both be lifted. A LIFTED row
     * does not occupy the index, which is what lets a hold be re-raised — the
     * `retail_suppressions` shape, and the reason the guard the retention job
     * consults is narrowed to this index's own predicate rather than to the
     * table.
     */
    uniqueIndex('guest_legal_holds_live_key')
      .on(table.checkoutGroupId, table.retentionClass)
      .where(sql`lifted_at is null`),
    index('guest_legal_holds_class_live_idx')
      .on(table.retentionClass)
      .where(sql`lifted_at is null`),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Data subject requests                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `guest_data_requests` — one row per export, deletion or minimization request
 * (#111 "Guest data export and deletion", requirement 8: auditable).
 *
 * The row records the request, the PROOF that authorized it and the per-class
 * outcome. It holds no exported VALUE: an export's payload is handed to the
 * requester through the credential that authorized it and is never stored,
 * because a stored export is a second copy of everything the request was about,
 * sitting in a table with a longer retention than the data it duplicates.
 */
export const guestDataRequests = pgTable(
  'guest_data_requests',
  {
    id: generatedId(),
    /** The checkout GROUP. One request covers one group — never an inbox. */
    checkoutGroupId: text().notNull(),
    kind: text({ enum: asEnumValues(GUEST_DATA_REQUEST_KINDS) }).notNull(),
    /**
     * What authorized it. Two members and no third: `email_match` is
     * unrepresentable, which is #111 export requirement 1 held by a tuple
     * rather than by a branch somebody could invert.
     */
    proof: text({ enum: asEnumValues(GUEST_DATA_REQUEST_PROOFS) }).notNull(),
    /**
     * The `guest_order_access_grants` row that proved possession, when the proof
     * was a portal grant.
     *
     * Correlation with NO foreign key, the `guest_order_claims.source_grant_id`
     * decision and for its exact reason: grants are hard DELETED at their own
     * `purge_at`, so a RESTRICT would block the purge forever and a CASCADE
     * would erase the audit of an erasure the day the credential aged out.
     */
    sourceGrantId: text(),
    /** The Oxy account, when the proof was a completed claim. No FK — Oxy owns identity. */
    requestedByOxyUserId: text(),
    state: text({ enum: asEnumValues(GUEST_DATA_REQUEST_STATES) })
      .notNull()
      .default('received'),
    /**
     * Which classes were erased or minimized, and which were retained. Two
     * parallel `text[]` columns rather than a child table: the answer is a
     * SUMMARY the requester is shown, it is written once and never queried
     * across rows, and a child table would make the receipt assemblable from
     * pieces that could disagree.
     */
    erasedClasses: text().array().notNull().default(sql`'{}'::text[]`),
    retainedClasses: text().array().notNull().default(sql`'{}'::text[]`),
    /** Why each retained class was retained, positionally aligned with the list above. */
    retainedReasons: text().array().notNull().default(sql`'{}'::text[]`),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf('guest_data_requests_kind_check', table.kind, GUEST_DATA_REQUEST_KINDS),
    checkOneOf('guest_data_requests_proof_check', table.proof, GUEST_DATA_REQUEST_PROOFS),
    checkOneOf('guest_data_requests_state_check', table.state, GUEST_DATA_REQUEST_STATES),
    checkEveryElementOf(
      'guest_data_requests_erased_classes_check',
      table.erasedClasses,
      GUEST_DATA_CLASSES,
    ),
    checkEveryElementOf(
      'guest_data_requests_retained_classes_check',
      table.retainedClasses,
      GUEST_DATA_CLASSES,
    ),
    checkEveryElementOf(
      'guest_data_requests_retained_reasons_check',
      table.retainedReasons,
      GUEST_DATA_RETENTION_REASONS,
    ),
    /**
     * Every retained class names a reason. `cardinality`, never
     * `array_length` — on an empty array the latter is NULL and a CHECK reads
     * NULL as SATISFIED, so the obvious spelling admits exactly the row it
     * refuses (#108 measured it on its first realdb run).
     */
    check(
      'guest_data_requests_retained_pairing_check',
      sql`cardinality(${table.retainedClasses}) = cardinality(${table.retainedReasons})`,
    ),
    /** The proof and the handle it produced must agree. */
    check(
      'guest_data_requests_proof_shape_check',
      sql`(${table.proof} = 'verified_portal_grant') = (${table.sourceGrantId} is not null) and (${table.proof} = 'completed_oxy_claim') = (${table.requestedByOxyUserId} is not null)`,
    ),
    check(
      'guest_data_requests_completion_check',
      sql`(${table.state} = 'received') = (${table.completedAt} is null)`,
    ),
    index('guest_data_requests_group_idx').on(table.checkoutGroupId, table.createdAt),
    index('guest_data_requests_state_idx').on(table.state, table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Abuse controls                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `guest_abuse_counters` — how many times one subject did one thing in one
 * window.
 *
 * `guest_recovery_attempts` (#108) generalised across the ten scopes, and
 * DURABLE for the reason that one is: "how often has this /24 asked for a new
 * session, across every ECS task" is not a question an in-process bucket can
 * answer, and every rate limiter in this repository that answers a
 * fleet-scoped question is a table for exactly that reason (#83's three axes,
 * #108's two).
 *
 * The subject is an HMAC with the AXIS and the SCOPE in the preimage, so a
 * counter under one scope cannot be joined to a counter under another even by
 * somebody holding the key — which is the difference between rate limiting a
 * network and building a profile of it.
 */
export const guestAbuseCounters = pgTable(
  'guest_abuse_counters',
  {
    id: generatedId(),
    scope: text({ enum: asEnumValues(GUEST_ABUSE_SCOPES) }).notNull(),
    axis: text({ enum: asEnumValues(GUEST_ABUSE_AXES) }).notNull(),
    /**
     * The keyed digest of the subject. PROTECTED: a keyed digest is an
     * exact-match oracle, so anybody holding a candidate value can test it.
     */
    subjectHash: text().notNull(),
    /** The window this row counts. */
    windowStartedAt: timestamptz().notNull(),
    /** How many. */
    attemptCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf('guest_abuse_counters_scope_check', table.scope, GUEST_ABUSE_SCOPES),
    checkOneOf('guest_abuse_counters_axis_check', table.axis, GUEST_ABUSE_AXES),
    check('guest_abuse_counters_count_check', sql`${table.attemptCount} >= 0`),
    /** The upsert arbiter. Every increment is one statement against this key. */
    uniqueIndex('guest_abuse_counters_window_key').on(
      table.scope,
      table.axis,
      table.subjectHash,
      table.windowStartedAt,
    ),
    /** The retention sweep's supporting index. */
    index('guest_abuse_counters_window_started_idx').on(table.windowStartedAt),
  ],
);

/**
 * `guest_abuse_interventions` — the friction that was applied, why, and what
 * an operator later decided about it.
 *
 * #111 abuse controls 9 and 10 in one table: every intervention is an EXPLICIT
 * measure the person is told about, and every one can be corrected. The
 * `false_positive` state is kept rather than deleted, because "how often is
 * this control wrong" is a metric the issue asks for and a deleted row answers
 * it with silence.
 */
export const guestAbuseInterventions = pgTable(
  'guest_abuse_interventions',
  {
    id: generatedId(),
    /** The named pattern that fired. */
    pattern: text({ enum: asEnumValues(GUEST_ABUSE_PATTERNS) }).notNull(),
    scope: text({ enum: asEnumValues(GUEST_ABUSE_SCOPES) }).notNull(),
    axis: text({ enum: asEnumValues(GUEST_ABUSE_AXES) }).notNull(),
    /** The same keyed digest the counter carries. PROTECTED. */
    subjectHash: text().notNull(),
    /**
     * What was applied. Every member is something the requester is TOLD — a
     * silent failure and a shadow ban have no representation here, which is
     * what makes "explicit policy, never silent shadow failure" structural.
     */
    measure: text({ enum: asEnumValues(GUEST_FRICTION_MEASURES) }).notNull(),
    /** The count that triggered it, and the threshold it crossed. Both, so a review can judge. */
    observedCount: integer().notNull(),
    thresholdCount: integer().notNull(),
    state: text({ enum: asEnumValues(GUEST_INTERVENTION_STATES) })
      .notNull()
      .default('active'),
    /** When the friction stops applying on its own. */
    expiresAt: timestamptz().notNull(),
    /** An operator's correction. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
    reviewNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf('guest_abuse_interventions_pattern_check', table.pattern, GUEST_ABUSE_PATTERNS),
    checkOneOf('guest_abuse_interventions_scope_check', table.scope, GUEST_ABUSE_SCOPES),
    checkOneOf('guest_abuse_interventions_axis_check', table.axis, GUEST_ABUSE_AXES),
    checkOneOf('guest_abuse_interventions_measure_check', table.measure, GUEST_FRICTION_MEASURES),
    checkOneOf('guest_abuse_interventions_state_check', table.state, GUEST_INTERVENTION_STATES),
    check(
      'guest_abuse_interventions_counts_check',
      sql`${table.observedCount} >= ${table.thresholdCount} and ${table.thresholdCount} > 0`,
    ),
    /**
     * A REVIEWED state is attributable and dated; an unreviewed one is neither.
     * Two implications rather than one over the conjunction, the shape this
     * schema now writes every "present exactly when" CHECK in.
     */
    check(
      'guest_abuse_interventions_review_shape_check',
      sql`(${table.state} in ('lifted', 'false_positive')) = (${table.reviewedByOxyUserId} is not null) and (${table.reviewedByOxyUserId} is null) = (${table.reviewedAt} is null)`,
    ),
    check(
      'guest_abuse_interventions_note_length_check',
      sql`${table.reviewNote} is null or length(${table.reviewNote}) <= ${sql.raw(String(MAX_GOVERNANCE_REASON_LENGTH))}`,
    ),
    /**
     * ONE live intervention per (pattern, subject), so a control that keeps
     * firing extends rather than stacking. A lifted or expired row does not
     * occupy the index.
     */
    uniqueIndex('guest_abuse_interventions_live_key')
      .on(table.pattern, table.subjectHash)
      .where(sql`state = 'active'`),
    index('guest_abuse_interventions_expires_idx').on(table.expiresAt),
    index('guest_abuse_interventions_state_idx').on(table.state, table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Security monitoring                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `guest_security_signal_counters` — one count per signal per window.
 *
 * There is no subject column and there must never be one. Every other counter
 * in this domain is keyed on a subject because it exists to LIMIT that subject;
 * these exist to tell an operator that something is happening more than usual,
 * and a subject column would turn a monitoring table into a record of who
 * failed to authenticate — which is the log of unconsented activity the
 * counter shape was chosen to avoid.
 *
 * The correlation columns are the ONE exception and are bounded by the signal's
 * own `correlationKinds`: an id that authorizes nothing, present only where an
 * alert genuinely cannot be acted on without it (a cross-order authorization
 * failure is meaningless without the group it was about).
 */
export const guestSecuritySignalCounters = pgTable(
  'guest_security_signal_counters',
  {
    id: generatedId(),
    signal: text({ enum: asEnumValues(GUEST_SECURITY_SIGNALS) }).notNull(),
    windowStartedAt: timestamptz().notNull(),
    observationCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf(
      'guest_security_signal_counters_signal_check',
      table.signal,
      GUEST_SECURITY_SIGNALS,
    ),
    check('guest_security_signal_counters_count_check', sql`${table.observationCount} >= 0`),
    uniqueIndex('guest_security_signal_counters_window_key').on(
      table.signal,
      table.windowStartedAt,
    ),
    index('guest_security_signal_counters_window_started_idx').on(table.windowStartedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Rollout                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `guest_launch_gate_signoffs` — one row per gate per stage, APPEND-ONLY.
 *
 * Append-only against UPDATE and DELETE by trigger, the `buyer_request_events`
 * posture: a sign-off somebody later edited is not a sign-off, and the whole
 * value of this table is that it can be read back months afterwards to answer
 * "who said this was ready, and when".
 *
 * A WITHDRAWAL is a new row with `satisfied = 'no'`, never an edit — the
 * `catalog_corrections` shape. The advance gate reads the LATEST row per
 * (stage, gate), so a withdrawal takes effect immediately and the history of
 * both decisions survives.
 */
export const guestLaunchGateSignoffs = pgTable(
  'guest_launch_gate_signoffs',
  {
    id: generatedId(),
    stage: text({ enum: asEnumValues(GUEST_ROLLOUT_STAGES) }).notNull(),
    gate: text({ enum: asEnumValues(GUEST_LAUNCH_GATES) }).notNull(),
    /** The discipline that owns it, snapshotted so a register change cannot rewrite history. */
    discipline: text({ enum: asEnumValues(GUEST_SIGNOFF_DISCIPLINES) }).notNull(),
    /** Whether it is satisfied. A withdrawal is a later row saying `no`. */
    satisfied: text({ enum: ['yes', 'no'] }).notNull(),
    /** Who. Mandatory — an anonymous sign-off is not one. */
    signedByOxyUserId: text().notNull(),
    /** A document, ticket or run reference. Bounded; never the document. */
    evidenceRef: text(),
    /** Why. Bounded. */
    note: text(),
    createdAt: createdAt(),
  },
  (table) => [
    checkOneOf('guest_launch_gate_signoffs_stage_check', table.stage, GUEST_ROLLOUT_STAGES),
    checkOneOf('guest_launch_gate_signoffs_gate_check', table.gate, GUEST_LAUNCH_GATES),
    checkOneOf(
      'guest_launch_gate_signoffs_discipline_check',
      table.discipline,
      GUEST_SIGNOFF_DISCIPLINES,
    ),
    check(
      'guest_launch_gate_signoffs_evidence_ref_length_check',
      sql`${table.evidenceRef} is null or length(${table.evidenceRef}) <= ${sql.raw(String(MAX_GOVERNANCE_EVIDENCE_REF_LENGTH))}`,
    ),
    check(
      'guest_launch_gate_signoffs_note_length_check',
      sql`${table.note} is null or length(${table.note}) <= ${sql.raw(String(MAX_GOVERNANCE_REASON_LENGTH))}`,
    ),
    index('guest_launch_gate_signoffs_stage_gate_idx').on(
      table.stage,
      table.gate,
      table.createdAt,
    ),
  ],
);

/**
 * `guest_rollout_stage_advances` — one row per ATTEMPT to advance a stage,
 * refusals included.
 *
 * `payment_repairs`'s posture, and for its reason: the attempts that were
 * REFUSED are the interesting half. A table holding only successful advances
 * answers "how did we get here" and cannot answer "what did we try, and what
 * stopped us", which is the question an incident review asks.
 *
 * There is deliberately no "current stage" column anywhere in the schema. The
 * current stage is the latest PERMITTED advance, derived — the
 * `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken here because a stored pointer plus an append-only history is two
 * representations of one fact and the one that would be wrong is the one an
 * operator reads.
 */
export const guestRolloutStageAdvances = pgTable(
  'guest_rollout_stage_advances',
  {
    id: generatedId(),
    /** The stage the advance was TO. */
    stage: text({ enum: asEnumValues(GUEST_ROLLOUT_STAGES) }).notNull(),
    outcome: text({ enum: ['permitted', 'refused'] }).notNull(),
    /** Present exactly when refused. */
    refusal: text({ enum: asEnumValues(GUEST_STAGE_ADVANCE_REFUSALS) }),
    /** Which gates were not satisfied. Empty for a permitted advance. */
    unsatisfiedGates: text().array().notNull().default(sql`'{}'::text[]`),
    /** Who asked. Mandatory. */
    requestedByOxyUserId: text().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (table) => [
    checkOneOf('guest_rollout_stage_advances_stage_check', table.stage, GUEST_ROLLOUT_STAGES),
    checkOneOf(
      'guest_rollout_stage_advances_refusal_check',
      table.refusal,
      GUEST_STAGE_ADVANCE_REFUSALS,
    ),
    checkEveryElementOf(
      'guest_rollout_stage_advances_gates_check',
      table.unsatisfiedGates,
      GUEST_LAUNCH_GATES,
    ),
    check(
      'guest_rollout_stage_advances_outcome_shape_check',
      sql`(${table.outcome} = 'refused') = (${table.refusal} is not null)`,
    ),
    /** A permitted advance names no unsatisfied gate. `cardinality`, never `array_length`. */
    check(
      'guest_rollout_stage_advances_permitted_gates_check',
      sql`${table.outcome} = 'refused' or cardinality(${table.unsatisfiedGates}) = 0`,
    ),
    check(
      'guest_rollout_stage_advances_note_length_check',
      sql`${table.note} is null or length(${table.note}) <= ${sql.raw(String(MAX_GOVERNANCE_REASON_LENGTH))}`,
    ),
    index('guest_rollout_stage_advances_outcome_idx').on(table.outcome, table.createdAt),
  ],
);

/**
 * `guest_data_class_dispositions` — what one request actually did to one class.
 *
 * The receipt on `guest_data_requests` is a SUMMARY the requester is shown;
 * this is the per-class evidence an auditor reads, with the table and row count
 * each disposition touched. Separate because they are answers to different
 * questions and have different readers: the summary must be composable into one
 * message, and the evidence must be joinable to a retention run.
 *
 * It holds counts and table NAMES. No value from any class reaches it, which is
 * the same rule the retention runs follow and for the same reason.
 */
export const guestDataClassDispositions = pgTable(
  'guest_data_class_dispositions',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => guestDataRequests.id, { onDelete: 'cascade' }),
    dataClass: text({ enum: asEnumValues(GUEST_DATA_CLASSES) }).notNull(),
    disposition: text({ enum: asEnumValues(GUEST_DATA_DISPOSITIONS) }).notNull(),
    /** Present exactly when the disposition is `retained_under_obligation`. */
    retainedReason: text({ enum: asEnumValues(GUEST_DATA_RETENTION_REASONS) }),
    /** How many rows were touched. Zero is a real answer and is not an error. */
    affectedRowCount: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    checkOneOf('guest_data_class_dispositions_class_check', table.dataClass, GUEST_DATA_CLASSES),
    checkOneOf(
      'guest_data_class_dispositions_disposition_check',
      table.disposition,
      GUEST_DATA_DISPOSITIONS,
    ),
    checkOneOf(
      'guest_data_class_dispositions_reason_check',
      table.retainedReason,
      GUEST_DATA_RETENTION_REASONS,
    ),
    check(
      'guest_data_class_dispositions_reason_shape_check',
      sql`(${table.disposition} = 'retained_under_obligation') = (${table.retainedReason} is not null)`,
    ),
    check(
      'guest_data_class_dispositions_rows_check',
      sql`${table.affectedRowCount} >= 0`,
    ),
    /** One disposition per class per request. A second is a bug, not a correction. */
    uniqueIndex('guest_data_class_dispositions_request_class_key').on(
      table.requestId,
      table.dataClass,
    ),
  ],
);
