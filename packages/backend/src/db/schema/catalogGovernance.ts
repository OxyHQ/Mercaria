/**
 * Catalog administration and governance (#367 Workstream 12) —
 * `catalog_governance_change_requests`, `catalog_governance_impact_counts`,
 * `catalog_governance_audit_events`, `catalog_governance_role_grants` and
 * `catalog_governance_definition_snapshots`.
 *
 * Five tables for a domain that writes none of the catalogue. Every governance
 * apply calls the owning domain's own writer — `taxonomyRepository.moveCategory`,
 * `publishProductTypeVersion`, `deprecateAttributeDefinition`,
 * `publishNavigationTree` — so what these tables hold is the DECISION, its
 * measured blast radius, who took it and why. Nothing here is a second copy of
 * a catalogue fact.
 *
 * ## Why a change request exists at all, when every domain already has a writer
 *
 * The domains landed with their writers and without three things the epic asks
 * for: an impact count before a move, a second pair of eyes on a high-impact
 * change, and an audit trail with a reason in it. Each of those could have been
 * bolted onto each writer separately, nine times, and the ninth one would have
 * been forgotten. One vehicle in front of all of them makes `apply` unreachable
 * without a planned row, and a planned row unreachable without its impact rows.
 *
 * ## The vacuity floor is a ROW COUNT, not a sum
 *
 * `catalog_governance_impact_counts` is one row per inbound reference the plan
 * declares — `listings.category_id`, `canonical_products.category_id` and the
 * other eighteen — each carrying its own count, even when that count is zero.
 * The parent row's `relations_counted` must equal the number of rows, and the
 * service refuses a plan whose `relations_counted` is below what
 * `impact-plan.ts` declared for that subject kind.
 *
 * A sum could not do this job. `0 = 0 + 0 + 0` is satisfied by a read that
 * found nothing AND by a read that never happened, and those are opposite
 * facts: the first says the change is safe, the second says nobody looked. So
 * `impact_coverage` discriminates them at the ROW SHAPE — an `unmeasured`
 * request carries no counters at all, enforced by two separate CHECKs rather
 * than one over their conjunction, because a single conjunction is satisfied
 * when both sides evaluate false.
 *
 * ## `subject_id` carries no foreign key, and that is two decisions at once
 *
 * One column cannot reference six tables. And an audit row must outlive what it
 * describes: a `restrict` key here would let a decided change request block a
 * catalogue merge, while every other `ON DELETE` would erase or silently empty
 * the record of what an operator decided — the `catalog_proposals`
 * `resolved_entity_id` ruling, one domain over. Both columns are ledgered in
 * `deferredForeignKeys.ts`.
 *
 * ## Four eyes is snapshotted, and the reason is #59's
 *
 * `requires_second_approval` is written at PLAN time from the measured impact
 * and `CATALOG_FOUR_EYES_REQUIRED`, never re-derived. The threshold and the
 * flag both move; a request whose approval requirement changed after somebody
 * approved it would either strand a legitimate change or let an unapproved one
 * through. `catalog_merge_jobs` reached the same place for the same reason.
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
  CATALOG_GOVERNANCE_ACTIONS,
  CATALOG_GOVERNANCE_ACTOR_KINDS,
  CATALOG_GOVERNANCE_AUDIT_ACTIONS,
  CATALOG_GOVERNANCE_AUDIT_SOURCES,
  CATALOG_GOVERNANCE_CHANGE_STATES,
  CATALOG_GOVERNANCE_DOMAINS,
  CATALOG_GOVERNANCE_IMPACT_COVERAGES,
  CATALOG_GOVERNANCE_REFERENCE_DISPOSITIONS,
  CATALOG_GOVERNANCE_ROLES,
  CATALOG_GOVERNANCE_SNAPSHOT_SCOPES,
  CATALOG_GOVERNANCE_SUBJECT_KINDS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/**
 * `catalog_governance_change_requests` — the ONE vehicle for a catalogue change
 * with a blast radius.
 *
 * The plan is frozen once the row leaves `planned`
 * (`mercaria_catalog_governance_change_frozen`): the impact an approver read and
 * the parameters they approved are the ones that execute. Without the freeze,
 * "approve" would mean "approve whatever this row says at apply time", which is
 * the shape of every four-eyes bypass there has ever been.
 */
export const catalogGovernanceChangeRequests = pgTable(
  'catalog_governance_change_requests',
  {
    id: generatedId(),
    domain: text({ enum: asEnumValues(CATALOG_GOVERNANCE_DOMAINS) }).notNull(),
    action: text({ enum: asEnumValues(CATALOG_GOVERNANCE_ACTIONS) }).notNull(),
    subjectKind: text({ enum: asEnumValues(CATALOG_GOVERNANCE_SUBJECT_KINDS) }).notNull(),
    /** Polymorphic across six subject kinds, no foreign key. See the file doc. */
    subjectId: text().notNull(),

    state: text({ enum: asEnumValues(CATALOG_GOVERNANCE_CHANGE_STATES) })
      .notNull()
      .default('planned'),

    /**
     * The action's own parameters — a new parent id, a merge target, a redirect
     * subject. The ONE jsonb in this domain, and it earns it the way
     * `catalog_authoring_drafts.schema_snapshot` does: it is an IMMUTABLE
     * snapshot of what was asked, frozen by trigger the moment the row leaves
     * `planned`, never queried by any read path and never joined on.
     *
     * Everything QUERYABLE is a real column beside it — the domain, the action,
     * the subject, the state, both actors, the impact. A parameter set that is
     * genuinely different for seventeen actions is the sparse-metadata case
     * `CONVENTIONS.md` permits; a `category_id` hidden in here would not be.
     */
    parameters: jsonb().$type<Record<string, unknown>>().notNull(),

    /** Why. NOT NULL and non-blank — a governance act with no stated reason is not one. */
    reason: text().notNull(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    requestedByOxyUserId: text().notNull(),
    requestedAt: timestamptz().notNull(),

    /**
     * Snapshotted at PLAN time from the measured impact and
     * `CATALOG_FOUR_EYES_REQUIRED`. Never re-derived — see the file doc.
     */
    requiresSecondApproval: boolean().notNull().default(false),
    approvedByOxyUserId: text(),
    approvedAt: timestamptz(),

    appliedAt: timestamptz(),
    /** Bounded operator-facing text on a `failed` request. Never a stack trace. */
    failureDetail: text(),

    /** See the file doc: the discriminant that tells an empty read from an empty result. */
    impactCoverage: text({ enum: asEnumValues(CATALOG_GOVERNANCE_IMPACT_COVERAGES) }).notNull(),
    /** How many inbound references `impact-plan.ts` declares for this subject kind. */
    impactRelationsDeclared: integer(),
    /** How many were actually counted. Must equal the child row count. */
    impactRelationsCounted: integer(),
    /** The sum of the child rows. */
    impactTotal: integer(),
    impactMeasuredAt: timestamptz(),
    /** Present exactly when coverage is `unmeasured`. */
    impactUnmeasuredReason: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_governance_change_requests_domain_check', t.domain, CATALOG_GOVERNANCE_DOMAINS),
    checkOneOf('catalog_governance_change_requests_action_check', t.action, CATALOG_GOVERNANCE_ACTIONS),
    checkOneOf(
      'catalog_governance_change_requests_subject_kind_check',
      t.subjectKind,
      CATALOG_GOVERNANCE_SUBJECT_KINDS,
    ),
    checkOneOf('catalog_governance_change_requests_state_check', t.state, CATALOG_GOVERNANCE_CHANGE_STATES),
    checkOneOf(
      'catalog_governance_change_requests_impact_coverage_check',
      t.impactCoverage,
      CATALOG_GOVERNANCE_IMPACT_COVERAGES,
    ),

    check(
      'catalog_governance_change_requests_reason_check',
      sql`btrim(${t.reason}) <> '' and btrim(${t.requestedByOxyUserId}) <> ''`,
    ),
    check('catalog_governance_change_requests_subject_check', sql`btrim(${t.subjectId}) <> ''`),

    // The measured half. Every counter is present, the total is the sum of the
    // child rows the service wrote, and the counted relations match the row
    // count. `impact_total` is deliberately NOT compared against the child rows
    // here — a CHECK may not contain a subquery — so the equality lives in
    // `insertChangeRequest`, which is the single writer, and a realdb case
    // drives it.
    check(
      'catalog_governance_change_requests_impact_measured_check',
      sql`${t.impactCoverage} <> 'measured'
          or (num_nonnulls(
                ${t.impactRelationsDeclared},
                ${t.impactRelationsCounted},
                ${t.impactTotal},
                ${t.impactMeasuredAt}
              ) = 4
              and ${t.impactUnmeasuredReason} is null
              and ${t.impactRelationsCounted} >= ${t.impactRelationsDeclared}
              and ${t.impactTotal} >= 0)`,
    ),
    // The unmeasured half, stated SEPARATELY. Written as one CHECK over the
    // conjunction of both shapes it would be satisfied by a row that is neither
    // — the #68 finding, which cost a real constraint that admitted exactly the
    // row it existed to refuse.
    check(
      'catalog_governance_change_requests_impact_unmeasured_check',
      sql`${t.impactCoverage} <> 'unmeasured'
          or (num_nonnulls(
                ${t.impactRelationsDeclared},
                ${t.impactRelationsCounted},
                ${t.impactTotal},
                ${t.impactMeasuredAt}
              ) = 0
              and btrim(coalesce(${t.impactUnmeasuredReason}, '')) <> '')`,
    ),

    // Four eyes means two people. A merchant who is also on the operator
    // allow-list is not the case this exists for — that one is closed by the
    // actor type — but an operator approving their own high-impact merge is.
    check(
      'catalog_governance_change_requests_approver_distinct_check',
      sql`${t.approvedByOxyUserId} is null
          or ${t.approvedByOxyUserId} <> ${t.requestedByOxyUserId}`,
    ),
    check(
      'catalog_governance_change_requests_approval_pair_check',
      sql`(${t.approvedByOxyUserId} is null) = (${t.approvedAt} is null)`,
    ),
    // A request that needs a second approval cannot reach a state that acts on
    // it without one. This is the constraint that makes the gate real: a
    // service bug that skipped the approval step is refused by the database.
    check(
      'catalog_governance_change_requests_second_approval_check',
      sql`not ${t.requiresSecondApproval}
          or ${t.state} in ('planned', 'rejected', 'withdrawn')
          or ${t.approvedByOxyUserId} is not null`,
    ),
    check(
      'catalog_governance_change_requests_applied_pair_check',
      sql`(${t.state} = 'applied') = (${t.appliedAt} is not null)`,
    ),
    check(
      'catalog_governance_change_requests_failure_check',
      sql`(${t.state} = 'failed') = (${t.failureDetail} is not null)`,
    ),
    // An unmeasured plan may be recorded and may never EXECUTE. The epic's
    // "impact counts before any move, merge or deprecation" is this line: an
    // operator can still see what was attempted and why it could not be
    // measured, and nothing can act on it.
    check(
      'catalog_governance_change_requests_unmeasured_not_applied_check',
      sql`${t.impactCoverage} = 'measured' or ${t.state} <> 'applied'`,
    ),

    index('catalog_governance_change_requests_queue_idx').on(t.state, t.requestedAt),
    index('catalog_governance_change_requests_subject_idx').on(t.subjectKind, t.subjectId),
    index('catalog_governance_change_requests_domain_idx').on(t.domain, t.state, t.requestedAt),
  ],
);

/**
 * `catalog_governance_impact_counts` — one row per inbound reference, written
 * with the plan and append-only afterwards.
 *
 * A row per relation rather than a column per relation, because the FK graph
 * grows: twenty tables reference `categories.id` today and the twenty-first
 * arrives with somebody else's migration. `impact-plan.ts`'s census walks the
 * drizzle barrel and fails the build until that twenty-first has a disposition,
 * which is the moment the person adding it is thinking about the question.
 *
 * `row_count` is NOT NULL and may be zero. A relation with no rows is a
 * measurement, and it is the whole difference between "nothing points at this
 * category" and "we did not look".
 */
export const catalogGovernanceImpactCounts = pgTable(
  'catalog_governance_impact_counts',
  {
    id: generatedId(),
    /**
     * `restrict`, agreeing with the append-only trigger. A cascade beside a
     * no-delete trigger is a way to remove the evidence by removing its parent,
     * and the two would disagree with the trigger winning confusingly — the
     * `catalog_review_events` ruling.
     */
    changeRequestId: text()
      .notNull()
      .references(() => catalogGovernanceChangeRequests.id, { onDelete: 'restrict' }),
    /** The SQL table name, derived from the drizzle column the plan holds. */
    referenceTable: text().notNull(),
    referenceColumn: text().notNull(),
    disposition: text({ enum: asEnumValues(CATALOG_GOVERNANCE_REFERENCE_DISPOSITIONS) }).notNull(),
    rowCount: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_governance_impact_counts_disposition_check',
      t.disposition,
      CATALOG_GOVERNANCE_REFERENCE_DISPOSITIONS,
    ),
    check('catalog_governance_impact_counts_row_count_check', sql`${t.rowCount} >= 0`),
    check(
      'catalog_governance_impact_counts_reference_check',
      sql`btrim(${t.referenceTable}) <> '' and btrim(${t.referenceColumn}) <> ''`,
    ),
    // One measurement per relation per request. Two rows for one relation would
    // double it into the total and make `relations_counted` a lie.
    uniqueIndex('catalog_governance_impact_counts_relation_key').on(
      t.changeRequestId,
      t.referenceTable,
      t.referenceColumn,
    ),
  ],
);

/**
 * `catalog_governance_audit_events` — actor, reason, before/after, source and
 * timestamp, append-only against UPDATE *and* DELETE.
 *
 * `at` and no `updated_at`: `CONVENTIONS.md` makes that absence the append-only
 * contract, and the trigger states it again for the reader who is looking at
 * the table rather than at this file.
 *
 * `change_request_id` is nullable because three audited acts have no request —
 * a role grant, a role revocation and a snapshot export. Making it NOT NULL
 * would have forced those three to mint an empty change request, which is a
 * record of a decision nobody made.
 *
 * `before` and `after` are jsonb and are the second and third permitted uses in
 * this domain: an immutable snapshot of a row as it stood, never read back into
 * a query and never joined on. Reconstructing what a definition looked like is
 * the ONE thing a governance audit exists for, and it cannot be done from typed
 * columns because the shape differs per subject kind.
 */
export const catalogGovernanceAuditEvents = pgTable(
  'catalog_governance_audit_events',
  {
    id: generatedId(),
    domain: text({ enum: asEnumValues(CATALOG_GOVERNANCE_DOMAINS) }).notNull(),
    action: text({ enum: asEnumValues(CATALOG_GOVERNANCE_AUDIT_ACTIONS) }).notNull(),
    subjectKind: text({ enum: asEnumValues(CATALOG_GOVERNANCE_SUBJECT_KINDS) }).notNull(),
    /** Polymorphic, no foreign key — the audit outlives what it describes. */
    subjectId: text().notNull(),

    actorKind: text({ enum: asEnumValues(CATALOG_GOVERNANCE_ACTOR_KINDS) }).notNull(),
    /** An Oxy account id — no foreign key. NULL exactly when the actor is `system`. */
    actorOxyUserId: text(),
    reason: text().notNull(),
    source: text({ enum: asEnumValues(CATALOG_GOVERNANCE_AUDIT_SOURCES) }).notNull(),

    changeRequestId: text().references(() => catalogGovernanceChangeRequests.id, {
      onDelete: 'restrict',
    }),

    before: jsonb().$type<unknown>(),
    after: jsonb().$type<unknown>(),

    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('catalog_governance_audit_events_domain_check', t.domain, CATALOG_GOVERNANCE_DOMAINS),
    checkOneOf(
      'catalog_governance_audit_events_action_check',
      t.action,
      CATALOG_GOVERNANCE_AUDIT_ACTIONS,
    ),
    checkOneOf(
      'catalog_governance_audit_events_subject_kind_check',
      t.subjectKind,
      CATALOG_GOVERNANCE_SUBJECT_KINDS,
    ),
    checkOneOf(
      'catalog_governance_audit_events_actor_kind_check',
      t.actorKind,
      CATALOG_GOVERNANCE_ACTOR_KINDS,
    ),
    checkOneOf('catalog_governance_audit_events_source_check', t.source, CATALOG_GOVERNANCE_AUDIT_SOURCES),
    // A human act names its human. `system` is the only actorless kind, and
    // making that a CHECK stops an unattributed governance decision existing.
    check(
      'catalog_governance_audit_events_actor_presence_check',
      sql`(${t.actorKind} = 'system') = (${t.actorOxyUserId} is null)`,
    ),
    check(
      'catalog_governance_audit_events_reason_check',
      sql`btrim(${t.reason}) <> '' and btrim(${t.subjectId}) <> ''`,
    ),
    index('catalog_governance_audit_events_subject_idx').on(t.subjectKind, t.subjectId, t.at),
    index('catalog_governance_audit_events_actor_idx').on(t.actorOxyUserId, t.at),
    index('catalog_governance_audit_events_request_idx').on(t.changeRequestId, t.at),
  ],
);

/**
 * `catalog_governance_role_grants` — the five capabilities, WITHIN the existing
 * allow-list.
 *
 * This table can only ever narrow. `CATALOG_OPERATOR_OXY_USER_IDS` decides who
 * reaches the surface at all — an account absent from it is answered 404 by
 * `requireCatalogOperator` before a grant is ever read — so no row here can
 * admit anybody, which is what keeps this from being a seventh allow-list.
 * `grant_operator_membership` is named in
 * `CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES` for the reader who wonders.
 *
 * ## The empty table means "role separation not adopted"
 *
 * A deployment with no rows here gives every allow-listed operator every role —
 * today's behaviour, which is what a rollout mechanism has to default to. The
 * moment ANY live grant exists the deployment has adopted role separation and
 * grants become authoritative. `role.service.ts` refuses a mutation that would
 * leave a non-empty grant set with no live `publish` holder, so the transition
 * cannot lock the deployment out of its own catalogue.
 *
 * A grant is REVOKED, never deleted: "who could publish last March" is a
 * question an incident asks, and a deleted row cannot answer it.
 */
export const catalogGovernanceRoleGrants = pgTable(
  'catalog_governance_role_grants',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. Must also be on the env allow-list. */
    subjectOxyUserId: text().notNull(),
    role: text({ enum: asEnumValues(CATALOG_GOVERNANCE_ROLES) }).notNull(),
    grantedByOxyUserId: text().notNull(),
    grantedAt: timestamptz().notNull(),
    reason: text().notNull(),
    revokedByOxyUserId: text(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_governance_role_grants_role_check', t.role, CATALOG_GOVERNANCE_ROLES),
    check(
      'catalog_governance_role_grants_actor_check',
      sql`btrim(${t.subjectOxyUserId}) <> ''
          and btrim(${t.grantedByOxyUserId}) <> ''
          and btrim(${t.reason}) <> ''`,
    ),
    check(
      'catalog_governance_role_grants_revocation_pair_check',
      sql`(${t.revokedByOxyUserId} is null) = (${t.revokedAt} is null)`,
    ),
    // One live grant per (person, role). A second would make revocation
    // ambiguous — revoking one row while another still admits the capability is
    // a revocation that did nothing, and it looks exactly like one that worked.
    uniqueIndex('catalog_governance_role_grants_live_key')
      .on(t.subjectOxyUserId, t.role)
      .where(sql`${t.revokedAt} is null`),
    index('catalog_governance_role_grants_subject_idx').on(t.subjectOxyUserId),
  ],
);

/**
 * `catalog_governance_definition_snapshots` — export, snapshot and restore for
 * catalog DEFINITIONS.
 *
 * Definitions only, and the absence is the guarantee: there is no column here
 * that could hold an order, a payment, a buyer or a listing, so "never
 * production order data" is a property of the schema rather than of whoever
 * writes the export query. `catalog-governance-isolation.test.ts` walks the
 * emitted document too, because a jsonb column can hold anything a composer
 * puts in it.
 *
 * The document is jsonb — the third and last permitted use, and the one
 * `CONVENTIONS.md` names outright: an immutable schema snapshot. It is written
 * once, digested, never queried by any predicate and never joined on.
 *
 * A restore is a change request (`definition_snapshot_restore`), so it is
 * planned, attributable and — like `seed-verticals`, whose vocabulary it
 * borrows — INSERT-ONLY. A divergent entity is REPORTED and never corrected,
 * because overwriting it would silently undo whatever an operator changed since
 * the snapshot was taken, which is precisely what somebody reaching for a
 * restore is trying to understand.
 */
export const catalogGovernanceDefinitionSnapshots = pgTable(
  'catalog_governance_definition_snapshots',
  {
    id: generatedId(),
    scope: text({ enum: asEnumValues(CATALOG_GOVERNANCE_SNAPSHOT_SCOPES) }).notNull(),
    /** sha-256 of the canonicalized document. Two identical exports converge on one digest. */
    contentDigest: text().notNull(),
    /** The definitions themselves. See the table doc for why this is jsonb. */
    document: jsonb().$type<unknown>().notNull(),

    /** Counted from the document at write time — the export's own positive control. */
    entityCount: integer().notNull(),
    categoryCount: integer().notNull(),
    productTypeCount: integer().notNull(),
    attributeCount: integer().notNull(),
    localizationCount: integer().notNull(),
    navigationTreeCount: integer().notNull(),

    /** An Oxy account id — no foreign key. */
    createdByOxyUserId: text().notNull(),
    reason: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_governance_definition_snapshots_scope_check',
      t.scope,
      CATALOG_GOVERNANCE_SNAPSHOT_SCOPES,
    ),
    check(
      'catalog_governance_definition_snapshots_digest_check',
      sql`${t.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'catalog_governance_definition_snapshots_actor_check',
      sql`btrim(${t.createdByOxyUserId}) <> '' and btrim(${t.reason}) <> ''`,
    ),
    // The vacuity floor, at the row: the headline is the sum of its parts and
    // every part is non-negative. #60's `catalog_backfill_runs` device — a run
    // that swallowed an entity cannot write a row.
    check(
      'catalog_governance_definition_snapshots_counts_check',
      sql`${t.categoryCount} >= 0
          and ${t.productTypeCount} >= 0
          and ${t.attributeCount} >= 0
          and ${t.localizationCount} >= 0
          and ${t.navigationTreeCount} >= 0
          and ${t.entityCount} = ${t.categoryCount}
                                + ${t.productTypeCount}
                                + ${t.attributeCount}
                                + ${t.localizationCount}
                                + ${t.navigationTreeCount}`,
    ),
    // An EMPTY snapshot is refusable at the row, and it has to be: an export
    // that read nothing digests cleanly, counts to zero and satisfies the sum
    // above. A restore from it would report "nothing to do" and be believed.
    check('catalog_governance_definition_snapshots_vacuity_check', sql`${t.entityCount} > 0`),
    index('catalog_governance_definition_snapshots_scope_idx').on(t.scope, t.createdAt),
    index('catalog_governance_definition_snapshots_digest_idx').on(t.contentDigest),
  ],
);

/*
 * A self-reference kept deliberately OUT of the schema.
 *
 * `catalog_governance_definition_snapshots` has no `restored_from_snapshot_id`
 * column. A restore names its snapshot through the change request's
 * `subject_id` (`subject_kind = 'definition_snapshot'`), which is the row that
 * already carries the actor, the reason and the impact. A second pointer would
 * be a second representation of one fact, and #66 measured what drizzle-kit
 * does with a circular declaration: it emitted no constraint, no snapshot entry
 * and enforced nothing, while type-checking cleanly.
 */
