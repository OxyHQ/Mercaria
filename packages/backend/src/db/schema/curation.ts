/**
 * Catalog curation — the operator's half of the canonical commerce graph
 * (issue #59, bound by ADR 0002 D12/D16): `catalog_merge_jobs`,
 * `catalog_merge_conflicts`, `catalog_merge_job_phases`, `catalog_split_jobs`,
 * `catalog_split_assignments`, `catalog_review_items`,
 * `catalog_entity_suppressions`, `catalog_revisions`.
 *
 * #58's matcher decides what may happen WITHOUT a person. Everything it refused
 * lands here, together with the corrections no automatic rule may make at all —
 * merging two identities, splitting one that was wrongly made, reassigning an
 * identifier, choosing which of two disagreeing sources is right.
 *
 * ## The failure mode that shapes the whole file
 *
 * A merge is the only operation in this graph that ends an identity, and its
 * damage is silent: every page still renders, every offer still resolves, and
 * the two things quietly made one are found months later by a seller whose
 * sales landed on somebody else's product. A half-finished merge is worse than
 * either state — some children moved, some did not, and no row says which.
 *
 * ## The six properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **Nothing moves before every conflict has an explicit decision** (#59
 *    merge invariant 4). `catalog_merge_conflicts` is one row per collision the
 *    database would refuse, its resolution is attributable by CHECK, and the
 *    job's phase order puts `awaiting_resolution` between planning and the first
 *    write. The count of unresolved rows is what gates the advance — a
 *    cross-table comparison, so the service enforces it (a CHECK may not contain
 *    a subquery) and a realdb case pins it.
 * 2. **A partially completed job converges on replay** (#59 acceptance 3).
 *    `catalog_merge_job_phases` is `UNIQUE(job_id, phase)` and append-only, so a
 *    phase records its completion exactly once and a resumed job skips what
 *    already ran. The job row carries the lease; the phase rows carry the
 *    progress. Neither can be inferred from the other, which is why they are two
 *    tables.
 * 3. **A split names exactly what moves** (#59 split invariant 1).
 *    `catalog_split_assignments` is one row per item with
 *    `UNIQUE(job_id, item_type, item_ref)`; anything not named stays where it
 *    is. Silence is never a move, and re-applying an assignment is a no-op
 *    because `applied_at` is a CAS.
 * 4. **The audit timeline cannot be edited** (#59 acceptance 4).
 *    `catalog_revisions` has no `updated_at` and its trigger refuses UPDATE and
 *    DELETE — the `relationship_reviews` and `payment_repairs` discipline. A
 *    reason is NOT NULL and non-empty on every row, so an unexplained change to
 *    the graph is unrepresentable rather than discouraged.
 * 5. **A high-impact action can require two operators, and one person cannot be
 *    both** (#59 security 4). `requires_second_approval` is snapshotted at
 *    planning time beside the impact that produced it, `approved_by <>
 *    requested_by` is a CHECK, and a job that requires approval cannot leave the
 *    `plan` phase without one — also a CHECK.
 * 6. **A queue item about a PAIR cannot be stored with one side.**
 *    `catalog_review_items_pair_shape_check` requires a counterpart for the
 *    three kinds whose statement is about two rows, and the duplicate kinds
 *    additionally require `subject_id < counterpart_id`, so (A,B) and (B,A) are
 *    ONE item rather than two views of one problem.
 *
 * ## What is deliberately NOT here
 *
 * - **No delete of anything.** A merge stamps a tombstone, a split revives one,
 *   a suppression hides. No column in this file can express "remove the row",
 *   and `catalog-isolation.test.ts` fails the build if a curation module issues
 *   a `.delete(`.
 * - **No second review inbox for matching.** `match_decisions.review_state` is
 *   #58's and stays #58's; a `catalog_review_items` row for an ambiguous match
 *   POINTS at the decision through a real foreign key and never copies its
 *   verdict. Two representations of one review state would disagree the first
 *   time one path forgot the other.
 * - **No `jsonb` outside `catalog_revisions.before`/`after`.** Those two are
 *   ADR 0002 D16's named exception, and the reason is exact: a revision has to
 *   capture whatever the entity looked like, INCLUDING fields a later schema
 *   removed, so projecting it into columns would make the audit trail lossy the
 *   first time the schema moved. Every other fact in this file — impact counts,
 *   reason codes, conflict kinds — is a real column, because a reviewer filters
 *   on them.
 * - **No `expires_at` anywhere, and therefore no `db/expiryTargets.ts` entry.**
 *   The audit timeline is the point; a retention sweep over it would delete the
 *   record of who changed what, and the job tables are bounded by the number of
 *   merges a person performs.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CATALOG_JOB_STATUSES,
  CATALOG_MERGE_CLOSE_RELATION_CONFLICT_KINDS,
  CATALOG_MERGE_COLLAPSE_CONFLICT_KINDS,
  CATALOG_MERGE_COLLAPSE_RESOLUTIONS,
  CATALOG_MERGE_CONFLICT_KINDS,
  CATALOG_MERGE_CONFLICT_RESOLUTIONS,
  CATALOG_MERGE_PAIR_CONFLICT_KINDS,
  CATALOG_MERGE_RETAIN_HISTORY_CONFLICT_KINDS,
  CATALOG_MERGE_PHASES,
  CATALOG_REVISION_ACTIONS,
  CATALOG_REVISION_ACTOR_KINDS,
  CATALOG_SPLIT_ITEM_TYPES,
  CATALOG_SPLIT_PHASES,
  CATALOG_SPLIT_TARGET_MODES,
  CATALOG_SUPPRESSIBLE_TYPES,
  CATALOG_SUPPRESSION_REASONS,
  CATALOG_SUPPRESSION_SCOPES,
  CURATION_ACTIVE_REVIEW_STATES,
  CURATION_DETECTORS,
  CURATION_DISMISSAL_RESOLUTIONS,
  CURATION_PAIRED_REVIEW_KINDS,
  CURATION_REASON_CODES,
  CURATION_RESOLUTIONS,
  CURATION_REVIEW_KINDS,
  CURATION_REVIEW_STATES,
  CURATION_SUBJECT_TYPES,
  MERGEABLE_ENTITY_TYPES,
  SPLITTABLE_ENTITY_TYPES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import {
  canonicalProductFamilyRedirects,
  canonicalProductRedirects,
  canonicalVariants,
  productIdentifiers,
} from './canonicalCatalog';
import { genericCompatibilityRelations } from './compatibility';
import { commerceRelationships } from './relationships';
import { merchantClaims } from './merchantClaims';
import { matchDecisions, matchPolicyVersions } from './matching';
import { offers } from './offers';
import { sourceRecords } from './provenance';

/**
 * The longest reason, note or stored error this domain accepts.
 *
 * The `MATCH_MAX_TEXT_LENGTH` bound, for its reason: an unbounded text column on
 * a row a retry loop writes is how a table grows without anybody choosing to
 * grow it. A reason an operator types is bounded by the same number, because a
 * reason nobody will read is not one the audit trail is better for holding.
 */
export const CURATION_MAX_TEXT_LENGTH = 2_000;

/**
 * The kinds whose subject and counterpart must be stored in a canonical ORDER,
 * so (A,B) and (B,A) are one queue item.
 *
 * `identifier_conflict` is deliberately excluded: there the direction carries
 * meaning — the disputed newcomer is the subject and the incumbent active owner
 * is the counterpart — and ordering them by id would destroy which is which.
 */
export const CURATION_ORDERED_PAIR_REVIEW_KINDS = ['entity_collision', 'suspected_duplicate'] as const;

/**
 * Render a string tuple as a SQL `in (...)` list body.
 *
 * `checkOneOf` covers a whole column; these CHECKs need the same list INSIDE a
 * larger expression, which that helper cannot express.
 */
function inValues(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/gu, "''")}'`).join(', ');
}

/**
 * The impact counts every job snapshots at planning time (#59 security 2).
 *
 * Stated once here rather than at two tables, for the reason `canonicalSupport.ts`
 * exists: a hand-written copy of a shared shape diverges silently, and these two
 * copies would diverge into a merge and a split reporting different things by
 * the same name. TypeScript infers the returned column set without an assertion
 * because none of the keys is computed — the one hazard `money()` has.
 *
 * They are REAL COLUMNS and not a `jsonb` summary because an operator compares
 * them, an alert thresholds on them, and `requires_second_approval` is derived
 * from `impact_total_moving` — a value a `jsonb` path could hold as a string.
 */
function impactColumns() {
  return {
    impactSourceLinks: integer().notNull().default(0),
    impactIdentifiers: integer().notNull().default(0),
    impactAliases: integer().notNull().default(0),
    impactOffers: integer().notNull().default(0),
    impactNativeListingLinks: integer().notNull().default(0),
    impactRelationships: integer().notNull().default(0),
    impactReviews: integer().notNull().default(0),
    impactChildEntities: integer().notNull().default(0),
    impactAttributeValues: integer().notNull().default(0),
    impactImages: integer().notNull().default(0),
    /**
     * Placed order lines referencing the entity's native listings — reported
     * precisely because the job leaves every one of them ALONE (#59 merge
     * invariant 3). An operator seeing a non-zero count beside a merge that
     * moves none of them learns that a purchase history cannot be disturbed,
     * which is the reassurance the invariant exists to give.
     */
    impactUntouchedOrderItems: integer().notNull().default(0),
    /** The sum of the MOVING counts. `impact_untouched_order_items` is not one. */
    impactTotalMoving: integer().notNull().default(0),
  };
}

/**
 * The impact columns as the table's extra-config callback sees them.
 *
 * `impactColumns()` returns BUILDERS; by the time a CHECK references them they
 * are columns. Typing the check helpers against `PgColumn` rather than
 * `ReturnType<typeof impactColumns>` is what lets one declaration serve both
 * tables — the alternative is two hand-written copies, which is the divergence
 * this file's helpers exist to prevent.
 */
interface ImpactCheckColumns {
  readonly impactSourceLinks: PgColumn;
  readonly impactIdentifiers: PgColumn;
  readonly impactAliases: PgColumn;
  readonly impactOffers: PgColumn;
  readonly impactNativeListingLinks: PgColumn;
  readonly impactRelationships: PgColumn;
  readonly impactReviews: PgColumn;
  readonly impactChildEntities: PgColumn;
  readonly impactAttributeValues: PgColumn;
  readonly impactImages: PgColumn;
  readonly impactUntouchedOrderItems: PgColumn;
  readonly impactTotalMoving: PgColumn;
}

/** The CHECK every impact column set carries: nothing counts backwards. */
function impactChecks(table: string, columns: ImpactCheckColumns) {
  return [
    check(
      `${table}_impact_non_negative_check`,
      sql`${columns.impactSourceLinks} >= 0 and ${columns.impactIdentifiers} >= 0
          and ${columns.impactAliases} >= 0 and ${columns.impactOffers} >= 0
          and ${columns.impactNativeListingLinks} >= 0 and ${columns.impactRelationships} >= 0
          and ${columns.impactReviews} >= 0 and ${columns.impactChildEntities} >= 0
          and ${columns.impactAttributeValues} >= 0 and ${columns.impactImages} >= 0
          and ${columns.impactUntouchedOrderItems} >= 0 and ${columns.impactTotalMoving} >= 0`,
    ),
    /**
     * The total IS the sum of the parts, and the database says so.
     *
     * A stored total that could disagree with its components is the shape that
     * lets a four-eyes threshold be dodged by writing a small number beside ten
     * large ones. It is a CHECK rather than a generated column because a
     * generated column would make `requires_second_approval` derivable from it
     * too, and that verdict is snapshotted deliberately — a threshold change
     * must not retroactively unapprove a job somebody already ran.
     */
    check(
      `${table}_impact_total_check`,
      sql`${columns.impactTotalMoving} = ${columns.impactSourceLinks} + ${columns.impactIdentifiers}
          + ${columns.impactAliases} + ${columns.impactOffers} + ${columns.impactNativeListingLinks}
          + ${columns.impactRelationships} + ${columns.impactReviews} + ${columns.impactChildEntities}
          + ${columns.impactAttributeValues} + ${columns.impactImages}`,
    ),
  ];
}

/** The lease and retry columns a curation job carries. */
function jobRuntimeColumns() {
  return {
    status: text({ enum: asEnumValues(CATALOG_JOB_STATUSES) }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    startedAt: timestamptz(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}

/** The runtime columns a CHECK references. See {@link ImpactCheckColumns}. */
interface JobRuntimeCheckColumns {
  readonly status: PgColumn;
  readonly attempts: PgColumn;
  readonly leaseOwner: PgColumn;
  readonly leaseUntil: PgColumn;
  readonly lastError: PgColumn;
  readonly completedAt: PgColumn;
}

/** The CHECKs every curation job's runtime columns carry. */
function jobRuntimeChecks(table: string, columns: JobRuntimeCheckColumns) {
  return [
    checkOneOf(`${table}_status_check`, columns.status, CATALOG_JOB_STATUSES),
    check(`${table}_attempts_check`, sql`${columns.attempts} >= 0`),
    // Half a lease is unrepresentable — the `reconciliation_cursors` CHECK.
    check(
      `${table}_lease_complete_check`,
      sql`num_nonnulls(${columns.leaseOwner}, ${columns.leaseUntil}) in (0, 2)`,
    ),
    check(
      `${table}_last_error_length_check`,
      sql`${columns.lastError} is null or length(${columns.lastError}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    check(
      `${table}_completion_check`,
      sql`(${columns.status} = 'completed') = (${columns.completedAt} is not null)`,
    ),
  ];
}

/**
 * `catalog_merge_jobs` — one durable, leased, resumable merge (#59 merge
 * invariant 7).
 *
 * ## Why the loser and the winner carry no foreign key
 *
 * `entity_type` decides which of seven tables the two ids live in, so a real
 * reference would mean fourteen nullable columns and a CHECK selecting a pair
 * per type — a shape nobody can read for a value that is only ever dereferenced
 * by code that already switched on the type. They are ledgered in
 * `deferredForeignKeys.ts` as PERMANENT, with ADR 0002 D16's own reason for
 * `catalog_revisions.entity_id`: the column spans entity types and must survive
 * the tombstone it creates.
 *
 * What that gives up is bounded and covered elsewhere: every mergeable entity is
 * RESTRICT-protected from hard deletion by its own children (D20), so a job
 * naming a row that vanished is not a state this database can reach.
 *
 * ## The partial unique is the concurrency answer
 *
 * `(entity_type, loser_id) WHERE status` is open holds ONE live job per losing
 * entity. Two operators merging one brand into two different winners is not a
 * race to resolve — it is two irreconcilable histories, and the second request
 * is refused by the database rather than by whoever remembered to look.
 *
 * The WINNER is deliberately unconstrained: merging five duplicates into one
 * canonical row is the ordinary case, and five concurrent jobs against one
 * winner are safe because each one only ever writes its own loser's children.
 */
export const catalogMergeJobs = pgTable(
  'catalog_merge_jobs',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(MERGEABLE_ENTITY_TYPES) }).notNull(),
    /** The identity that ENDS. See the note above on the absent foreign key. */
    loserId: text().notNull(),
    /** The identity that survives and inherits. */
    winnerId: text().notNull(),

    phase: text({ enum: asEnumValues(CATALOG_MERGE_PHASES) }).notNull().default('plan'),

    /** MANDATORY (#59 security 2): an unexplained merge is unrepresentable. */
    reason: text().notNull(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    requestedByOxyUserId: text().notNull(),
    /**
     * The SECOND operator (#59 security 4). CHECKed to differ from the
     * requester, so one person holding two sessions cannot satisfy four eyes.
     */
    approvedByOxyUserId: text(),
    approvedAt: timestamptz(),
    /**
     * Whether this job needs that second operator — snapshotted at planning
     * time from the impact, never re-derived.
     *
     * A stored verdict rather than a live comparison (the `onboarding_state`
     * precedent): the threshold and the flag both change over time, and a job
     * whose approval requirement moved after somebody approved it would either
     * strand a legitimate run or let an unapproved one through, depending on
     * which direction the change went.
     */
    requiresSecondApproval: boolean().notNull().default(false),

    /**
     * The conflict whose `merge_pair` resolution opened this job, when it is a
     * CHILD. The parent's `children` phase waits on it.
     *
     * The pointer lives on the CONFLICT row (`child_job_id`) rather than here,
     * so the two tables reference in one direction only; this column is the
     * parent JOB, which is what a trace walks upward.
     */
    parentJobId: text().references((): AnyPgColumn => catalogMergeJobs.id, {
      onDelete: 'restrict',
    }),

    /** The review item this merge answers, when it came out of the queue. */
    reviewItemId: text().references((): AnyPgColumn => catalogReviewItems.id, {
      onDelete: 'set null',
    }),

    ...impactColumns(),
    ...jobRuntimeColumns(),
  },
  (t) => {
    const impact = {
      impactSourceLinks: t.impactSourceLinks,
      impactIdentifiers: t.impactIdentifiers,
      impactAliases: t.impactAliases,
      impactOffers: t.impactOffers,
      impactNativeListingLinks: t.impactNativeListingLinks,
      impactRelationships: t.impactRelationships,
      impactReviews: t.impactReviews,
      impactChildEntities: t.impactChildEntities,
      impactAttributeValues: t.impactAttributeValues,
      impactImages: t.impactImages,
      impactUntouchedOrderItems: t.impactUntouchedOrderItems,
      impactTotalMoving: t.impactTotalMoving,
    };
    return [
      checkOneOf('catalog_merge_jobs_entity_type_check', t.entityType, MERGEABLE_ENTITY_TYPES),
      checkOneOf('catalog_merge_jobs_phase_check', t.phase, CATALOG_MERGE_PHASES),
      ...jobRuntimeChecks('catalog_merge_jobs', {
        status: t.status,
        attempts: t.attempts,
        leaseOwner: t.leaseOwner,
        leaseUntil: t.leaseUntil,
        lastError: t.lastError,
        completedAt: t.completedAt,
      }),
      ...impactChecks('catalog_merge_jobs', impact),
      check('catalog_merge_jobs_reason_check', sql`btrim(${t.reason}) <> ''`),
      check(
        'catalog_merge_jobs_reason_length_check',
        sql`length(${t.reason}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
      ),
      check('catalog_merge_jobs_actor_check', sql`btrim(${t.requestedByOxyUserId}) <> ''`),
      /** A thing cannot be merged into itself; the tombstone would point at itself. */
      check('catalog_merge_jobs_distinct_check', sql`${t.loserId} <> ${t.winnerId}`),
      check('catalog_merge_jobs_parent_self_check', sql`${t.parentJobId} is null or ${t.parentJobId} <> ${t.id}`),
      /**
       * FOUR EYES, in the row. Two CHECKs and neither is sufficient alone:
       * the first refuses an approval by the person who asked, the second
       * refuses ADVANCING past planning without one when the job needs it.
       */
      check(
        'catalog_merge_jobs_approver_distinct_check',
        sql`${t.approvedByOxyUserId} is null or ${t.approvedByOxyUserId} <> ${t.requestedByOxyUserId}`,
      ),
      check(
        'catalog_merge_jobs_approval_state_check',
        sql`(${t.approvedByOxyUserId} is null) = (${t.approvedAt} is null)`,
      ),
      check(
        'catalog_merge_jobs_second_approval_check',
        sql`not ${t.requiresSecondApproval}
            or ${t.phase} in ('plan', 'awaiting_resolution')
            or ${t.approvedByOxyUserId} is not null`,
      ),
      /** A finished job is at the end of its phase list; the two cannot disagree. */
      check(
        'catalog_merge_jobs_completed_phase_check',
        sql`${t.status} <> 'completed' or ${t.phase} = 'done'`,
      ),
      /** ONE live job per losing entity. See the note above. */
      uniqueIndex('catalog_merge_jobs_open_key')
        .on(t.entityType, t.loserId)
        .where(sql`${t.status} in ('pending', 'processing', 'blocked')`),
      // The claim query's two branches — due PENDING work and PROCESSING work
      // whose lease expired — each with its own partial index, so neither scans
      // the other's rows. The `offer_outboxes` shape.
      index('catalog_merge_jobs_pending_idx')
        .on(t.availableAt, t.createdAt)
        .where(sql`${t.status} = 'pending'`),
      index('catalog_merge_jobs_reclaim_idx')
        .on(t.leaseUntil, t.createdAt)
        .where(sql`${t.status} = 'processing'`),
      /** The operator inbox: jobs waiting on a person, oldest first. */
      index('catalog_merge_jobs_blocked_idx')
        .on(t.createdAt)
        .where(sql`${t.status} = 'blocked'`),
      /** "What has ever been done to this entity", from either side. */
      index('catalog_merge_jobs_winner_idx').on(t.entityType, t.winnerId, t.createdAt.desc()),
      index('catalog_merge_jobs_parent_idx')
        .on(t.parentJobId)
        .where(sql`${t.parentJobId} is not null`),
    ];
  },
);

/**
 * `catalog_merge_conflicts` — one collision the database would refuse, and the
 * operator's explicit decision about it (#59 merge invariant 4).
 *
 * ## Every kind names a real constraint, and that is the membership test
 *
 * A "conflict" with no constraint behind it is a warning, and warnings do not
 * block. The constraints are `product_identifiers_canonical_active_key`,
 * `canonical_variants_product_signature_key`,
 * `canonical_variants_product_default_key`,
 * `commerce_relationships_open_claim_key`, `offers_active_commercial_key`,
 * `merchant_claims`' verified-operator partial unique and
 * `generic_compatibility_relations_distinct_endpoints_check` — so the planning
 * phase's job is to run each merge's repoint AS A QUERY and report what Postgres
 * would reject.
 *
 * A SLUG collision is deliberately not among them: slugs are unique forever and
 * a tombstone keeps its own (ADR 0002 D12), so a merge never contends for one.
 * Invariant 5's "slug collisions produce deterministic redirects" is satisfied
 * by the identity model rather than by a decision anybody makes.
 *
 * ## Real foreign keys, not two opaque refs — ten for the PAIRS and one alone
 *
 * Six kinds span four tables and every one of them names two rows in the SAME
 * one, so real references are available and the `commerce_relationships`
 * endpoint reasoning applies: a conflict naming a variant that no longer exists
 * is a dangling pointer, and RESTRICT makes the conflict row able to BLOCK a
 * delete rather than vanish with what it explains. `conflict_key` collapses them
 * for the convergence unique, because Postgres treats NULLs as distinct — the
 * `endpoint_key` device, for its fourth time in this graph.
 *
 * The seventh names ONE row and the asymmetry is the fact rather than an
 * omission (#405). A merge that lands both ends of a relation on the winner has
 * no second row to weigh: the row is legal before the merge and illegal after
 * it. `collapsing_relation_id` is therefore a lone reference, it is in
 * `conflict_key` like every other — two relations collapsing under one job are
 * two conflicts, and leaving it out would make the second converge onto the
 * first and disappear — and the shape CHECKs keep the two families apart in both
 * directions.
 */
export const catalogMergeConflicts = pgTable(
  'catalog_merge_conflicts',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => catalogMergeJobs.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(CATALOG_MERGE_CONFLICT_KINDS) }).notNull(),

    // ── The colliding pair (per-kind CHECK below decides which pair is set) ──
    loserIdentifierId: text().references(() => productIdentifiers.id, { onDelete: 'restrict' }),
    winnerIdentifierId: text().references(() => productIdentifiers.id, { onDelete: 'restrict' }),
    loserVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    winnerVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    loserRelationshipId: text().references(() => commerceRelationships.id, { onDelete: 'restrict' }),
    winnerRelationshipId: text().references(() => commerceRelationships.id, {
      onDelete: 'restrict',
    }),
    loserOfferId: text().references(() => offers.id, { onDelete: 'restrict' }),
    winnerOfferId: text().references(() => offers.id, { onDelete: 'restrict' }),
    loserClaimId: text().references(() => merchantClaims.id, { onDelete: 'restrict' }),
    winnerClaimId: text().references(() => merchantClaims.id, { onDelete: 'restrict' }),

    // ── The COLLAPSING row: one reference, because there is no pair (#405) ───
    /**
     * The single relation whose two ends the merge would make equal.
     *
     * There is no `winner…` twin and adding one would be a lie about the shape:
     * nothing on the winning side collides, which is exactly why `absenceGuard`
     * — a hunt for a colliding winner row — cannot see this case at all.
     * RESTRICT for the reason every other conflict reference is: a conflict
     * naming a relation that no longer exists is a dangling pointer, and the
     * conflict row should be able to BLOCK a delete rather than vanish with what
     * it explains.
     */
    collapsingRelationId: text().references(() => genericCompatibilityRelations.id, {
      onDelete: 'restrict',
    }),
    /**
     * The redirect hop a merge would turn into a self-redirect (#405).
     *
     * TWO columns for one kind, because the constraint is written twice over the
     * same shape — one redirect table per mergeable grain — and a conflict names
     * the row it is about. Unlike the compatibility case the resolution keeps
     * the row, so a real `restrict` reference is both possible and right: a
     * conflict explaining a hop that no longer exists explains nothing.
     */
    collapsingProductRedirectId: text().references(() => canonicalProductRedirects.id, {
      onDelete: 'restrict',
    }),
    collapsingFamilyRedirectId: text().references(() => canonicalProductFamilyRedirects.id, {
      onDelete: 'restrict',
    }),

    /** What actually collides — the GTIN, the signature — for the operator to read. */
    detail: text().notNull(),

    resolution: text({ enum: asEnumValues(CATALOG_MERGE_CONFLICT_RESOLUTIONS) }),
    /** An Oxy account id — no foreign key. */
    resolvedByOxyUserId: text(),
    resolvedAt: timestamptz(),
    resolutionReason: text(),
    /**
     * The child merge job a `merge_pair` resolution opened.
     *
     * UNIQUE, so one conflict opens at most one job and a retry of the
     * resolution converges instead of spawning a second merge of the same pair.
     */
    childJobId: text().references(() => catalogMergeJobs.id, { onDelete: 'restrict' }),
    /** When the resolution was actually applied to the graph. NULL until then. */
    appliedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The collapsed colliding pair, GENERATED so no writer can supply a key that
     * disagrees with the columns it summarises. `coalesce` and `||` are both
     * IMMUTABLE, which a stored generated column requires.
     */
    conflictKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("loser_identifier_id", '') || '|' || coalesce("winner_identifier_id", '') || '|' ||
            coalesce("loser_variant_id", '') || '|' || coalesce("winner_variant_id", '') || '|' ||
            coalesce("loser_relationship_id", '') || '|' || coalesce("winner_relationship_id", '') || '|' ||
            coalesce("loser_offer_id", '') || '|' || coalesce("winner_offer_id", '') || '|' ||
            coalesce("loser_claim_id", '') || '|' || coalesce("winner_claim_id", '') || '|' ||
            coalesce("collapsing_relation_id", '') || '|' ||
            coalesce("collapsing_product_redirect_id", '') || '|' ||
            coalesce("collapsing_family_redirect_id", '')`,
      ),
  },
  (t) => [
    checkOneOf('catalog_merge_conflicts_kind_check', t.kind, CATALOG_MERGE_CONFLICT_KINDS),
    checkOneOf(
      'catalog_merge_conflicts_resolution_check',
      t.resolution,
      CATALOG_MERGE_CONFLICT_RESOLUTIONS,
    ),
    /**
     * The per-kind pair shape. `else false` is the load-bearing branch, the
     * `offers_kind_shape_check` device: a kind added to the tuple without a
     * branch here fails its first write instead of storing a conflict that
     * names nothing.
     *
     * `default_variant` names TWO variants like `variant_signature` does, and
     * the two are separate kinds because their resolutions differ — one may be
     * answered by `keep_winner`, the other may not.
     *
     * `compatibility_endpoint_collapse` is the one branch that names NO pair,
     * and it is written as ten `is null`s rather than left out (#405): a kind
     * with no branch falls to `else false` and cannot be stored at all, and a
     * kind whose branch said nothing would let a collapse carry a stray offer or
     * claim reference. Which reference it DOES carry is
     * `catalog_merge_conflicts_collapse_shape_check` below — a biconditional
     * over the whole tuple, so a seventh kind cannot be admitted to the pair
     * shape while quietly also carrying a collapsing relation.
     */
    check(
      'catalog_merge_conflicts_pair_shape_check',
      sql`case ${t.kind}
            when 'identifier' then
              ${t.loserIdentifierId} is not null and ${t.winnerIdentifierId} is not null
              and ${t.loserVariantId} is null and ${t.winnerVariantId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            when 'variant_signature' then
              ${t.loserVariantId} is not null and ${t.winnerVariantId} is not null
              and ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            when 'default_variant' then
              ${t.loserVariantId} is not null and ${t.winnerVariantId} is not null
              and ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            when 'relationship_endpoint' then
              ${t.loserRelationshipId} is not null and ${t.winnerRelationshipId} is not null
              and ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserVariantId} is null and ${t.winnerVariantId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            when 'active_offer' then
              ${t.loserOfferId} is not null and ${t.winnerOfferId} is not null
              and ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserVariantId} is null and ${t.winnerVariantId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            when 'verified_claim' then
              ${t.loserClaimId} is not null and ${t.winnerClaimId} is not null
              and ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserVariantId} is null and ${t.winnerVariantId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
            when 'compatibility_endpoint_collapse' then
              ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserVariantId} is null and ${t.winnerVariantId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            when 'redirect_endpoint_collapse' then
              ${t.loserIdentifierId} is null and ${t.winnerIdentifierId} is null
              and ${t.loserVariantId} is null and ${t.winnerVariantId} is null
              and ${t.loserRelationshipId} is null and ${t.winnerRelationshipId} is null
              and ${t.loserOfferId} is null and ${t.winnerOfferId} is null
              and ${t.loserClaimId} is null and ${t.winnerClaimId} is null
            else false
          end`,
    ),
    /**
     * The collapsing reference is present on EXACTLY the collapse kinds (#405).
     *
     * A biconditional rather than a clause repeated through the six pair
     * branches above, because the repeated form has to be remembered once per
     * branch and the direction it fails in is silent: a pair conflict carrying a
     * collapsing relation would resolve as a pair, leave the relation open, and
     * the merge would then hit the same `23514` the conflict existed to prevent.
     */
    check(
      'catalog_merge_conflicts_collapse_shape_check',
      sql`case ${t.kind}
            when 'compatibility_endpoint_collapse' then
              ${t.collapsingRelationId} is not null
              and ${t.collapsingProductRedirectId} is null
              and ${t.collapsingFamilyRedirectId} is null
            when 'redirect_endpoint_collapse' then
              ${t.collapsingRelationId} is null
              and num_nonnulls(${t.collapsingProductRedirectId}, ${t.collapsingFamilyRedirectId}) = 1
            else
              ${t.collapsingRelationId} is null
              and ${t.collapsingProductRedirectId} is null
              and ${t.collapsingFamilyRedirectId} is null
          end`,
    ),
    /** A row cannot collide with itself; that is not a conflict, it is a bug upstream. */
    check(
      'catalog_merge_conflicts_distinct_pair_check',
      sql`(${t.loserIdentifierId} is null or ${t.winnerIdentifierId} is null
           or ${t.loserIdentifierId} <> ${t.winnerIdentifierId})
          and (${t.loserVariantId} is null or ${t.winnerVariantId} is null
               or ${t.loserVariantId} <> ${t.winnerVariantId})
          and (${t.loserRelationshipId} is null or ${t.winnerRelationshipId} is null
               or ${t.loserRelationshipId} <> ${t.winnerRelationshipId})
          and (${t.loserOfferId} is null or ${t.winnerOfferId} is null
               or ${t.loserOfferId} <> ${t.winnerOfferId})
          and (${t.loserClaimId} is null or ${t.winnerClaimId} is null
               or ${t.loserClaimId} <> ${t.winnerClaimId})`,
    ),
    check('catalog_merge_conflicts_detail_check', sql`btrim(${t.detail}) <> ''`),
    /**
     * A resolution is attributable and reasoned, or it did not happen — the
     * `match_blocked_pairs_cleared_state_check` discipline. This is what makes
     * invariant 4's "explicitly" mean something an auditor can read.
     */
    check(
      'catalog_merge_conflicts_resolution_state_check',
      sql`${t.resolution} is null
          or (${t.resolvedByOxyUserId} is not null and ${t.resolvedAt} is not null
              and btrim(coalesce(${t.resolutionReason}, '')) <> '')`,
    ),
    check(
      'catalog_merge_conflicts_unresolved_state_check',
      sql`${t.resolution} is not null
          or (${t.resolvedByOxyUserId} is null and ${t.resolvedAt} is null
              and ${t.resolutionReason} is null and ${t.childJobId} is null
              and ${t.appliedAt} is null)`,
    ),
    /**
     * `merge_pair` belongs to exactly the kinds where keeping one of the two
     * would strand the other's children on a row nothing links to.
     */
    check(
      'catalog_merge_conflicts_merge_pair_kind_check',
      sql`${t.resolution} is distinct from 'merge_pair'
          or ${t.kind} in (${sql.raw(inValues(CATALOG_MERGE_PAIR_CONFLICT_KINDS))})`,
    ),
    /**
     * `close_relation` belongs to exactly the kinds that name ONE row (#405) —
     * the mirror of the rule above.
     */
    check(
      'catalog_merge_conflicts_close_relation_kind_check',
      sql`${t.resolution} is distinct from 'close_relation'
          or ${t.kind} in (${sql.raw(inValues(CATALOG_MERGE_CLOSE_RELATION_CONFLICT_KINDS))})`,
    ),
    /**
     * And its sibling. The two collapse resolutions are NOT interchangeable:
     * `close_relation` ends a live claim, `retain_history` records that a TRUE
     * historical row stays. Offering either for the other's kind would mean
     * revoking a fact, or "closing" a table with no state to close.
     */
    check(
      'catalog_merge_conflicts_retain_history_kind_check',
      sql`${t.resolution} is distinct from 'retain_history'
          or ${t.kind} in (${sql.raw(inValues(CATALOG_MERGE_RETAIN_HISTORY_CONFLICT_KINDS))})`,
    ),
    /**
     * And the direction the rule above cannot express: a collapse kind admits
     * NOTHING BUT `close_relation`.
     *
     * `keep_winner` on a collapse is not a wrong answer that fails somewhere —
     * it is an answer to a question nobody asked, and `retiredSide` would map it
     * to "retire the loser row", whose column the shape CHECK guarantees is
     * NULL. The applier returns, the conflict is marked applied, the job
     * unblocks, and the rehoming phase walks into the `23514` this whole
     * mechanism exists to have decided. The UNDECIDED case is spelled out as
     * its own `is null` disjunct rather than left to three-valued logic: a
     * detected collapse is written with no resolution and has to be storable.
     */
    check(
      'catalog_merge_conflicts_collapse_resolution_check',
      sql`${t.kind} not in (${sql.raw(inValues(CATALOG_MERGE_COLLAPSE_CONFLICT_KINDS))})
          or ${t.resolution} is null
          or ${t.resolution} in (${sql.raw(inValues(CATALOG_MERGE_COLLAPSE_RESOLUTIONS))})`,
    ),
    /**
     * A child job exists exactly when the resolution is the one that opens one.
     * `is not distinct from` rather than `=` so an UNRESOLVED row is compared
     * as false rather than as NULL — with `=`, the whole CHECK evaluates NULL
     * and passes, which would let a child job be attached to a conflict nobody
     * has decided.
     */
    check(
      'catalog_merge_conflicts_child_job_check',
      sql`(${t.childJobId} is not null) = (${t.resolution} is not distinct from 'merge_pair')`,
    ),
    check(
      'catalog_merge_conflicts_reason_length_check',
      sql`${t.resolutionReason} is null or length(${t.resolutionReason}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    /** Nothing is applied before it is decided. */
    check(
      'catalog_merge_conflicts_applied_check',
      sql`${t.appliedAt} is null or ${t.resolvedAt} is not null`,
    ),
    /** Detection converges: re-planning a job rewrites nothing it already found. */
    uniqueIndex('catalog_merge_conflicts_identity_key').on(t.jobId, t.kind, t.conflictKey),
    uniqueIndex('catalog_merge_conflicts_child_job_key')
      .on(t.childJobId)
      .where(sql`${t.childJobId} is not null`),
    /** The gate the advance reads: does this job still have an undecided conflict? */
    index('catalog_merge_conflicts_unresolved_idx')
      .on(t.jobId)
      .where(sql`${t.resolution} is null`),
  ],
);

/**
 * `catalog_merge_job_phases` — which phases of a job have COMPLETED
 * (#59 acceptance 3, merge invariant 7).
 *
 * The job row carries the lease and the phase it is ON; this table carries what
 * is DONE. Two tables because neither is derivable from the other: a job sitting
 * in `offers` says nothing about whether `identifiers` finished, since a resumed
 * job re-enters at whatever phase its lease expired in and a phase that ran
 * partially must be re-run.
 *
 * `UNIQUE(job_id, phase)` is what makes replay converge: the runner claims a
 * phase row before doing the work and marks it complete after, so a phase that
 * already completed is skipped by a lookup rather than by a re-derivation, and a
 * crash between the two leaves an incomplete row the resume finds.
 *
 * Append-only by trigger, minus the one UPDATE that stamps completion — the
 * `match_benchmark_runs` shape and its reason: a phase record somebody could
 * edit is not a record a resume can trust.
 */
export const catalogMergeJobPhases = pgTable(
  'catalog_merge_job_phases',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => catalogMergeJobs.id, { onDelete: 'cascade' }),
    phase: text({ enum: asEnumValues(CATALOG_MERGE_PHASES) }).notNull(),
    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),
    /** How many rows this phase moved — the number `verify` reconciles against. */
    rowsAffected: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('catalog_merge_job_phases_phase_check', t.phase, CATALOG_MERGE_PHASES),
    check('catalog_merge_job_phases_rows_check', sql`${t.rowsAffected} >= 0`),
    check(
      'catalog_merge_job_phases_completion_check',
      sql`${t.completedAt} is null or ${t.completedAt} >= ${t.startedAt}`,
    ),
    uniqueIndex('catalog_merge_job_phases_key').on(t.jobId, t.phase),
    index('catalog_merge_job_phases_job_idx').on(t.jobId, t.startedAt),
  ],
);

/**
 * `catalog_split_jobs` — one durable, leased, resumable split (#59 split
 * invariant 5).
 *
 * ## `revive_tombstone` is what makes acceptance 2 work
 *
 * "A mistaken merge can be split without losing source mappings or price
 * history." Every source mapping that pointed at the losing entity, and every
 * price observation recorded against its offers, is keyed on that entity's ID.
 * Minting a fresh row and moving children to it satisfies the WORD "split" and
 * loses exactly what the criterion protects — the old id, the old slug and the
 * old URL would all be dead. So a split may name an existing TOMBSTONE as its
 * destination and revive it: `merged_into_id` is cleared, `status` returns to
 * active, and the identity that was ended comes back as itself.
 *
 * `new_entity` is the other case — an entity that was never merged but holds two
 * things that were always distinct — and it mints a row with a NEW slug. The old
 * URL keeps resolving to the ORIGINAL entity, which is still correct for
 * whatever stayed: invariant 4's "old URLs do not silently resolve to the wrong
 * new entity" is satisfied by not minting a redirect, rather than by minting a
 * careful one.
 */
export const catalogSplitJobs = pgTable(
  'catalog_split_jobs',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(SPLITTABLE_ENTITY_TYPES) }).notNull(),
    /** The entity being divided. Ledgered, for `catalog_merge_jobs`' reason. */
    sourceEntityId: text().notNull(),
    targetMode: text({ enum: asEnumValues(CATALOG_SPLIT_TARGET_MODES) }).notNull(),
    /**
     * The destination. Present from the start for `revive_tombstone` (it names
     * the tombstone) and NULL until the `mint` phase for `new_entity`.
     */
    targetEntityId: text(),
    /** The new entity's URL identity. `new_entity` only — a tombstone keeps its own. */
    targetSlug: text(),
    /** The new entity's display name. `new_entity` only. */
    targetName: text(),

    phase: text({ enum: asEnumValues(CATALOG_SPLIT_PHASES) }).notNull().default('plan'),

    reason: text().notNull(),
    /** An Oxy account id — no foreign key. */
    requestedByOxyUserId: text().notNull(),
    /** An Oxy account id — no foreign key. See `catalog_merge_jobs`. */
    approvedByOxyUserId: text(),
    approvedAt: timestamptz(),
    requiresSecondApproval: boolean().notNull().default(false),

    /** The merge this split reverses, when it is reversing one. */
    reversesMergeJobId: text().references(() => catalogMergeJobs.id, { onDelete: 'restrict' }),
    reviewItemId: text().references((): AnyPgColumn => catalogReviewItems.id, {
      onDelete: 'set null',
    }),

    ...impactColumns(),
    ...jobRuntimeColumns(),
  },
  (t) => {
    const impact = {
      impactSourceLinks: t.impactSourceLinks,
      impactIdentifiers: t.impactIdentifiers,
      impactAliases: t.impactAliases,
      impactOffers: t.impactOffers,
      impactNativeListingLinks: t.impactNativeListingLinks,
      impactRelationships: t.impactRelationships,
      impactReviews: t.impactReviews,
      impactChildEntities: t.impactChildEntities,
      impactAttributeValues: t.impactAttributeValues,
      impactImages: t.impactImages,
      impactUntouchedOrderItems: t.impactUntouchedOrderItems,
      impactTotalMoving: t.impactTotalMoving,
    };
    return [
      checkOneOf('catalog_split_jobs_entity_type_check', t.entityType, SPLITTABLE_ENTITY_TYPES),
      checkOneOf('catalog_split_jobs_target_mode_check', t.targetMode, CATALOG_SPLIT_TARGET_MODES),
      checkOneOf('catalog_split_jobs_phase_check', t.phase, CATALOG_SPLIT_PHASES),
      ...jobRuntimeChecks('catalog_split_jobs', {
        status: t.status,
        attempts: t.attempts,
        leaseOwner: t.leaseOwner,
        leaseUntil: t.leaseUntil,
        lastError: t.lastError,
        completedAt: t.completedAt,
      }),
      ...impactChecks('catalog_split_jobs', impact),
      check('catalog_split_jobs_reason_check', sql`btrim(${t.reason}) <> ''`),
      check(
        'catalog_split_jobs_reason_length_check',
        sql`length(${t.reason}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
      ),
      check('catalog_split_jobs_actor_check', sql`btrim(${t.requestedByOxyUserId}) <> ''`),
      /**
       * The per-mode shape, with the same `else false` branch every kind CHECK
       * in this graph carries. A `revive_tombstone` job naming a slug would be
       * proposing to rename the identity it is bringing back, which is a
       * different act and needs a different decision.
       */
      check(
        'catalog_split_jobs_target_shape_check',
        sql`case ${t.targetMode}
              when 'revive_tombstone' then
                ${t.targetEntityId} is not null and ${t.targetSlug} is null and ${t.targetName} is null
              when 'new_entity' then
                btrim(coalesce(${t.targetSlug}, '')) <> '' and btrim(coalesce(${t.targetName}, '')) <> ''
              else false
            end`,
      ),
      /**
       * A NEW entity may be minted only for a canonical PRODUCT.
       *
       * A variant's identity is its option assignments — `signature` is a digest
       * of them and `(product_id, signature)` is unique — so minting one needs
       * the axes, which a split's contract does not carry and must not invent. A
       * variant split is therefore always the REVIVAL of a tombstone, which is
       * the case #59 acceptance 2 actually describes: undoing a merge that
       * should not have happened. A genuinely new variant is a CREATE through
       * #56's own service, where the signature is computed from declared axes.
       */
      check(
        'catalog_split_jobs_new_entity_grain_check',
        sql`${t.targetMode} <> 'new_entity' or ${t.entityType} = 'canonical_product'`,
      ),
      check(
        'catalog_split_jobs_distinct_check',
        sql`${t.targetEntityId} is null or ${t.targetEntityId} <> ${t.sourceEntityId}`,
      ),
      /**
       * Nothing is reassigned before the destination EXISTS. An interrupted
       * split can therefore never leave rows pointing at an entity that was
       * never minted, which is half of invariant 5.
       */
      check(
        'catalog_split_jobs_destination_before_assignment_check',
        sql`${t.phase} in ('plan', 'mint') or ${t.targetEntityId} is not null`,
      ),
      check(
        'catalog_split_jobs_approver_distinct_check',
        sql`${t.approvedByOxyUserId} is null or ${t.approvedByOxyUserId} <> ${t.requestedByOxyUserId}`,
      ),
      check(
        'catalog_split_jobs_approval_state_check',
        sql`(${t.approvedByOxyUserId} is null) = (${t.approvedAt} is null)`,
      ),
      check(
        'catalog_split_jobs_second_approval_check',
        sql`not ${t.requiresSecondApproval} or ${t.phase} = 'plan' or ${t.approvedByOxyUserId} is not null`,
      ),
      check(
        'catalog_split_jobs_completed_phase_check',
        sql`${t.status} <> 'completed' or ${t.phase} = 'done'`,
      ),
      /** ONE live split per source entity — the merge job's reasoning, mirrored. */
      uniqueIndex('catalog_split_jobs_open_key')
        .on(t.entityType, t.sourceEntityId)
        .where(sql`${t.status} in ('pending', 'processing', 'blocked')`),
      index('catalog_split_jobs_pending_idx')
        .on(t.availableAt, t.createdAt)
        .where(sql`${t.status} = 'pending'`),
      index('catalog_split_jobs_reclaim_idx')
        .on(t.leaseUntil, t.createdAt)
        .where(sql`${t.status} = 'processing'`),
      index('catalog_split_jobs_blocked_idx')
        .on(t.createdAt)
        .where(sql`${t.status} = 'blocked'`),
      index('catalog_split_jobs_reverses_idx')
        .on(t.reversesMergeJobId)
        .where(sql`${t.reversesMergeJobId} is not null`),
    ];
  },
);

/**
 * `catalog_split_assignments` — exactly which children move (#59 split
 * invariant 1).
 *
 * A child not named here STAYS. Silence is never a move, which is what lets an
 * operator read the assignment list and know the whole effect of a split without
 * re-deriving anything.
 *
 * ## `item_ref` carries no foreign key, and this is the one place in the domain
 * where that was the better answer
 *
 * The target table is a TWO-key dispatch: `(job.entity_type, item_type)` selects
 * one of twelve tables, because source links, aliases, attribute values and
 * images are all per-entity tables (`canonical_product_aliases` versus
 * `canonical_variant_aliases`, and so on). Twelve nullable foreign-key columns
 * on a row that names exactly one of them is a shape no reviewer can check, and
 * the CHECK selecting between them would be longer than this table.
 *
 * What it gives up is stated rather than waved away: an assignment naming a row
 * that has since gone is applied as a no-op and recorded with
 * `skipped_reason = 'item_missing'`, which is the outcome a RESTRICT reference
 * would have produced minus the ability to block the delete. In practice these
 * rows CASCADE from an entity that is never hard-deleted (ADR 0002 D20), so the
 * case is one the schema does not reach — and the split's `verify` phase counts
 * applied rows against assigned rows, so a silent miss is visible rather than
 * absorbed.
 *
 * Named `_ref` rather than `_id` for the reason `offers.source_account_ref` is:
 * so it reads as a key this table does not constrain.
 */
export const catalogSplitAssignments = pgTable(
  'catalog_split_assignments',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => catalogSplitJobs.id, { onDelete: 'cascade' }),
    itemType: text({ enum: asEnumValues(CATALOG_SPLIT_ITEM_TYPES) }).notNull(),
    /** The row that moves, in whichever table `(job.entity_type, item_type)` names. */
    itemRef: text().notNull(),
    /** Stamped by the CAS that moved it. NULL means not yet applied. */
    appliedAt: timestamptz(),
    /** Why it did not move, when it did not. Present exactly when unapplied and closed. */
    skippedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_split_assignments_item_type_check', t.itemType, CATALOG_SPLIT_ITEM_TYPES),
    check('catalog_split_assignments_item_ref_check', sql`btrim(${t.itemRef}) <> ''`),
    /** Applied and skipped are different outcomes; a row cannot claim both. */
    check(
      'catalog_split_assignments_outcome_check',
      sql`${t.appliedAt} is null or ${t.skippedReason} is null`,
    ),
    check(
      'catalog_split_assignments_skip_length_check',
      sql`${t.skippedReason} is null or length(${t.skippedReason}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    /**
     * The idempotency key AND the "exactly which" guarantee in one index: an
     * item can be named once per job, so re-submitting a plan converges and a
     * resumed `assignments` phase re-applies nothing.
     */
    uniqueIndex('catalog_split_assignments_key').on(t.jobId, t.itemType, t.itemRef),
    /** The resume's own scan: what this job still owes. */
    index('catalog_split_assignments_pending_idx')
      .on(t.jobId, t.itemType)
      .where(sql`${t.appliedAt} is null and ${t.skippedReason} is null`),
  ],
);

/**
 * `catalog_review_items` — the queue (#59 review queue 1–8).
 *
 * ## It POINTS at #58's review state and never copies it
 *
 * `match_decisions.review_state` is the matcher's own field and stays it. An
 * `ambiguous_match` item carries a real foreign key to the decision and reads
 * the verdict through it. Two representations of one review state would
 * disagree the first time one path forgot the other, and the path that forgets
 * is always the one nobody is looking at.
 *
 * ## The subject carries no foreign key, and the counterpart neither
 *
 * `subject_type` selects one of THIRTEEN tables, six of which are not entities
 * at all. The ledger entry states ADR 0002 D16's own reason for
 * `catalog_revisions.entity_id`, which this column shares exactly: it spans
 * types, and an item about an entity that has since been merged away must stay
 * readable — a foreign key would be satisfied (tombstones survive) but the
 * column would still have to be one of thirteen.
 *
 * ## Convergence, and why it is scoped to the ACTIVE states
 *
 * `dedupe_key` plus a partial unique over `open`/`in_review` means a detector
 * re-raising the same problem bumps `last_detected_at` and `detection_count`
 * instead of filling the inbox. Once an item is RESOLVED the key is free again,
 * which is deliberate: a problem that comes back after somebody fixed it is new
 * information, and burying it under the old item's resolution would hide a
 * regression.
 */
export const catalogReviewItems = pgTable(
  'catalog_review_items',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(CURATION_REVIEW_KINDS) }).notNull(),
    detector: text({ enum: asEnumValues(CURATION_DETECTORS) }).notNull(),

    subjectType: text({ enum: asEnumValues(CURATION_SUBJECT_TYPES) }).notNull(),
    /** The subject's id in whichever table `subject_type` names. Ledgered. */
    subjectId: text().notNull(),
    counterpartType: text({ enum: asEnumValues(CURATION_SUBJECT_TYPES) }),
    /** The other side of a pair-shaped kind. Ledgered. */
    counterpartId: text(),

    /** The explanation, positive and negative — the `MATCH_REASON_CODES` shape. */
    reasonCodes: text().array().notNull().default(sql`'{}'::text[]`),
    /** 0–1, and NULL for a deterministic detection. The graph's usual semantics. */
    confidence: doublePrecision(),

    state: text({ enum: asEnumValues(CURATION_REVIEW_STATES) }).notNull().default('open'),
    /** An Oxy account id — no foreign key. Who claimed it, so two operators do not both start. */
    assignedToOxyUserId: text(),
    assignedAt: timestamptz(),

    resolution: text({ enum: asEnumValues(CURATION_RESOLUTIONS) }),
    resolutionReason: text(),
    /** An Oxy account id — no foreign key. */
    resolvedByOxyUserId: text(),
    resolvedAt: timestamptz(),

    /** The #58 decision this item is about. CASCADE: no decision, no review of it. */
    matchDecisionId: text().references(() => matchDecisions.id, { onDelete: 'cascade' }),
    /** The policy in force when the item was raised — a `policy_regression`'s subject. */
    policyVersionId: text().references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),
    /** The observation behind a `source_fact_disagreement` or an orphan. RESTRICT (D19). */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),

    detectionCount: integer().notNull().default(1),
    firstDetectedAt: timestamptz().notNull(),
    lastDetectedAt: timestamptz().notNull(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The convergence key. GENERATED from the columns it summarises, with
     * `coalesce` and `||` — both IMMUTABLE, which a stored generated column
     * requires. `|` is the separator every other collapsed key in this graph
     * uses, and no uuid v7 contains it.
     */
    dedupeKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`"kind" || '|' || "subject_type" || '|' || "subject_id" || '|' ||
            coalesce("counterpart_type", '') || '|' || coalesce("counterpart_id", '')`,
      ),
  },
  (t) => [
    checkOneOf('catalog_review_items_kind_check', t.kind, CURATION_REVIEW_KINDS),
    checkOneOf('catalog_review_items_detector_check', t.detector, CURATION_DETECTORS),
    checkOneOf('catalog_review_items_subject_type_check', t.subjectType, CURATION_SUBJECT_TYPES),
    checkOneOf(
      'catalog_review_items_counterpart_type_check',
      t.counterpartType,
      CURATION_SUBJECT_TYPES,
    ),
    checkOneOf('catalog_review_items_state_check', t.state, CURATION_REVIEW_STATES),
    checkOneOf('catalog_review_items_resolution_check', t.resolution, CURATION_RESOLUTIONS),
    checkEveryElementOf(
      'catalog_review_items_reason_codes_check',
      t.reasonCodes,
      CURATION_REASON_CODES,
    ),
    check('catalog_review_items_subject_id_check', sql`btrim(${t.subjectId}) <> ''`),
    /** A counterpart is a type AND an id, or it is neither. */
    check(
      'catalog_review_items_counterpart_pair_check',
      sql`num_nonnulls(${t.counterpartType}, ${t.counterpartId}) in (0, 2)`,
    ),
    /**
     * A pair-shaped kind cannot be stored with one side. "These two are
     * duplicates" is a proposition about two rows, and an item holding one of
     * them is unactionable — the reviewer would have to guess what it was
     * compared against.
     */
    check(
      'catalog_review_items_pair_shape_check',
      sql`(${t.kind} in (${sql.raw(inValues(CURATION_PAIRED_REVIEW_KINDS))}))
          = (${t.counterpartId} is not null)`,
    ),
    check(
      'catalog_review_items_self_pair_check',
      sql`${t.counterpartId} is null
          or ${t.counterpartId} <> ${t.subjectId}
          or ${t.counterpartType} <> ${t.subjectType}`,
    ),
    /**
     * The duplicate kinds store their pair in ID ORDER, so (A,B) and (B,A) are
     * ONE item. Without it the queue shows one problem twice and two operators
     * resolve it two ways.
     *
     * `identifier_conflict` is excluded because there the direction MEANS
     * something: the subject is the disputed newcomer and the counterpart is
     * the incumbent active owner, and ordering them by id would erase which is
     * which.
     */
    check(
      'catalog_review_items_pair_order_check',
      sql`${t.kind} not in (${sql.raw(inValues(CURATION_ORDERED_PAIR_REVIEW_KINDS))})
          or ${t.subjectId} < ${t.counterpartId}`,
    ),
    check(
      'catalog_review_items_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    /** An assignment is a person and a time, or it is neither. */
    check(
      'catalog_review_items_assignment_check',
      sql`num_nonnulls(${t.assignedToOxyUserId}, ${t.assignedAt}) in (0, 2)`,
    ),
    /**
     * A closed item names its outcome, its actor and its reason; an open one
     * names none of them. Both directions, so an item cannot be quietly
     * resolved by writing a timestamp.
     */
    check(
      'catalog_review_items_closure_check',
      sql`case when ${t.state} in ('resolved', 'dismissed')
                 then ${t.resolution} is not null and ${t.resolvedByOxyUserId} is not null
                      and ${t.resolvedAt} is not null
                      and btrim(coalesce(${t.resolutionReason}, '')) <> ''
                 else ${t.resolution} is null and ${t.resolvedByOxyUserId} is null
                      and ${t.resolvedAt} is null and ${t.resolutionReason} is null
           end`,
    ),
    /**
     * A DISMISSAL is a statement that nothing needed doing, so it may carry only
     * the two resolutions that say so — and a graph-changing resolution may not
     * be recorded as a dismissal. Reading "merged" on a dismissed item would
     * make the queue's own metrics lie about how much work it produced.
     */
    check(
      'catalog_review_items_dismissal_check',
      sql`${t.state} <> 'dismissed'
          or ${t.resolution} in (${sql.raw(inValues(CURATION_DISMISSAL_RESOLUTIONS))})`,
    ),
    check(
      'catalog_review_items_resolved_action_check',
      sql`${t.state} <> 'resolved'
          or ${t.resolution} not in (${sql.raw(inValues(CURATION_DISMISSAL_RESOLUTIONS))})`,
    ),
    /** An `ambiguous_match` item is about a decision, and nothing else may claim one. */
    check(
      'catalog_review_items_match_decision_check',
      sql`${t.matchDecisionId} is null or ${t.kind} = 'ambiguous_match'`,
    ),
    check(
      'catalog_review_items_counts_check',
      sql`${t.detectionCount} >= 1 and ${t.lastDetectedAt} >= ${t.firstDetectedAt}`,
    ),
    check(
      'catalog_review_items_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    check(
      'catalog_review_items_reason_length_check',
      sql`${t.resolutionReason} is null or length(${t.resolutionReason}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    /** ONE open item per problem. See the note above on why it is not global. */
    uniqueIndex('catalog_review_items_open_key')
      .on(t.dedupeKey)
      .where(sql`${t.state} in (${sql.raw(inValues(CURATION_ACTIVE_REVIEW_STATES))})`),
    /** The inbox, oldest first, per kind. */
    index('catalog_review_items_inbox_idx')
      .on(t.kind, t.firstDetectedAt)
      .where(sql`${t.state} in ('open', 'in_review')`),
    /** "What is waiting on me." */
    index('catalog_review_items_assignee_idx')
      .on(t.assignedToOxyUserId, t.state)
      .where(sql`${t.assignedToOxyUserId} is not null`),
    /** Every item ever raised about one row, from either side of a pair. */
    index('catalog_review_items_subject_idx').on(t.subjectType, t.subjectId, t.createdAt.desc()),
    index('catalog_review_items_counterpart_idx')
      .on(t.counterpartType, t.counterpartId)
      .where(sql`${t.counterpartId} is not null`),
    index('catalog_review_items_reason_codes_idx').using('gin', t.reasonCodes),
    index('catalog_review_items_match_decision_idx')
      .on(t.matchDecisionId)
      .where(sql`${t.matchDecisionId} is not null`),
  ],
);

/**
 * `catalog_entity_suppressions` — hidden from public discovery, with every piece
 * of evidence intact (#59 operator action 9).
 *
 * The distinction this table exists to keep is the one an operator under
 * pressure is most likely to lose: a suppression is not a delete and not a
 * merge. The entity keeps its row, its source links, its identifiers, its
 * offers and its history; it stops being FOUND. Lifting one is a single UPDATE
 * and the entity comes back exactly as it was, which is what makes suppression
 * the safe first response to a suspicion nobody has confirmed yet.
 *
 * The `status = 'suppressed'` value that already exists on every canonical
 * entity is the READ-side effect; this table is the RECORD of who hid it and
 * why. Neither substitutes for the other — the status is what a query filters
 * on, and a status alone cannot say whether a person decided it or a bug did.
 */
export const catalogEntitySuppressions = pgTable(
  'catalog_entity_suppressions',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(CATALOG_SUPPRESSIBLE_TYPES) }).notNull(),
    /** Ledgered — spans eight tables, for `catalog_merge_jobs`' reason. */
    entityId: text().notNull(),
    scope: text({ enum: asEnumValues(CATALOG_SUPPRESSION_SCOPES) }).notNull(),
    reason: text({ enum: asEnumValues(CATALOG_SUPPRESSION_REASONS) }).notNull(),
    note: text(),
    /** An Oxy account id — no foreign key. MANDATORY. */
    suppressedByOxyUserId: text().notNull(),
    suppressedAt: timestamptz().notNull(),
    liftedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    liftedByOxyUserId: text(),
    liftReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_entity_suppressions_entity_type_check',
      t.entityType,
      CATALOG_SUPPRESSIBLE_TYPES,
    ),
    checkOneOf('catalog_entity_suppressions_scope_check', t.scope, CATALOG_SUPPRESSION_SCOPES),
    checkOneOf('catalog_entity_suppressions_reason_check', t.reason, CATALOG_SUPPRESSION_REASONS),
    check('catalog_entity_suppressions_entity_id_check', sql`btrim(${t.entityId}) <> ''`),
    check('catalog_entity_suppressions_actor_check', sql`btrim(${t.suppressedByOxyUserId}) <> ''`),
    /**
     * A lift is attributable and reasoned, or it did not happen — the
     * `match_blocked_pairs_cleared_state_check` discipline. Un-hiding something
     * anonymously is exactly the act an audit trail exists to prevent.
     */
    check(
      'catalog_entity_suppressions_lift_state_check',
      sql`${t.liftedAt} is null
          or (${t.liftedByOxyUserId} is not null and btrim(coalesce(${t.liftReason}, '')) <> '')`,
    ),
    check(
      'catalog_entity_suppressions_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    /** ONE live suppression per (entity, scope). History is lifted rows. */
    uniqueIndex('catalog_entity_suppressions_open_key')
      .on(t.entityType, t.entityId, t.scope)
      .where(sql`${t.liftedAt} is null`),
    index('catalog_entity_suppressions_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
  ],
);

/**
 * `catalog_revisions` — the immutable audit timeline (ADR 0002 D16, #59
 * acceptance 4 and security 3).
 *
 * One row per ACTION, with a mandatory actor kind, a mandatory reason and the
 * before/after snapshot. The `relationship_reviews` and `payment_repairs`
 * discipline: append-only by TRIGGER rather than by convention, because a
 * backfill script and an operator at a `psql` prompt both reach this table
 * without the service, and an audit trail that can be edited is not one.
 *
 * ## `before` and `after` are the graph's ONE legitimate `jsonb` pair
 *
 * ADR 0002 D16 names them, and the reason is exact: a revision has to capture
 * whatever the entity looked like, INCLUDING columns a later schema removed.
 * Projecting them into typed columns would make the audit trail lossy the first
 * time the schema moved — which is precisely when somebody needs to read an old
 * revision. Every other fact on this row is a real column, because a reviewer
 * filters on it.
 *
 * ## `compensates_revision_id` runs BACKWARDS in time
 *
 * The compensating correction (#59 operator action 10) NAMES the revision it
 * undoes, rather than the undone revision naming its successor. The pointer
 * therefore always resolves — the direction the referral domain and
 * `product_identifiers.supersedes_identifier_id` both learned the hard way. An
 * undo is a new act with its own actor and reason; nothing is rewritten, and the
 * timeline shows both.
 */
export const catalogRevisions = pgTable(
  'catalog_revisions',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(CURATION_SUBJECT_TYPES) }).notNull(),
    /**
     * The entity this revision is about. NO foreign key, permanently, and ADR
     * 0002 D16 states the reason: it spans entity types and must survive the
     * tombstones these very rows create.
     */
    entityId: text().notNull(),
    action: text({ enum: asEnumValues(CATALOG_REVISION_ACTIONS) }).notNull(),
    actorKind: text({ enum: asEnumValues(CATALOG_REVISION_ACTOR_KINDS) }).notNull(),
    /** An Oxy account id — no foreign key. Present EXACTLY for an operator act. */
    actorOxyUserId: text(),
    /** MANDATORY (#59 security 2). An unexplained graph change is unrepresentable. */
    reason: text().notNull(),
    note: text(),

    /** The observation behind an ingestion revision. RESTRICT (ADR 0002 D19). */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** The matching policy in force — #59 security 3 asks for it by name. */
    policyVersionId: text().references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),
    /** The job this revision came out of. At most one, by CHECK. */
    mergeJobId: text().references(() => catalogMergeJobs.id, { onDelete: 'restrict' }),
    splitJobId: text().references(() => catalogSplitJobs.id, { onDelete: 'restrict' }),
    /** The queue item this act answered. `set null`: the timeline outlives the queue. */
    reviewItemId: text().references(() => catalogReviewItems.id, { onDelete: 'set null' }),
    /** The revision this one UNDOES. Backwards in time, so it always resolves. */
    compensatesRevisionId: text().references((): AnyPgColumn => catalogRevisions.id, {
      onDelete: 'restrict',
    }),

    before: jsonb(),
    after: jsonb(),

    // Append-only: no `updated_at`, the `order_status_history` contract.
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('catalog_revisions_entity_type_check', t.entityType, CURATION_SUBJECT_TYPES),
    checkOneOf('catalog_revisions_action_check', t.action, CATALOG_REVISION_ACTIONS),
    checkOneOf('catalog_revisions_actor_kind_check', t.actorKind, CATALOG_REVISION_ACTOR_KINDS),
    check('catalog_revisions_entity_id_check', sql`btrim(${t.entityId}) <> ''`),
    check('catalog_revisions_reason_check', sql`btrim(${t.reason}) <> ''`),
    check(
      'catalog_revisions_reason_length_check',
      sql`length(${t.reason}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    check(
      'catalog_revisions_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(CURATION_MAX_TEXT_LENGTH))}`,
    ),
    /**
     * An operator revision names a person and a machine one does not. BOTH
     * directions: an `oxy_user_id` on an ingestion row would read as somebody
     * having decided what a feed merely asserted, which is the misattribution an
     * audit trail can least afford.
     */
    check(
      'catalog_revisions_actor_presence_check',
      sql`(${t.actorKind} = 'operator') = (${t.actorOxyUserId} is not null)`,
    ),
    check(
      'catalog_revisions_actor_shape_check',
      sql`${t.actorOxyUserId} is null or btrim(${t.actorOxyUserId}) <> ''`,
    ),
    /** A revision belongs to at most one job; two would make the trace ambiguous. */
    check(
      'catalog_revisions_job_check',
      sql`num_nonnulls(${t.mergeJobId}, ${t.splitJobId}) <= 1`,
    ),
    check(
      'catalog_revisions_compensates_self_check',
      sql`${t.compensatesRevisionId} is null or ${t.compensatesRevisionId} <> ${t.id}`,
    ),
    /** Only a compensating correction may name what it undoes, and it must. */
    check(
      'catalog_revisions_compensation_shape_check',
      sql`(${t.action} = 'compensate') = (${t.compensatesRevisionId} is not null)`,
    ),
    /**
     * THE TIMELINE (#59 acceptance 4): every action on one entity, newest first.
     * The index is that query's own shape, which is why `entity_id` has no
     * foreign key and still has an ordering.
     */
    index('catalog_revisions_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
    index('catalog_revisions_action_idx').on(t.action, t.createdAt.desc()),
    index('catalog_revisions_actor_idx')
      .on(t.actorOxyUserId, t.createdAt.desc())
      .where(sql`${t.actorOxyUserId} is not null`),
    index('catalog_revisions_merge_job_idx')
      .on(t.mergeJobId)
      .where(sql`${t.mergeJobId} is not null`),
    index('catalog_revisions_split_job_idx')
      .on(t.splitJobId)
      .where(sql`${t.splitJobId} is not null`),
    index('catalog_revisions_review_item_idx')
      .on(t.reviewItemId)
      .where(sql`${t.reviewItemId} is not null`),
    /** "Has this already been undone?" — the compensating correction's own lookup. */
    index('catalog_revisions_compensates_idx')
      .on(t.compensatesRevisionId)
      .where(sql`${t.compensatesRevisionId} is not null`),
  ],
);

export type CatalogRevisionRow = typeof catalogRevisions.$inferSelect;
export type CatalogMergeJobRow = typeof catalogMergeJobs.$inferSelect;
export type CatalogMergeConflictRow = typeof catalogMergeConflicts.$inferSelect;
export type CatalogMergeJobPhaseRow = typeof catalogMergeJobPhases.$inferSelect;
export type CatalogSplitJobRow = typeof catalogSplitJobs.$inferSelect;
export type CatalogSplitAssignmentRow = typeof catalogSplitAssignments.$inferSelect;
export type CatalogReviewItemRow = typeof catalogReviewItems.$inferSelect;
export type CatalogEntitySuppressionRow = typeof catalogEntitySuppressions.$inferSelect;
