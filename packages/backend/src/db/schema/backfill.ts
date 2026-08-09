/**
 * The native-catalogue backfill — issue #60, bound by ADR 0002 D23/D24:
 * `catalog_backfill_runs`, `catalog_backfill_records`,
 * `catalog_consistency_findings`.
 *
 * A migration's failure mode is not "it stopped". It is a report that says the
 * migration went fine. A traversal that reads nothing, a page that swallowed its
 * own errors and a counter written by whichever code path last touched it all
 * produce exactly the output of a clean run, and the mistake is discovered when
 * somebody trusts the number. Every decision in this file exists to make that
 * particular lie unrepresentable.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **A run's counters must ADD UP to what it scanned.**
 *    `catalog_backfill_runs_counters_total_check` is
 *    `scanned = unchanged + matched + created + enqueued + review_required +
 *    unmatched + skipped + failed`. That is the vacuity floor as a CHECK: a
 *    stage that swallowed a record cannot write a row at all, and "zero failures
 *    over zero scanned" stops being indistinguishable from "zero failures over a
 *    million scanned" because the second number is in the same row and the
 *    database refuses to let them disagree.
 * 2. **Counters never go DOWN.** A pass is many bounded pages and every page
 *    adds to the same run row, so a monotonicity trigger is what stops a
 *    re-written total hiding a page that failed. `mercaria_backfill_run_counters_monotonic`
 *    raises on any UPDATE that lowers one, which no legitimate page ever does.
 * 3. **A record's IDENTITY is immutable.** `mercaria_backfill_record_identity_immutable`
 *    refuses an UPDATE that moves `mapping_version`, `mode`, `stage`,
 *    `subject_kind` or `subject_key`. The outcome of a subject may legitimately
 *    change on a re-run; WHICH subject a report row is about may not, or the
 *    dry-run report and the apply report stop being comparable — which is the
 *    only thing they exist for.
 * 4. **A dry run and an apply run can never overwrite each other**, because
 *    `mode` is part of the record's unique key
 *    (`UNIQUE(mapping_version, mode, stage, subject_key)`). Comparing the
 *    prediction against what happened is the whole of issue job behaviour 3, and
 *    it is impossible if the second run edits the first one's rows.
 * 5. **A subject has at most ONE open consistency finding per kind** — a partial
 *    unique `WHERE resolved_at IS NULL`. A sweep that runs hourly must converge
 *    rather than accumulate, and Postgres treats NULLs as distinct, so this is
 *    the `commerce_relationships.endpoint_key` device applied to a sweep.
 *
 * ## What is deliberately NOT here
 *
 * - **No canonical product or variant COLUMN on `listings` or
 *   `product_variants`.** The issue's migration step 1 offers "nullable
 *   canonical references on native records OR an equivalent mapping collection
 *   selected in #52", and ADR 0002 D6 selected the mapping collection:
 *   `native_listing_links`. Adding the columns as well would be a second
 *   representation of one attachment, and the two would disagree the first time
 *   a link was superseded. This domain writes `native_listing_links` through
 *   #57's own repository and holds no pointer of its own.
 * - **No `mapping_versions` TABLE.** The mapping rules are the deterministic
 *   rule set ADR 0002 D23 phase 1 fixes — exact GTIN, exact connector identity,
 *   and nothing else — and they live in code, not in operator-authored rows. A
 *   table would imply somebody can publish a new mapping without shipping the
 *   code that implements it. `CATALOG_BACKFILL_MAPPING_VERSION` in
 *   `services/backfill/mapping-version.ts` is the integer, and it is part of
 *   every idempotency key so that bumping it produces a NEW report beside the
 *   old one instead of silently reinterpreting it — the
 *   `UNIQUE(evaluation_key, policy_version_id)` shape #58 uses, one domain over.
 * - **No `expiryTargets.ts` entry, for any of the three tables.** Issue job
 *   behaviour 7 is explicit that rollback must not delete migration evidence,
 *   and a retention sweep is precisely a thing that deletes evidence on a clock.
 *   These rows are bounded by the catalogue (one per subject per mapping version
 *   per mode), not by traffic, so there is nothing here that grows without a
 *   catalogue growing first.
 * - **No `jsonb`.** Reason codes are a closed `text` vocabulary with a CHECK,
 *   counters are integers, and `detail` is bounded free text nothing queries.
 *   The `match_decisions` reasoning: an operator asking "which listings were
 *   left unattached because they are P2P" needs an indexable predicate.
 */

import { sql, type SQL } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CATALOG_BACKFILL_COHORT_KINDS,
  CATALOG_BACKFILL_MODES,
  CATALOG_BACKFILL_OUTCOMES,
  CATALOG_BACKFILL_REASON_CODES,
  CATALOG_BACKFILL_REASON_OUTCOMES,
  CATALOG_BACKFILL_RUN_STATUSES,
  CATALOG_BACKFILL_STAGES,
  CATALOG_BACKFILL_SUBJECT_KINDS,
  CATALOG_CONSISTENCY_FINDING_KINDS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';

/** Bound on any stored error or free-text detail in this domain. */
export const CATALOG_BACKFILL_MAX_TEXT_LENGTH = 2_000;

/** The one shape every value in the two tuples below has. */
const MACHINE_SLUG = /^[a-z][a-z0-9_]*$/;

/**
 * Render `CATALOG_BACKFILL_REASON_OUTCOMES` as a `case` expression.
 *
 * `offers_kind_shape_check`'s device: one branch per key and `else false`, so
 * adding a reason code without deciding which outcome it may carry fails the
 * first write instead of storing an unclassified pair.
 *
 * The literals are interpolated with `sql.raw`, which is only safe because both
 * tuples are compile-time constants from this repository — asserted here rather
 * than assumed, since `sql.raw` on a value that ever became dynamic would be an
 * injection point in generated DDL.
 */
function reasonOutcomeCheck(t: { reasonCode: PgColumn; outcome: PgColumn }): SQL {
  const branches = Object.entries(CATALOG_BACKFILL_REASON_OUTCOMES).map(([reason, outcomes]) => {
    if (!MACHINE_SLUG.test(reason)) {
      throw new Error(`Backfill reason code '${reason}' is not a machine slug.`);
    }
    const allowed = outcomes.map((outcome) => {
      if (!MACHINE_SLUG.test(outcome)) {
        throw new Error(`Backfill outcome '${outcome}' is not a machine slug.`);
      }
      return `'${outcome}'`;
    });
    return sql`when ${sql.raw(`'${reason}'`)} then ${t.outcome} in (${sql.raw(allowed.join(', '))})`;
  });
  return sql`case ${t.reasonCode} ${sql.join(branches, sql` `)} else false end`;
}

/**
 * `catalog_backfill_runs` — one (stage × mode × cohort) pass, resumable by
 * keyset cursor and claimable by lease (issue job behaviour 2).
 *
 * The `match_sweep_cursors` / `reconciliation_cursors` shape with one deliberate
 * difference: those tables hold ONE row per job forever, because a sweep is a
 * recurring maintenance pass. A backfill run is a historical EVENT — who ran
 * which stage, in which mode, over which cohort, and what it found — so each one
 * is its own row and none is ever reused. That is what makes acceptance 7's
 * "canary rollout and rollback are documented and tested" answerable after the
 * fact: the evidence is a row, not a counter that the next run overwrites.
 */
export const catalogBackfillRuns = pgTable(
  'catalog_backfill_runs',
  {
    id: generatedId(),
    stage: text({ enum: asEnumValues(CATALOG_BACKFILL_STAGES) }).notNull(),
    mode: text({ enum: asEnumValues(CATALOG_BACKFILL_MODES) }).notNull(),
    /**
     * The deterministic rule set this run applied. Part of every record's
     * idempotency key — see the module docblock on why there is no version
     * table.
     */
    mappingVersion: integer().notNull(),
    cohortKind: text({ enum: asEnumValues(CATALOG_BACKFILL_COHORT_KINDS) }).notNull(),
    /** NULL exactly when `cohort_kind = 'all'` — a CHECK, not a convention. */
    cohortValue: text(),
    status: text({ enum: asEnumValues(CATALOG_BACKFILL_RUN_STATUSES) })
      .notNull()
      .default('pending'),
    /**
     * Where the NEXT page starts, keyset on the scanned table's primary key.
     * NULL both before the first page and after the last, which is why
     * `status` and not the cursor is what says a pass finished.
     */
    cursor: text(),

    // ── The counters, which the CHECK below forces to add up ──────────────────
    scanned: integer().notNull().default(0),
    unchanged: integer().notNull().default(0),
    matched: integer().notNull().default(0),
    created: integer().notNull().default(0),
    enqueued: integer().notNull().default(0),
    reviewRequired: integer().notNull().default(0),
    unmatched: integer().notNull().default(0),
    skipped: integer().notNull().default(0),
    failed: integer().notNull().default(0),

    startedAt: timestamptz(),
    completedAt: timestamptz(),
    /** When a page last ran — the input to the throughput metric. */
    lastRunAt: timestamptz(),
    lastError: text(),

    /** Which task holds the page lease. An opaque worker identity — no FK. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),

    /**
     * The Oxy operator who asked for this run. NOT NULL: a migration that
     * mutates the canonical graph with nobody's name on it is exactly the
     * unattributable write `payment_repairs` refuses, and there is no automatic
     * path that starts a run — the dispatcher only resumes runs a person opened.
     */
    requestedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_backfill_runs_stage_check', t.stage, CATALOG_BACKFILL_STAGES),
    checkOneOf('catalog_backfill_runs_mode_check', t.mode, CATALOG_BACKFILL_MODES),
    checkOneOf('catalog_backfill_runs_status_check', t.status, CATALOG_BACKFILL_RUN_STATUSES),
    checkOneOf(
      'catalog_backfill_runs_cohort_kind_check',
      t.cohortKind,
      CATALOG_BACKFILL_COHORT_KINDS,
    ),
    check('catalog_backfill_runs_mapping_version_check', sql`${t.mappingVersion} >= 1`),
    /**
     * `all` carries no value and every other kind carries exactly one. Without
     * this a cohort could be half-specified, and a run scoped to
     * `('store', NULL)` would silently mean "every store".
     */
    check(
      'catalog_backfill_runs_cohort_shape_check',
      sql`(${t.cohortKind} = 'all') = (${t.cohortValue} is null)`,
    ),
    check(
      'catalog_backfill_runs_counters_non_negative_check',
      sql`${t.scanned} >= 0 and ${t.unchanged} >= 0 and ${t.matched} >= 0 and ${t.created} >= 0
          and ${t.enqueued} >= 0 and ${t.reviewRequired} >= 0 and ${t.unmatched} >= 0
          and ${t.skipped} >= 0 and ${t.failed} >= 0`,
    ),
    /**
     * PROPERTY 1 — the vacuity floor, as a constraint.
     *
     * Every scanned record gets exactly one outcome, so the outcome counters sum
     * to `scanned` or the run swallowed something. Equality rather than `<=`:
     * `<=` would admit the run that scanned a million rows and classified none
     * of them, which is the exact shape of a broken traversal reporting success.
     */
    check(
      'catalog_backfill_runs_counters_total_check',
      sql`${t.scanned} = ${t.unchanged} + ${t.matched} + ${t.created} + ${t.enqueued}
          + ${t.reviewRequired} + ${t.unmatched} + ${t.skipped} + ${t.failed}`,
    ),
    /** A completed pass has an end time and no cursor left to resume from. */
    check(
      'catalog_backfill_runs_completed_shape_check',
      sql`${t.status} <> 'completed' or (${t.completedAt} is not null and ${t.cursor} is null)`,
    ),
    /** Anything past `pending` has started; `pending` has not. */
    check(
      'catalog_backfill_runs_started_shape_check',
      sql`(${t.status} = 'pending') = (${t.startedAt} is null)`,
    ),
    /** Half a lease is unrepresentable — the `reconciliation_cursors` CHECK. */
    check(
      'catalog_backfill_runs_lease_complete_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    check(
      'catalog_backfill_runs_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(CATALOG_BACKFILL_MAX_TEXT_LENGTH))}`,
    ),
    check(
      'catalog_backfill_runs_requested_by_check',
      sql`btrim(${t.requestedByOxyUserId}) <> ''`,
    ),
    /**
     * ONE resumable run per (stage, mode, mapping version, cohort) at a time.
     *
     * Partial on the unfinished statuses, so a completed run is history and the
     * next pass over the same cohort is a NEW row. Without it, two operators
     * opening the same stage would each get a cursor and each enqueue the whole
     * catalogue.
     */
    uniqueIndex('catalog_backfill_runs_open_key')
      .on(t.stage, t.mode, t.mappingVersion, t.cohortKind, t.cohortValue)
      .where(sql`${t.status} in ('pending', 'running', 'paused')`),
    /** The dispatcher's claim: resumable work, oldest first. */
    index('catalog_backfill_runs_claimable_idx')
      .on(t.createdAt)
      .where(sql`${t.status} in ('pending', 'paused')`),
    /** Reclaiming a dead task's lease — its own partial index, the outbox shape. */
    index('catalog_backfill_runs_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'running'`),
    /** The metrics read: every run of the current mapping version. */
    index('catalog_backfill_runs_mapping_idx').on(t.mappingVersion, t.stage),
  ],
);

/**
 * `catalog_backfill_records` — one row per subject a stage examined (issue job
 * behaviour 3 and 4).
 *
 * ### Why every subject, and not only the interesting ones
 *
 * Recording only failures makes the report unfalsifiable: a run that examined
 * nothing and a run that examined everything successfully write the same rows.
 * The dry run's whole purpose is to be COMPARED against the apply that follows
 * it, subject by subject, and a comparison over the union of two sparse sets
 * cannot tell a disappeared subject from one that was always fine.
 *
 * The volume this implies is bounded by the catalogue rather than by traffic:
 * one row per subject per mapping version per mode, converged by
 * `ON CONFLICT DO UPDATE` on the identity key. A re-run of an unchanged
 * catalogue writes the same values back to the same rows and grows the table by
 * nothing.
 *
 * ### Subject ids carry NO foreign key, deliberately
 *
 * `subject_key` spans stores, listings, variants, vendor strings and offers —
 * five key spaces, one of which (`vendor_value`) is not an id at all. That is
 * `catalog_revisions.entity_id`'s situation exactly (ADR 0002 D20), and it
 * carries the same second reason: migration evidence has to survive the deletion
 * of the row it describes, and a CASCADE would take the audit with the subject.
 * Both are ledgered in `deferredForeignKeys.ts`.
 *
 * The CANONICAL columns are different and do carry real foreign keys: they name
 * rows in this database that ADR 0002 D20 says are never hard-deleted, and
 * RESTRICT is the audit-row rule — evidence must be able to block a delete
 * rather than vanish with it.
 */
export const catalogBackfillRecords = pgTable(
  'catalog_backfill_records',
  {
    id: generatedId(),
    /**
     * The run that LAST produced this row. RESTRICT: the run is the context that
     * makes the record readable (who, when, which cohort), so it must not be
     * deletable out from under it.
     */
    runId: text()
      .notNull()
      .references(() => catalogBackfillRuns.id, { onDelete: 'restrict' }),
    stage: text({ enum: asEnumValues(CATALOG_BACKFILL_STAGES) }).notNull(),
    mode: text({ enum: asEnumValues(CATALOG_BACKFILL_MODES) }).notNull(),
    mappingVersion: integer().notNull(),
    subjectKind: text({ enum: asEnumValues(CATALOG_BACKFILL_SUBJECT_KINDS) }).notNull(),
    /** `<kind>:<id>` — see `services/backfill/mapping-version.ts`. */
    subjectKey: text().notNull(),
    outcome: text({ enum: asEnumValues(CATALOG_BACKFILL_OUTCOMES) }).notNull(),
    reasonCode: text({ enum: asEnumValues(CATALOG_BACKFILL_REASON_CODES) }).notNull(),
    /** Bounded free text for a reviewer. Nothing queries it. */
    detail: text(),
    /** What this record attached to, or minted. RESTRICT — see the docblock. */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /**
     * How many times a run has examined this subject under this mapping version
     * and mode. A subject stuck at `failed` with a climbing count is the shape
     * of a poison record, and it is visible without reading a log.
     */
    attempts: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_backfill_records_stage_check', t.stage, CATALOG_BACKFILL_STAGES),
    checkOneOf('catalog_backfill_records_mode_check', t.mode, CATALOG_BACKFILL_MODES),
    checkOneOf(
      'catalog_backfill_records_subject_kind_check',
      t.subjectKind,
      CATALOG_BACKFILL_SUBJECT_KINDS,
    ),
    checkOneOf('catalog_backfill_records_outcome_check', t.outcome, CATALOG_BACKFILL_OUTCOMES),
    checkOneOf(
      'catalog_backfill_records_reason_check',
      t.reasonCode,
      CATALOG_BACKFILL_REASON_CODES,
    ),
    check('catalog_backfill_records_mapping_version_check', sql`${t.mappingVersion} >= 1`),
    check('catalog_backfill_records_attempts_check', sql`${t.attempts} >= 1`),
    check('catalog_backfill_records_subject_key_check', sql`btrim(${t.subjectKey}) <> ''`),
    check(
      'catalog_backfill_records_detail_length_check',
      sql`${t.detail} is null or length(${t.detail}) <= ${sql.raw(String(CATALOG_BACKFILL_MAX_TEXT_LENGTH))}`,
    ),
    /**
     * A canonical VARIANT without its product is half an answer, and a report
     * saying "attached to variant X" that cannot say which product X belongs to
     * is exactly the ambiguity a reviewer opens this table to resolve.
     */
    check(
      'catalog_backfill_records_canonical_shape_check',
      sql`${t.canonicalVariantId} is null or ${t.canonicalProductId} is not null`,
    ),
    /**
     * A reason and an outcome can never disagree — rendered from the ONE
     * `CATALOG_BACKFILL_REASON_OUTCOMES` map, `else false` and all, so an
     * unrecognised reason is unrepresentable even with the reason CHECK removed.
     *
     * `record_error` beside `unchanged` would make a page that swallowed an
     * exception report as a clean one, and the run's counter CHECK one table up
     * would happily agree with it. This is the other half of that guard.
     *
     * Note what is deliberately NOT constrained here: a `dry_run` row may carry
     * `created`, `matched` or `enqueued`. In dry-run mode an outcome is a
     * PREDICTION, and refusing to store one would make the mode unable to report
     * the four counts issue job behaviour 3 asks it for. "A dry run writes
     * nothing to the graph" is held instead by `services/backfill/graph-writer.ts`,
     * where the dry-run writer has no repository to call — a shape rather than a
     * constraint, because it is a statement about code paths and not about rows.
     */
    check('catalog_backfill_records_reason_outcome_check', reasonOutcomeCheck(t)),
    /**
     * PROPERTY 4 — the idempotency key, with `mode` inside it.
     *
     * One row per subject per stage per mapping version per mode. A re-run
     * converges (`ON CONFLICT DO UPDATE`); a NEW mapping version writes a new
     * row beside the old one so the two rule sets are comparable; and a dry run
     * can never overwrite the apply it was meant to predict.
     */
    uniqueIndex('catalog_backfill_records_subject_key')
      .on(t.mappingVersion, t.mode, t.stage, t.subjectKey),
    /** The report read: everything one run produced, worst outcomes findable. */
    index('catalog_backfill_records_run_idx').on(t.runId, t.outcome),
    /** The operator trace: every stage's verdict on one subject. */
    index('catalog_backfill_records_subject_idx').on(t.subjectKey),
    /** The metrics read, and the "show me the failures" filter. */
    index('catalog_backfill_records_outcome_idx').on(t.mappingVersion, t.mode, t.outcome),
  ],
);

/**
 * `catalog_consistency_findings` — what the two-way sweep found (issue job
 * behaviour 6, acceptance 6).
 *
 * `payment_discrepancies`, ported: a finding is a durable statement that
 * something disagreed, it is never auto-repaired by the sweep that noticed it,
 * and it RESOLVES by being re-examined and found consistent rather than by being
 * deleted. Nothing in this domain issues a DELETE.
 *
 * The sweep repairs nothing on purpose. Every kind here has an existing
 * idempotent remedy a person can drive — `native_offers` re-enqueues a
 * convergence, `provisional_products` re-attaches — so a sweep that also fixed
 * things would be a second writer racing the first, and the reverse-direction
 * kinds may reflect a MODERATION restriction, where "fix it" would mean
 * re-listing something a jury removed.
 */
export const catalogConsistencyFindings = pgTable(
  'catalog_consistency_findings',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(CATALOG_CONSISTENCY_FINDING_KINDS) }).notNull(),
    subjectKind: text({ enum: asEnumValues(CATALOG_BACKFILL_SUBJECT_KINDS) }).notNull(),
    /** No foreign key, for the `catalog_backfill_records.subject_key` reasons. */
    subjectKey: text().notNull(),
    detail: text(),
    /**
     * The run that last OBSERVED it. Nullable and RESTRICT: a finding outlives
     * any one pass, and the first pass to see it is not necessarily the one that
     * will resolve it.
     */
    lastRunId: text().references(() => catalogBackfillRuns.id, { onDelete: 'restrict' }),
    firstSeenAt: timestamptz().notNull(),
    lastSeenAt: timestamptz().notNull(),
    /** Stamped when a later pass examined the same subject and found it consistent. */
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_consistency_findings_kind_check', t.kind, CATALOG_CONSISTENCY_FINDING_KINDS),
    checkOneOf(
      'catalog_consistency_findings_subject_kind_check',
      t.subjectKind,
      CATALOG_BACKFILL_SUBJECT_KINDS,
    ),
    check('catalog_consistency_findings_subject_key_check', sql`btrim(${t.subjectKey}) <> ''`),
    check(
      'catalog_consistency_findings_detail_length_check',
      sql`${t.detail} is null or length(${t.detail}) <= ${sql.raw(String(CATALOG_BACKFILL_MAX_TEXT_LENGTH))}`,
    ),
    check('catalog_consistency_findings_seen_order_check', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
    check(
      'catalog_consistency_findings_resolved_order_check',
      sql`${t.resolvedAt} is null or ${t.resolvedAt} >= ${t.firstSeenAt}`,
    ),
    /**
     * PROPERTY 5 — at most ONE open finding per (kind, subject). Partial on
     * `resolved_at IS NULL`, because a resolved finding is history and a subject
     * that breaks again legitimately opens a new one.
     */
    uniqueIndex('catalog_consistency_findings_open_key')
      .on(t.kind, t.subjectKey)
      .where(sql`${t.resolvedAt} is null`),
    /** The metrics read: how many are open, by kind. */
    index('catalog_consistency_findings_open_idx')
      .on(t.kind, t.lastSeenAt)
      .where(sql`${t.resolvedAt} is null`),
    index('catalog_consistency_findings_subject_idx').on(t.subjectKey),
  ],
);
