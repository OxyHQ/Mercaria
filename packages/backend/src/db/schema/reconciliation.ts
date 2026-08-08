/**
 * Reconciliation: `reconciliation_cursors`, `payment_discrepancies`,
 * `payment_repairs`.
 *
 * Issue #50. `./payments` records what money DID; these three record what
 * Mercaria has NOTICED is wrong with that record, where each sweep had got to
 * when it stopped, and what a person did about it.
 *
 * ## Nothing here is financial history, and that is why it may be updated
 *
 * `./ledger` is append-only behind a trigger, because a book somebody can edit
 * is a book nobody can rely on. These tables are the opposite kind of thing: a
 * cursor MOVES (that is its whole function), and a discrepancy that is still
 * being seen on every sweep must be able to say so without opening a new row per
 * run. So they carry `updated_at` and take ordinary UPDATEs.
 *
 * The boundary is exact and worth stating, because it is the one a reader will
 * check: nothing in this file is ever an INPUT to an amount. A discrepancy
 * describes a disagreement between two records that already exist; repairing one
 * writes to `ledger_transactions` through the same repository every other
 * posting uses, and `payment_repairs` records that this happened. Deleting every
 * row in this file would lose Mercaria's knowledge of its own mistakes and not a
 * cent of its accounts.
 *
 * ## Why the correlations here carry no foreign key either
 *
 * The same rule `./payments` states, one layer out and for a sharper reason: the
 * whole point of `payment_missing_locally` is a provider object with NO Mercaria
 * payment behind it. A constraint on `payment_id` would be satisfiable only by
 * the discrepancies that are least worth recording, and the row that matters
 * most — money the rail holds and Mercaria cannot explain — would be the one the
 * database refused to write.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  PAYMENT_DISCREPANCY_KINDS,
  PAYMENT_DISCREPANCY_SEVERITIES,
  PAYMENT_DISCREPANCY_STATUSES,
  PAYMENT_PROVIDER_IDS,
  PAYMENT_REPAIR_ACTIONS,
  PAYMENT_REPAIR_OUTCOMES,
  RECONCILIATION_JOBS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/** Bound on a stored sweep error or an operator's prose — the `.slice()` at every writer. */
const MAX_NOTE_LENGTH = 2_000;

/**
 * `reconciliation_cursors` — where each sweep had got to, and who is running it.
 *
 * ## One row per job, and the job name IS the primary key
 *
 * There is no `generatedId()` here. A job's cursor is a singleton by definition
 * — "where did `provider_objects` get to" has exactly one answer — so a
 * generated id would make it possible to have two, and two cursors for one sweep
 * is two sweeps that each think they are complete. The caller-supplied key
 * follows `payment_outboxes`, whose id is deterministic for the same reason:
 * the determinism IS the constraint.
 *
 * ## The lease and the cursor are ONE row, deliberately
 *
 * The outbox needs a separate lease per unit of work because it has many units.
 * A sweep has one, and the thing a second task must not do is run it
 * concurrently — so the claim is a compare-and-swap on this row's
 * `lease_until`, taken with `for update skip locked` so N tasks contend for a
 * fraction of a millisecond and exactly one proceeds.
 *
 * That is stricter than the connected-account sweep next door (#46), which needs
 * no lease at all because a sync is an OBSERVATION and the freshest one wins.
 * These sweeps are not observations: they WRITE discrepancy rows and page
 * through a provider's list with a cursor, and two tasks sharing one cursor
 * would each advance it past pages the other read.
 *
 * ## `cursor` is the PROVIDER's pagination token, and it may be null forever
 *
 * `ledger_audit` paginates nothing — it is two SQL aggregates and a bounded
 * join — so its row exists only for the lease and the run times. A nullable
 * column that some jobs never use is the honest shape here; splitting the table
 * in two to avoid it would put the lease protocol in two places.
 */
export const reconciliationCursors = pgTable(
  'reconciliation_cursors',
  {
    /** The job name. A caller-supplied singleton key — deliberately no default. */
    id: text().primaryKey(),
    /**
     * The provider's own pagination token for the page AFTER the last one fully
     * processed, or NULL to start from the beginning of the window.
     *
     * Advanced only once a page has been fully handled, which is what makes an
     * interrupted run resume without double-processing: a task that dies
     * mid-page leaves the cursor where it was, and the next run replays that
     * page against detections that are all deduped on `(kind, correlation_key)`.
     */
    cursor: text(),
    /**
     * The oldest instant this job still has to look at.
     *
     * Separate from `cursor` because they answer different questions: the cursor
     * says where in a page sequence the job is, and this says which WINDOW that
     * sequence covers. A job that has completed a full pass moves this forward
     * and clears the cursor, so the next pass is bounded by work done rather
     * than by a fixed lookback that re-reads the same month forever.
     */
    windowStartAt: timestamptz(),
    /** When a run last began. Diagnostic — a stuck sweep is visible as a stale value. */
    lastRunAt: timestamptz(),
    /** When a full pass last finished. NULL until the first one completes. */
    lastCompletedAt: timestamptz(),
    /** What the last run said, when it failed. Never a payload, never a secret. */
    lastError: text(),
    /** Which task holds the run lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('reconciliation_cursors_id_check', t.id, RECONCILIATION_JOBS),
    check(
      'reconciliation_cursors_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // A lease has an owner and an owner has a lease. Half a lease is a row no
    // claim query can reason about: `lease_until` in the past with an owner set
    // is a reclaimable run, and both NULL is a free one, but an owner with no
    // deadline would be a lease nothing can ever expire.
    check(
      'reconciliation_cursors_lease_complete_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
  ],
);

/**
 * `payment_discrepancies` — one disagreement Mercaria has noticed about itself.
 *
 * ## The dedupe key is `(kind, correlation_key)` and it is the whole design
 *
 * A sweep is periodic, so it sees the same unresolved problem on every run. If
 * each sighting were a row, the queue would grow without bound and the loudest
 * discrepancy would be the oldest one rather than the worst. So a repeat sighting
 * BUMPS `last_seen_at` and `occurrences` on the row that already exists, and the
 * unique index below is what makes that an upsert instead of a read-then-write
 * two tasks can both lose.
 *
 * `correlation_key` is composed by the detector from the durable ids the finding
 * is ABOUT (`<paymentId>`, `<transferProviderObjectId>`, `<orderId>:<currency>`),
 * never from a timestamp or a run id — both of which would make every sighting
 * unique and defeat the index silently rather than loudly.
 *
 * ## `detail` is jsonb, and it is REDACTED
 *
 * The one genuinely open-shaped column here: each kind carries different figures
 * (two amounts and a currency; a status pair; a per-currency imbalance), and a
 * column set that fitted all fourteen would be mostly NULL and still wrong for
 * the fifteenth. It earns `jsonb` on `CONVENTIONS.md`'s own terms.
 *
 * What it must never be is a provider payload. Detectors put Mercaria's own ids,
 * amounts, currencies and statuses here — the same allow-list
 * `redactProviderPayload` applies — because this column is read by the operator
 * surface and rendered whole.
 *
 * ## The resolution fields are all-or-nothing, and a reopen clears them
 *
 * The CHECK below pins `status = 'resolved'` to `resolved_at is not null`. A
 * sweep that sees a RESOLVED discrepancy again reopens it and clears these,
 * because a resolution that did not hold is not a resolution — and the audit is
 * not lost, because `payment_repairs` is append-only and keeps every attempt.
 */
export const paymentDiscrepancies = pgTable(
  'payment_discrepancies',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(PAYMENT_DISCREPANCY_KINDS) }).notNull(),
    severity: text({ enum: asEnumValues(PAYMENT_DISCREPANCY_SEVERITIES) }).notNull(),
    status: text({ enum: asEnumValues(PAYMENT_DISCREPANCY_STATUSES) })
      .notNull()
      .default('open'),
    /** Which rail the finding is about. */
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    /**
     * What makes this finding THIS finding, within its kind. See the table
     * docblock — it is composed from durable ids and never from a clock.
     */
    correlationKey: text().notNull(),
    /**
     * The payment, when there is one. No foreign key, and the reason is the
     * sharpest instance of this domain's correlation rule — see the file
     * docblock.
     */
    paymentId: text(),
    /** The seller order, when the finding is per order. Correlation, no key. */
    orderId: text(),
    /** The checkout group, carried so a trace can be opened from the row. */
    checkoutGroupId: text(),
    /** The rail's own object the finding is about (`ch_…`, `tr_…`, `re_…`, `po_…`). */
    providerObjectId: text(),
    /** The figures behind the finding, redacted. See the table docblock. */
    detail: jsonb().$type<Record<string, unknown>>().notNull(),
    firstSeenAt: timestamptz().notNull(),
    lastSeenAt: timestamptz().notNull(),
    /** How many sweeps have seen it. A repeat bumps this rather than adding a row. */
    occurrences: integer().notNull().default(1),
    resolvedAt: timestamptz(),
    /** The Oxy operator who resolved it. No foreign key — Oxy owns identity. */
    resolvedBy: text(),
    /** A short machine-ish reason, for grouping resolutions. */
    resolvedReason: text(),
    /** The operator's own words. Never a payload, never a secret. */
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('payment_discrepancies_kind_check', t.kind, PAYMENT_DISCREPANCY_KINDS),
    checkOneOf('payment_discrepancies_severity_check', t.severity, PAYMENT_DISCREPANCY_SEVERITIES),
    checkOneOf('payment_discrepancies_status_check', t.status, PAYMENT_DISCREPANCY_STATUSES),
    checkOneOf('payment_discrepancies_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    // An empty string is a VALUE and would collide for real in the index below,
    // silently merging two different findings of one kind into one row.
    check('payment_discrepancies_correlation_key_check', sql`length(${t.correlationKey}) > 0`),
    check('payment_discrepancies_occurrences_check', sql`${t.occurrences} >= 1`),
    // Resolved means resolved BY somebody, AT a time, FOR a reason. Two of the
    // three would leave a row that says it was dealt with and cannot say by whom.
    check(
      'payment_discrepancies_resolution_complete_check',
      sql`(${t.status} = 'resolved') = (num_nonnulls(${t.resolvedAt}, ${t.resolvedBy}, ${t.resolvedReason}) = 3)`,
    ),
    check(
      'payment_discrepancies_resolution_note_length_check',
      sql`${t.resolutionNote} is null or length(${t.resolutionNote}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // The dedupe key — see the table docblock. This index is what turns a
    // periodic sweep from a row generator into a queue.
    uniqueIndex('payment_discrepancies_kind_correlation_key').on(t.kind, t.correlationKey),
    // The operator queue: what is still open, worst and oldest first. `severity`
    // is not in the index because the queue is small by construction — if it is
    // not, that is the alert, not a missing index.
    index('payment_discrepancies_open_idx')
      .on(t.status, t.lastSeenAt.desc())
      .where(sql`${t.status} <> 'resolved'`),
    // "What is wrong with this payment" — the trace's own join.
    index('payment_discrepancies_payment_id_idx')
      .on(t.paymentId, t.lastSeenAt.desc())
      .where(sql`${t.paymentId} is not null`),
    index('payment_discrepancies_order_id_idx')
      .on(t.orderId, t.lastSeenAt.desc())
      .where(sql`${t.orderId} is not null`),
    // The metrics aggregate: counts by kind over the open set.
    index('payment_discrepancies_kind_status_idx').on(t.kind, t.status),
  ],
);

/**
 * `payment_repairs` — every operator action against the payment domain, applied
 * or refused.
 *
 * ## Append-only by convention, not by trigger, and the difference is deliberate
 *
 * The ledger's trigger exists because `psql`, a backfill and a future service
 * all reach those tables without passing the repository. Nothing reaches this
 * table except the repair service, which inserts and never updates — so a
 * trigger here would guard a door with one door frame. What the table gets
 * instead is the property that actually matters: NO `updated_at`, which
 * `CONVENTIONS.md` makes the append-only contract, and one row per ATTEMPT
 * rather than one row per repair.
 *
 * One row per attempt is what makes this an audit trail rather than a status
 * column. A repair that was refused, then re-run after the operator fixed the
 * precondition, then applied, is three facts about a real sequence of decisions;
 * a single mutable row would remember only the last one, which is precisely the
 * one an auditor does not need.
 *
 * ## The partial unique index is the ONLY idempotency this table provides
 *
 * `UNIQUE(action, subject_key) WHERE action = 'book_reconciling_entry' AND
 * outcome = 'applied'`, and it is narrow because only that one action needs it.
 *
 * The three RETRY actions are idempotent already, at a layer this table cannot
 * improve on: each drives a service whose provider idempotency key is derived
 * from Mercaria's own durable ids (ADR 0001 D11 — `tr:<paymentId>:<orderId>`,
 * `re:<refundId>`, `trr:<refundId>:<orderId>`), so a second attempt converges on
 * the movement the first one made. Enforcing uniqueness on them HERE would be
 * worse than useless: it would refuse the legitimate second attempt after a
 * failure, which is the exact case an operator reaches for a repair in.
 *
 * `book_reconciling_entry` has no such underlying key — a correcting ledger
 * transaction booked twice is simply booked twice — so the claim has to live
 * here, and it lives in the same transaction as the posting it guards.
 *
 * ## `detail` carries the OUTCOME, never the request
 *
 * Issue #50's repair invariant 10: contact values and tokens stay out of repair
 * payloads and logs. The reason an operator gives is free text and is stored;
 * everything else here is ids, amounts and currencies the services returned.
 */
export const paymentRepairs = pgTable(
  'payment_repairs',
  {
    id: generatedId(),
    action: text({ enum: asEnumValues(PAYMENT_REPAIR_ACTIONS) }).notNull(),
    /**
     * What this attempt was ABOUT, composed per action from durable Mercaria ids
     * — `<paymentId>:<orderId>` for a withheld transfer, `<refundId>` for a
     * refund, the discrepancy id for a correcting entry. Half of the partial
     * unique index above, and the reason it can be partial at all.
     */
    subjectKey: text().notNull(),
    /**
     * The discrepancy this repair answers. Nullable because a repair may be run
     * from an exception queue that has no discrepancy row (a `transfer_withheld`
     * outbox row is a perfectly good reason to retry a transfer), and MANDATORY
     * for `book_reconciling_entry` by the CHECK below — a correcting ledger
     * entry with nothing to attach it to is an unexplained movement, which is
     * the one thing the ledger may not contain.
     */
    discrepancyId: text().references(() => paymentDiscrepancies.id, { onDelete: 'restrict' }),
    /** The Oxy operator who ran it. No foreign key — Oxy owns identity. */
    actorOxyUserId: text().notNull(),
    /** Why, in the operator's own words. Required by issue #50, repair invariant 9. */
    reason: text().notNull(),
    outcome: text({ enum: asEnumValues(PAYMENT_REPAIR_OUTCOMES) }).notNull(),
    /** What the services reported. Ids, amounts and currencies — see the docblock. */
    detail: jsonb().$type<Record<string, unknown>>().notNull(),
    /** The payment the repair touched, when it touched one. Correlation, no key. */
    paymentId: text(),
    /** The seller order, when the repair was per order. Correlation, no key. */
    orderId: text(),
    /** The ledger transaction a `book_reconciling_entry` wrote, when it wrote one. */
    ledgerTransactionId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('payment_repairs_action_check', t.action, PAYMENT_REPAIR_ACTIONS),
    checkOneOf('payment_repairs_outcome_check', t.outcome, PAYMENT_REPAIR_OUTCOMES),
    check('payment_repairs_subject_key_check', sql`length(${t.subjectKey}) > 0`),
    check('payment_repairs_actor_check', sql`length(${t.actorOxyUserId}) > 0`),
    // A reason is required and an empty one is not a reason. Bounded too: this
    // is operator prose arriving over HTTP.
    check(
      'payment_repairs_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // A correcting ledger entry names the discrepancy it corrects. See the
    // `discrepancyId` note — this is the constraint, not a convention.
    check(
      'payment_repairs_reconciling_entry_discrepancy_check',
      sql`${t.action} <> 'book_reconciling_entry' or ${t.discrepancyId} is not null`,
    ),
    // The one idempotency this table provides, and it is deliberately narrow —
    // see the table docblock for why the three retries must NOT be in it.
    uniqueIndex('payment_repairs_reconciling_entry_key')
      .on(t.action, t.subjectKey)
      .where(sql`${t.action} = 'book_reconciling_entry' and ${t.outcome} = 'applied'`),
    // The audit read: what has been done to this discrepancy, newest first.
    index('payment_repairs_discrepancy_id_idx')
      .on(t.discrepancyId, t.createdAt.desc())
      .where(sql`${t.discrepancyId} is not null`),
    // …and the same question asked from a payment, which is how a trace reaches it.
    index('payment_repairs_payment_id_idx')
      .on(t.paymentId, t.createdAt.desc())
      .where(sql`${t.paymentId} is not null`),
    index('payment_repairs_action_created_at_idx').on(t.action, t.createdAt.desc()),
  ],
);
