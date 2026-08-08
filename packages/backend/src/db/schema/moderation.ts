/**
 * CrowdSource moderation: `abuse_reports`, `moderation_outboxes`,
 * `moderation_events`, `moderation_enforcements`.
 *
 * Nothing in this file is an ordinary CRUD table. Each one exists to make a
 * specific failure impossible, and the constraint IS the mechanism:
 *
 *  - `abuse_reports` — one report per reporter per object, held by a UNIQUE
 *    index rather than a service check, because two taps on a report button race
 *    and the loser must not open a second case.
 *  - `moderation_outboxes` — the durable promise that moderation work will
 *    happen. Its primary key is a DETERMINISTIC string, so a transaction retry, a
 *    duplicate submission or a redelivered webhook converges on one row.
 *  - `moderation_events` — the webhook dedupe claim. The unique INSERT is the
 *    claim; there is no read-then-write gap for a redelivery to land in.
 *  - `moderation_enforcements` — the exactly-once lock on a real-world effect.
 *    `UNIQUE(decision_id, revision, action)` is the only thing standing between
 *    an enforcement retry and a double takedown.
 *
 * Two of the four have a CALLER-SUPPLIED primary key and therefore no default —
 * that absence is the contract, not an omission.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  ABUSE_REPORT_CATEGORIES,
  ABUSE_REPORTED_TYPES,
  MODERATION_ENFORCEMENT_ACTIONS,
  type AbuseReportLocalStatus,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { ALL_LISTING_STATUSES } from '@mercaria/shared-types';
import { REVIEW_STATUSES } from './buyers';

/** `AbuseReport.localStatus`. */
export const ABUSE_REPORT_LOCAL_STATUSES: readonly AbuseReportLocalStatus[] = [
  'received',
  'queued',
  'delivered',
  'delivery_failed',
  'decided',
];

/** `ModerationOutbox.kind`. */
export const MODERATION_OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;

/** `ModerationOutbox.status`. */
export const MODERATION_OUTBOX_STATUSES = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
] as const;

/** Bound on the operator-facing explanation — `MAX_REASON_LENGTH`. */
const MAX_REASON_LENGTH = 300;
/** Bound on a reporter's free text — `MAX_DETAILS_LENGTH`. */
const MAX_DETAILS_LENGTH = 2_000;
/** Bound on a stored dispatch error — the `.slice(0, 2_000)` in the outbox service. */
const MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * `abuse_reports` — a user telling Mercaria that something is wrong.
 *
 * Nothing to do with `report.service.ts` or `/admin/stores/:storeId/reports/*`,
 * which are the store SALES ANALYTICS surface and share only the word.
 *
 * `local_status` tracks the REPORT, never the case. Whether CrowdSource has
 * decided anything is CrowdSource's to say; this column records only what this
 * deployment knows about its own copy.
 *
 * The row's own `id` LEAVES this system — it is sent as CrowdSource's
 * `externalReportId` and forms part of their idempotency key. That is one of the
 * concrete reasons ids are carried across verbatim rather than remapped.
 */
export const abuseReports = pgTable(
  'abuse_reports',
  {
    id: generatedId(),
    reportedType: text({ enum: asEnumValues(ABUSE_REPORTED_TYPES) }).notNull(),
    /**
     * The reported object. POLYMORPHIC by `reported_type` — it addresses
     * `listings`, `reviews`, `seller_profiles` or `stores` depending on the row,
     * so no single foreign key can express it. Permanently unconstrained.
     */
    reportedId: text().notNull(),
    /** An Oxy account id — no foreign key. */
    reporterOxyUserId: text().notNull(),
    categories: text().array().notNull(),
    details: text(),
    localStatus: text({ enum: asEnumValues(ABUSE_REPORT_LOCAL_STATUSES) })
      .notNull()
      .default('received'),
    localStatusReason: text(),
    /** CrowdSource's own report id, once delivery succeeded — a foreign key space. */
    crowdSourceReportId: text(),
    /** CrowdSource's case id; inbound decisions name the CASE, never the report. */
    crowdSourceCaseId: text(),
    /**
     * SHA-256 of the exact representation sent for review, so a decision about an
     * older version of a listing stays identifiable as such after the seller has
     * edited it.
     */
    snapshotHash: text(),
    deliveredAt: timestamptz(),
    decidedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('abuse_reports_reported_type_check', t.reportedType, ABUSE_REPORTED_TYPES),
    checkOneOf('abuse_reports_local_status_check', t.localStatus, ABUSE_REPORT_LOCAL_STATUSES),
    checkEveryElementOf(
      'abuse_reports_categories_check',
      t.categories,
      ABUSE_REPORT_CATEGORIES,
    ),
    // A report with no category is not a report. Mongoose's `required: true` on
    // an array accepts `[]`; this does not.
    check('abuse_reports_categories_present_check', sql`array_length(${t.categories}, 1) >= 1`),
    // Mongoose `maxlength` is APPLICATION behaviour and does not survive the port
    // by itself. Both bounds are on operator- and reporter-supplied free text that
    // is already truncated at the call site, so the CHECK cannot reject a row the
    // code would produce — it stops a future writer forgetting to truncate.
    check(
      'abuse_reports_details_length_check',
      sql`${t.details} is null or length(${t.details}) <= ${sql.raw(String(MAX_DETAILS_LENGTH))}`,
    ),
    check(
      'abuse_reports_local_status_reason_length_check',
      sql`${t.localStatusReason} is null or length(${t.localStatusReason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    // One report per reporter per object. A unique index rather than a
    // service-layer check: the intake transaction reads first for a friendly
    // error, but THIS is what actually holds when two taps race.
    uniqueIndex('abuse_reports_reporter_reported_key').on(
      t.reporterOxyUserId,
      t.reportedType,
      t.reportedId,
    ),
    /** Operator sweep: what is owed delivery, and what is stuck. */
    index('abuse_reports_local_status_created_at_idx').on(t.localStatus, t.createdAt.desc()),
    // Every report about one object — what enforcement resolves a decision
    // against, and the key of the `decided` fan-out, which updates EVERY report
    // about the same object rather than just the one that opened the case.
    index('abuse_reports_reported_created_at_idx').on(
      t.reportedType,
      t.reportedId,
      t.createdAt.desc(),
    ),
    index('abuse_reports_crowd_source_case_id_idx')
      .on(t.crowdSourceCaseId)
      .where(sql`${t.crowdSourceCaseId} is not null`),
  ],
);

/**
 * `moderation_outboxes` — the durable promise that moderation work will happen.
 *
 * A row here is not a hint that work exists; it IS the work. An in-memory queue,
 * a BullMQ job or a detached promise all evaporate when a task restarts, and
 * moderation work that evaporates does so silently: a reporter was told 201, a
 * case never opened, and nothing reports an error.
 *
 * ## The primary key has NO DEFAULT, and that is the whole design
 *
 * `id` is a deterministic string derived from the thing being done
 * (`moderation:report.submit:<reportId>`), never generated. That is what makes a
 * transaction retry, a duplicate submission or a redelivered webhook converge on
 * the SAME row instead of queueing the work twice. A table whose id is supplied
 * by its caller says so by having no default — `generatedId()` here would
 * silently turn every retry into a second delivery.
 *
 * ## The enqueue must be a genuine no-op on a repeat
 *
 * Under Mongo this needed `timestamps: false` on that one `updateOne`, because
 * letting Mongoose own the timestamps left a `$set: { updatedAt }` on the update
 * and turned a repeat into a real write — contending with the dispatcher's live
 * lease on the same row. The Postgres form is `on conflict (id) do nothing`,
 * which has the property natively. `do update` would reintroduce exactly the bug
 * the Mongo flag was added to fix.
 */
export const moderationOutboxes = pgTable(
  'moderation_outboxes',
  {
    /**
     * A DETERMINISTIC id supplied by the caller — deliberately no default. See
     * the table docblock; this absence is the idempotency.
     */
    id: text().primaryKey(),
    kind: text({ enum: asEnumValues(MODERATION_OUTBOX_KINDS) }).notNull(),
    /**
     * The job payload — `{reportId}` or `{event}`, keyed by `kind`.
     *
     * jsonb, and legitimately: for `decision.apply` this holds the entire
     * verified `WebhookEventEnvelope` exactly as CrowdSource delivered it. A
     * published decision is deliberately LOOSE, and projecting it into columns
     * would silently drop whatever a newer CrowdSource version added — which is
     * the one thing a moderation payload must never do.
     *
     * Deliberately minimal for `report.submit`: an ID, not a snapshot. The row
     * says WHICH report to deliver and the worker rebuilds the material from the
     * live tables at send time. Storing a composed envelope here would freeze a
     * copy of the listing in the queue and make the outbox a second, drifting
     * source of truth.
     */
    payload: jsonb().$type<{ reportId?: string; event?: Record<string, unknown> }>().notNull(),
    status: text({ enum: asEnumValues(MODERATION_OUTBOX_STATUSES) })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    /**
     * Set at insert and never advanced, so a row that never reaches a terminal
     * state still leaves eventually rather than accumulating forever. Swept by
     * `db/expiryTargets.ts` — Postgres has no TTL index, and a table ported
     * without a registry entry grows FOREVER with no error and no failing test.
     */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('moderation_outboxes_kind_check', t.kind, MODERATION_OUTBOX_KINDS),
    checkOneOf('moderation_outboxes_status_check', t.status, MODERATION_OUTBOX_STATUSES),
    check('moderation_outboxes_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'moderation_outboxes_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MAX_LAST_ERROR_LENGTH))}`,
    ),
    // The claim query is a two-branch `or`: due PENDING work, and PROCESSING work
    // whose lease has expired (a dead task's, being reclaimed). One index per
    // branch, each partial, so neither scans the other branch's rows. Both carry
    // `created_at` because the claim takes the oldest first.
    index('moderation_outboxes_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('moderation_outboxes_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    // The leading btree the expiry sweep needs; see `expiresAt`.
    index('moderation_outboxes_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `moderation_events` — the webhook dedupe claim, shared across tasks.
 *
 * The SDK defaults to an IN-PROCESS store, which is correct for a single
 * instance and wrong here: the API runs several ECS tasks behind one ALB, so the
 * two copies of a redelivered event routinely land on DIFFERENT tasks. An
 * in-process store would dedupe only the task unlucky enough to receive both.
 *
 * A claim is an INSERT, not a read-then-write: whoever wins the unique `id` runs
 * the handler. A handler that throws RELEASES its claim by deleting the row, so
 * the retry still works — which is why there is no "failed" state to record.
 *
 * ## `completed_at` is NOT ported
 *
 * The Mongoose model declared it and nothing ever wrote it or read it: the store
 * is claim-then-DELETE, never claim-then-mark-complete, exactly as the model's
 * own header says. A column that no code path can ever populate is Mongo baggage.
 *
 * ## No `created_at` / `updated_at`
 *
 * The source schema has `timestamps` off — `claimed_at` is the only date this
 * row has ever had, and adding two more that can disagree with it is precisely
 * the redundancy this port removes.
 */
export const moderationEvents = pgTable(
  'moderation_events',
  {
    /** The CrowdSource event id, exactly as delivered. Caller-supplied — no default. */
    id: text().primaryKey(),
    eventType: text().notNull(),
    claimedAt: timestamptz().notNull(),
    /** Swept by `db/expiryTargets.ts`; must outlive every redelivery of its event. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [index('moderation_events_expires_at_idx').on(t.expiresAt)],
);

/**
 * `moderation_enforcements` — the ledger of what Mercaria did, and the lock that
 * makes it happen exactly once.
 *
 * Each action CLAIMS its row before acting; a second attempt — a redelivered
 * webhook, a reclaimed outbox lease, an operator replay — loses the insert and
 * does nothing. Checking "have I done this?" and then acting leaves a gap
 * between the two, and that gap is precisely when a redelivery arrives.
 *
 * `revision` is IN the key, not merely stored beside it. A correction (an
 * accepted appeal) arrives as a NEW revision of the same decision, and its
 * `restore` has to be a different action from the `restrict` it supersedes. Drop
 * `revision` from the key and the restore collides with the removal, loses, and
 * the seller's listing stays down forever — with the case saying it was fine and
 * no error anywhere.
 *
 * ## `previous_state` is three columns, and they are CHECKed
 *
 * Mongo declared `listingStatus` and `reviewStatus` as bare `String` with no
 * enum, and `restore` reads them back and writes them straight into
 * `Listing.status` / `Review.status`. So an enforcement row holding a status
 * value those tables do not accept is a failure that surfaces only at RESTORE
 * time — when a seller is waiting for their listing back.
 *
 * CHECKing the snapshot against the SAME value sets its destination columns use
 * moves that failure to the write that created the bad row, and introduces no
 * new rejection: a value that passes here passes there by construction.
 */
export const moderationEnforcements = pgTable(
  'moderation_enforcements',
  {
    id: generatedId(),
    /** CrowdSource's decision id — a foreign service's key, no foreign key. */
    decisionId: text().notNull(),
    revision: integer().notNull(),
    action: text({ enum: asEnumValues(MODERATION_ENFORCEMENT_ACTIONS) }).notNull(),
    /** CrowdSource's case id — a foreign service's key, no foreign key. */
    caseId: text(),
    /** Mercaria's own noun: `listing`, `review`, `seller`, `store`. */
    subjectType: text({ enum: asEnumValues(ABUSE_REPORTED_TYPES) }).notNull(),
    /** POLYMORPHIC by `subject_type` — permanently unconstrained, as on the report. */
    subjectId: text().notNull(),
    /**
     * Whether the effect actually happened.
     *
     * `false` covers three genuinely different situations, which is why `reason`
     * is NOT NULL beside it: observe/manual mode declined to act, there was
     * nothing to undo, or the object no longer exists. All three are evidence;
     * none is a failure.
     */
    applied: boolean().notNull(),
    reason: text().notNull(),
    /** The recommendation this came from, when it came from one rather than severity. */
    recommendedAction: text(),
    // `previousState` — what was replaced, so a reversal has something true to
    // put back rather than a guess at `active`. Three columns, never partially
    // updated: each effect writes exactly one of them.
    previousStateListingStatus: text({ enum: asEnumValues(ALL_LISTING_STATUSES) }),
    previousStateReviewStatus: text({ enum: asEnumValues(REVIEW_STATUSES) }),
    /** The orders a `freeze_transaction` held — released one by one by `restore`. */
    previousStateHeldOrderIds: text().array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'moderation_enforcements_action_check',
      t.action,
      MODERATION_ENFORCEMENT_ACTIONS,
    ),
    checkOneOf('moderation_enforcements_subject_type_check', t.subjectType, ABUSE_REPORTED_TYPES),
    checkOneOf(
      'moderation_enforcements_previous_listing_status_check',
      t.previousStateListingStatus,
      ALL_LISTING_STATUSES,
    ),
    checkOneOf(
      'moderation_enforcements_previous_review_status_check',
      t.previousStateReviewStatus,
      REVIEW_STATUSES,
    ),
    check('moderation_enforcements_revision_check', sql`${t.revision} >= 0`),
    // Appendix D's idempotency key. The claim that makes enforcement exactly-once,
    // and the only thing between a retry and a double takedown.
    uniqueIndex('moderation_enforcements_decision_revision_action_key').on(
      t.decisionId,
      t.revision,
      t.action,
    ),
    // "What was done to this object, most recently?" — how a `restore` finds the
    // state its `restrict` displaced. PARTIAL on `applied`, because every such
    // lookup filters `applied: true` and the not-applied rows (observe mode
    // records one for every decision) would otherwise dominate the index.
    index('moderation_enforcements_subject_created_at_idx')
      .on(t.subjectType, t.subjectId, t.createdAt.desc())
      .where(sql`${t.applied}`),
  ],
);
