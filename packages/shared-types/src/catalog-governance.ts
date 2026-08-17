/**
 * Catalog administration and governance (#367 Workstream 12) — the vocabularies
 * the operator surface over ADR 0007's nine catalog domains is built from.
 *
 * This domain **administers** and owns almost nothing. Taxonomy owns categories,
 * #94 owns attributes, #367 step 3 owns product types, step 6 owns proposals,
 * step 7 owns navigation, and each of them already holds the only writer of its
 * own tables. What was missing was everything BETWEEN them: an impact count
 * before a move, a diff between two schema versions, one audit trail that
 * spans all nine, review queues that are not nine separate reads, and the
 * two-person gate the epic asks for on a high-impact change.
 *
 * ## The one mutation vehicle
 *
 * Every act with a blast radius is a CHANGE REQUEST — planned, optionally
 * approved by a second operator, then applied by driving the owning domain's
 * OWN idempotent writer. That single shape is what makes four separate
 * requirements structural rather than remembered:
 *
 * 1. **Impact counts are shown before any move, merge or deprecation**, because
 *    `apply` is unreachable without a `planned` row, and a `planned` row cannot
 *    exist without its impact rows (`catalog_governance_impact_counts`).
 * 2. **Two-person review** is a gate in FRONT of the existing writer, so it adds
 *    no second way to mutate anything.
 * 3. **Audit is not a thing somebody remembers to write** — the request row is
 *    the record, and the append-only event trail is written on the same path.
 * 4. **A correction is a NEW request.** Nothing here rewrites history.
 *
 * The acts WITHOUT a blast radius — reviewing one translation, approving one
 * external mapping, settling one compatibility claim, deciding one proposal —
 * are `CatalogGovernanceReviewAction`s and go straight through to the domain
 * that owns them. They already carry an actor and a reason in their own tables;
 * wrapping a single-row decision in a two-phase plan would buy an impact count
 * that is always exactly one.
 *
 * ## What a merchant cannot do, and why it is not a check
 *
 * `CatalogGovernanceActor` is a branded type in
 * `services/catalog-governance/actor.ts` carrying a module-private
 * `unique symbol`. Only `governanceActor(req)` mints one, and it composes
 * `catalogOperatorId(req)` — which runs after `requireCatalogOperator`. Every
 * apply function takes one. A merchant-scoped path holds a store membership,
 * and there is no function anywhere that turns a store membership into this
 * type, so "a merchant role may never publish a global catalog change" is a
 * property of the call graph rather than a branch somebody could invert.
 *
 * ## Roles are a REFINEMENT of the existing allow-list, never an extension
 *
 * `CATALOG_OPERATOR_OXY_USER_IDS` stays the membership — this is not a seventh
 * allow-list. `CatalogGovernanceRole` narrows WITHIN it: a grant can only ever
 * take capability away from somebody the deployment already trusts, and an
 * account absent from the env list is answered 404 whatever grants exist.
 */

/**
 * The nine ADR 0007 domains this surface administers, plus the surface itself.
 *
 * The first nine name the domain that OWNS the write, which is the domain a
 * governance apply calls into — never a table this domain writes itself.
 *
 * `governance` is the tenth and is deliberately not one of the nine: a role
 * grant and a snapshot export are acts ABOUT the administration surface rather
 * than about a catalogue domain, and filing them under `taxonomy` would put
 * "who granted themselves publish" into the trail an operator reads when a
 * category went wrong. The `subject_kind` that goes with it is `operator_role`.
 */
export const CATALOG_GOVERNANCE_DOMAINS = [
  'taxonomy',
  'product_type',
  'attribute',
  'controlled_value',
  'localization',
  'external_mapping',
  'navigation',
  'compatibility',
  'proposal',
  'governance',
] as const;

export type CatalogGovernanceDomain = (typeof CATALOG_GOVERNANCE_DOMAINS)[number];

/**
 * What a governance change request POINTS AT. Four kinds and not nine, because
 * only four things in the catalogue have a blast radius large enough to need an
 * impact count before they move; the rest are single-row reviews.
 *
 * `subject_id` carries no foreign key. One column cannot reference four tables,
 * and an audit row must outlive whatever it describes — the `catalog_revisions`
 * and `merchant_claim_scopes.scope_ref` ruling.
 */
export const CATALOG_GOVERNANCE_SUBJECT_KINDS = [
  'category',
  'product_type_definition',
  'attribute_definition',
  'navigation_tree',
  'definition_snapshot',
  'vertical_package',
  'operator_role',
  'external_mapping',
  'compatibility_claim',
] as const;

export type CatalogGovernanceSubjectKind = (typeof CATALOG_GOVERNANCE_SUBJECT_KINDS)[number];

/**
 * The subject kinds an impact plan can be resolved for. A snapshot restore and a
 * vertical package apply are planned by DIFFING against what is stored, not by
 * counting inbound references, so they are deliberately excluded here — and the
 * exclusion is a tuple rather than an `if`, so `impact-plan.ts`'s census can
 * reconcile the two sets in BOTH directions.
 */
export const CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS = [
  'category',
  'product_type_definition',
  'attribute_definition',
  'navigation_tree',
] as const;

export type CatalogGovernanceCountedSubjectKind =
  (typeof CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS)[number];

/**
 * Acts with a blast radius. Every one goes through a change request, and every
 * one is applied by calling the owning domain's own writer.
 *
 * There is deliberately no `taxonomy_delete`, no `attribute_delete` and no
 * `product_type_delete`: none of those domains offers a delete, and a
 * governance surface that could remove a definition would be the one place in
 * the catalogue where history can be erased to hide a mistake.
 */
export const CATALOG_GOVERNANCE_ACTIONS = [
  'taxonomy_rename',
  'taxonomy_move',
  'taxonomy_merge',
  'taxonomy_redirect',
  'taxonomy_publish',
  'taxonomy_deprecate',
  'taxonomy_suppress',
  'taxonomy_restore',
  'product_type_publish',
  'product_type_deprecate',
  'attribute_publish',
  'attribute_deprecate',
  'attribute_retire',
  'navigation_publish',
  'navigation_archive',
  'definition_snapshot_restore',
  'vertical_package_apply',
] as const;

export type CatalogGovernanceAction = (typeof CATALOG_GOVERNANCE_ACTIONS)[number];

/**
 * Single-row review decisions, routed straight through to the domain that owns
 * them and recorded here. Each of these already carries an actor and a reason
 * in its own table; what this surface adds is that they land in ONE audit trail
 * and ONE queue beside every other kind of pending catalogue work.
 */
export const CATALOG_GOVERNANCE_REVIEW_ACTIONS = [
  'localization_review',
  'external_mapping_approve',
  'external_mapping_reject',
  'external_mapping_fan_out_approve',
  'compatibility_claim_review',
  /**
   * Turning one reviewed claim into a canonical fitment.
   *
   * Separate from `compatibility_claim_review` because they are different acts
   * with different consequences: a review records a judgement ABOUT a claim and
   * publishes nothing, while a promotion creates the row a shopper is shown. The
   * review surface deliberately cannot set `selected` — that state is written
   * only here, as part of creating the canonical row, so a claim cannot be
   * marked as chosen with nothing having chosen it.
   */
  'compatibility_claim_promote',
  'proposal_approve',
  'proposal_merge',
  'proposal_reject',
  'proposal_request_information',
  'proposal_defer',
  'proposal_redirect',
] as const;

export type CatalogGovernanceReviewAction = (typeof CATALOG_GOVERNANCE_REVIEW_ACTIONS)[number];

/**
 * Acts on the governance surface itself. They are audited under the same trail
 * because "who granted themselves publish" and "who restored a snapshot" are
 * exactly the questions an incident asks first.
 */
export const CATALOG_GOVERNANCE_LIFECYCLE_ACTIONS = [
  'change_requested',
  'change_approved',
  'change_applied',
  'change_rejected',
  'change_withdrawn',
  'change_failed',
  'role_granted',
  'role_revoked',
  'snapshot_exported',
] as const;

export type CatalogGovernanceLifecycleAction =
  (typeof CATALOG_GOVERNANCE_LIFECYCLE_ACTIONS)[number];

/**
 * Everything the audit trail can record. It is the UNION of the three tuples
 * above and nothing else — a census asserts containment in both directions, so
 * neither an action with no audit vocabulary nor an audit value no action
 * produces can survive a build.
 */
export const CATALOG_GOVERNANCE_AUDIT_ACTIONS = [
  ...CATALOG_GOVERNANCE_ACTIONS,
  ...CATALOG_GOVERNANCE_REVIEW_ACTIONS,
  ...CATALOG_GOVERNANCE_LIFECYCLE_ACTIONS,
] as const;

export type CatalogGovernanceAuditAction = (typeof CATALOG_GOVERNANCE_AUDIT_ACTIONS)[number];

/**
 * Where an audited act came from. The epic asks the audit trail to carry a
 * SOURCE beside the actor, and the reason is that "an operator pressed a
 * button", "a snapshot restore wrote this" and "a vertical package seeded it"
 * lead to three different next actions when a row turns out to be wrong.
 */
export const CATALOG_GOVERNANCE_AUDIT_SOURCES = [
  'operator_console',
  'change_request',
  'definition_snapshot',
  'vertical_package',
] as const;

export type CatalogGovernanceAuditSource = (typeof CATALOG_GOVERNANCE_AUDIT_SOURCES)[number];

/** An audited act names its human, unless it is the machine. */
export const CATALOG_GOVERNANCE_ACTOR_KINDS = ['operator', 'system'] as const;
export type CatalogGovernanceActorKind = (typeof CATALOG_GOVERNANCE_ACTOR_KINDS)[number];

/**
 * The five capabilities #367 Workstream 12 names. They partition the surface by
 * what a person is trusted to DO, within an allow-list that already decides who
 * may be here at all.
 *
 * `view` is the read gate and is required by no action, which is why the census
 * reconciles `{read role} ∪ image(CATALOG_GOVERNANCE_ACTION_ROLES)` against this
 * tuple rather than the image alone: a role required by nothing and granted by
 * nobody is indistinguishable from one doing work.
 */
export const CATALOG_GOVERNANCE_ROLES = [
  'view',
  'propose',
  'review',
  'translate',
  'publish',
] as const;

export type CatalogGovernanceRole = (typeof CATALOG_GOVERNANCE_ROLES)[number];

/** Reading anything on this surface needs this role and no more. */
export const CATALOG_GOVERNANCE_READ_ROLE: CatalogGovernanceRole = 'view';

/** Opening a change request needs this role; APPLYING it needs the action's own. */
export const CATALOG_GOVERNANCE_PROPOSE_ROLE: CatalogGovernanceRole = 'propose';

/**
 * The role each act requires, as a `Record` over the union and deliberately not
 * an array of pairs: a `Record` cannot omit a member, and an array silently
 * can. An action added to either tuple without a role fails `tsc`, which is the
 * only moment anybody is thinking about the question.
 */
export const CATALOG_GOVERNANCE_ACTION_ROLES: Record<
  CatalogGovernanceAction | CatalogGovernanceReviewAction,
  CatalogGovernanceRole
> = {
  taxonomy_rename: 'publish',
  taxonomy_move: 'publish',
  taxonomy_merge: 'publish',
  taxonomy_redirect: 'publish',
  taxonomy_publish: 'publish',
  taxonomy_deprecate: 'publish',
  taxonomy_suppress: 'publish',
  taxonomy_restore: 'publish',
  product_type_publish: 'publish',
  product_type_deprecate: 'publish',
  attribute_publish: 'publish',
  attribute_deprecate: 'publish',
  attribute_retire: 'publish',
  navigation_publish: 'publish',
  navigation_archive: 'publish',
  definition_snapshot_restore: 'publish',
  vertical_package_apply: 'publish',
  localization_review: 'translate',
  external_mapping_approve: 'review',
  external_mapping_reject: 'review',
  external_mapping_fan_out_approve: 'review',
  compatibility_claim_review: 'review',
  // `publish` and not `review`: a promotion CREATES the fitment a shopper acts
  // on, and a wrong one sells somebody a brake pad that does not fit their car.
  // Reviewing a claim publishes nothing, so the two acts sit either side of the
  // one role boundary this domain has.
  compatibility_claim_promote: 'publish',
  proposal_approve: 'review',
  proposal_merge: 'review',
  proposal_reject: 'review',
  proposal_request_information: 'review',
  proposal_defer: 'review',
  proposal_redirect: 'review',
};

/** The domain each change action drives, again as a total `Record`. */
export const CATALOG_GOVERNANCE_ACTION_DOMAINS: Record<
  CatalogGovernanceAction,
  CatalogGovernanceDomain
> = {
  taxonomy_rename: 'taxonomy',
  taxonomy_move: 'taxonomy',
  taxonomy_merge: 'taxonomy',
  taxonomy_redirect: 'taxonomy',
  taxonomy_publish: 'taxonomy',
  taxonomy_deprecate: 'taxonomy',
  taxonomy_suppress: 'taxonomy',
  taxonomy_restore: 'taxonomy',
  product_type_publish: 'product_type',
  product_type_deprecate: 'product_type',
  attribute_publish: 'attribute',
  attribute_deprecate: 'attribute',
  attribute_retire: 'attribute',
  navigation_publish: 'navigation',
  navigation_archive: 'navigation',
  definition_snapshot_restore: 'taxonomy',
  vertical_package_apply: 'taxonomy',
};

/** The subject kind each change action points at. */
export const CATALOG_GOVERNANCE_ACTION_SUBJECTS: Record<
  CatalogGovernanceAction,
  CatalogGovernanceSubjectKind
> = {
  taxonomy_rename: 'category',
  taxonomy_move: 'category',
  taxonomy_merge: 'category',
  taxonomy_redirect: 'category',
  taxonomy_publish: 'category',
  taxonomy_deprecate: 'category',
  taxonomy_suppress: 'category',
  taxonomy_restore: 'category',
  product_type_publish: 'product_type_definition',
  product_type_deprecate: 'product_type_definition',
  attribute_publish: 'attribute_definition',
  attribute_deprecate: 'attribute_definition',
  attribute_retire: 'attribute_definition',
  navigation_publish: 'navigation_tree',
  navigation_archive: 'navigation_tree',
  definition_snapshot_restore: 'definition_snapshot',
  vertical_package_apply: 'vertical_package',
};

/**
 * A change request's state. `failed` is a real terminal state and not a retry
 * loop: an apply that half-ran is a fact an operator has to look at, and a
 * surface that quietly retried would turn one visible failure into a silent
 * one. The remedy is a NEW request, which is the same remedy a correction has.
 */
export const CATALOG_GOVERNANCE_CHANGE_STATES = [
  'planned',
  'approved',
  'applied',
  'rejected',
  'withdrawn',
  'failed',
] as const;

export type CatalogGovernanceChangeState = (typeof CATALOG_GOVERNANCE_CHANGE_STATES)[number];

/** The states from which a request may still be decided. */
export const CATALOG_GOVERNANCE_OPEN_CHANGE_STATES = ['planned', 'approved'] as const;

/** The states a request never leaves. */
export const CATALOG_GOVERNANCE_TERMINAL_CHANGE_STATES = [
  'applied',
  'rejected',
  'withdrawn',
  'failed',
] as const;

/**
 * Whether an impact measurement actually ran.
 *
 * This is the whole reason a coverage discriminant exists beside the counters:
 * a read that found nothing and a read that never happened both produce zeroes,
 * and an equality check over zeroes (`0 = 0 + 0 + 0`) is satisfied by both. An
 * `unmeasured` request carries NO counters at all — the columns are NULL and a
 * CHECK says so — so the vacuous case has a different row shape rather than the
 * same numbers.
 */
export const CATALOG_GOVERNANCE_IMPACT_COVERAGES = ['measured', 'unmeasured'] as const;
export type CatalogGovernanceImpactCoverage =
  (typeof CATALOG_GOVERNANCE_IMPACT_COVERAGES)[number];

/**
 * What happens to the rows a governance change touches. Every foreign key into
 * a governed definition carries exactly one of these in `impact-plan.ts`, and a
 * census walks the drizzle barrel and fails the build until a newly added
 * reference has one.
 *
 * `rewire_path_missing` is the member that earns the tuple. It is not a
 * pessimistic default — it names a measured hole (`listings.category_slugs` is
 * denormalized at write time by `catalog-write.service` and NOTHING re-derives
 * it), and an operator reading an impact report needs to know which of the
 * counted rows the system will fix and which a person still has to. Recording
 * it as `untouched` would be a plan claiming the work is done.
 */
export const CATALOG_GOVERNANCE_REFERENCE_DISPOSITIONS = [
  'blocks',
  'cascades',
  'rewired_by_domain',
  'rewire_path_missing',
] as const;

export type CatalogGovernanceReferenceDisposition =
  (typeof CATALOG_GOVERNANCE_REFERENCE_DISPOSITIONS)[number];

/** What a definition snapshot covers. */
export const CATALOG_GOVERNANCE_SNAPSHOT_SCOPES = [
  'taxonomy',
  'product_types',
  'attributes',
  'localization',
  'navigation',
  'all',
] as const;

export type CatalogGovernanceSnapshotScope =
  (typeof CATALOG_GOVERNANCE_SNAPSHOT_SCOPES)[number];

/**
 * What a snapshot restore decided about one entity, and it is the
 * `seed-verticals` vocabulary on purpose: `create` writes what is missing,
 * `present` is a no-op, and **`divergent` is REPORTED and never corrected**.
 * A restore that overwrote a divergent row would silently undo whatever an
 * operator changed since the snapshot was taken — which is exactly the state
 * somebody is trying to understand when they reach for a restore.
 */
export const CATALOG_GOVERNANCE_RESTORE_OUTCOMES = ['create', 'present', 'divergent'] as const;
export type CatalogGovernanceRestoreOutcome =
  (typeof CATALOG_GOVERNANCE_RESTORE_OUTCOMES)[number];

/**
 * Things a governance surface may never do, named as VALUES so a census can
 * scan for them rather than a reviewer having to notice their absence. Disjoint
 * from every action tuple above, asserted by a test.
 *
 * The first three are the epic's own prohibitions. `merchant_publish` is the
 * one to read: it is unrepresentable because no merchant path can construct a
 * `CatalogGovernanceActor`, and naming it here is what makes a later reader ask
 * how, instead of adding a check that duplicates the guarantee badly.
 */
export const CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES = [
  'merchant_publish',
  'delete_definition',
  'rewrite_audit_history',
  'edit_applied_change_request',
  'self_approve_high_impact_change',
  'grant_operator_membership',
] as const;

export type CatalogGovernanceForbiddenCapability =
  (typeof CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES)[number];

/**
 * A pending item, whatever domain produced it. The point of one shape is that
 * an operator opening the desk sees translation staleness, unmapped external
 * tokens, unresolved compatibility claims, undecided proposals and unreviewed
 * attribute values in one ordering, rather than in five surfaces whose backlogs
 * only add up if somebody adds them up.
 */
export const CATALOG_GOVERNANCE_QUEUE_KINDS = [
  'pending_proposal',
  'stale_translation',
  'missing_translation',
  'unmapped_external_token',
  'open_external_mapping_review',
  'unresolved_compatibility_claim',
  'open_attribute_value_review',
  'unresolved_variant_axis_claim',
  'pending_change_request',
] as const;

export type CatalogGovernanceQueueKind = (typeof CATALOG_GOVERNANCE_QUEUE_KINDS)[number];

/**
 * A queue reading. `coverage` is the same honesty device the impact counters
 * use: a domain whose backlog cannot be measured on this deployment reports
 * `unmeasured` and carries no `total`, because a zero would read as "nothing to
 * do" on precisely the desk that exists to say what is left.
 */
export interface CatalogGovernanceQueueDepth {
  readonly kind: CatalogGovernanceQueueKind;
  readonly coverage: CatalogGovernanceImpactCoverage;
  /** Present exactly when `coverage` is `measured`. */
  readonly total?: number;
  /** Why it could not be measured. Present exactly when `coverage` is `unmeasured`. */
  readonly unmeasuredReason?: string;
}

/** One counted inbound reference, as it appears in an impact report. */
export interface CatalogGovernanceImpactCount {
  readonly referenceTable: string;
  readonly referenceColumn: string;
  readonly disposition: CatalogGovernanceReferenceDisposition;
  readonly rowCount: number;
}

/**
 * What an operator sees BEFORE a move, merge or deprecation.
 *
 * `relationsCounted` is the vacuity floor and is the number that matters: the
 * plan for a subject kind declares N inbound references, and an impact report
 * with fewer than N rows measured less than it claimed to. A report where every
 * count is zero is a legitimate answer — the floor is the ROW COUNT, not the
 * sum, precisely because a sum cannot tell an empty read from an empty result.
 */
export interface CatalogGovernanceImpactReport {
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly subjectId: string;
  readonly coverage: CatalogGovernanceImpactCoverage;
  readonly relationsDeclared: number;
  readonly relationsCounted: number;
  readonly counts: readonly CatalogGovernanceImpactCount[];
  readonly total: number;
  /**
   * The counted relations whose rows nothing in Mercaria will rewire. Non-empty
   * means an operator owes manual work after the change; it is surfaced rather
   * than folded into the total because the two lead to different decisions.
   */
  readonly rewirePathsMissing: readonly string[];
  readonly unmeasuredReason?: string;
}

/** One difference between two versions of a definition. */
export interface CatalogDefinitionDiffEntry {
  readonly change: 'added' | 'removed' | 'changed';
  /** The field or property key, stable across versions. */
  readonly key: string;
  /** The property that moved, for a `changed` entry. */
  readonly property?: string;
  readonly before?: string;
  readonly after?: string;
  /**
   * Whether this difference can invalidate data written under the older
   * version. A narrowed requirement, a removed field and a changed value policy
   * are breaking; a relabelled group is not.
   */
  readonly breaking: boolean;
}

/**
 * A version diff. `breakingCount` is derived from the entries rather than
 * counted separately, so the headline and the list cannot disagree.
 */
export interface CatalogDefinitionDiff {
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly entries: readonly CatalogDefinitionDiffEntry[];
  readonly breakingCount: number;
}

/** A governance change request, as the operator surface serves it. */
export interface CatalogGovernanceChangeRequest {
  readonly id: string;
  readonly domain: CatalogGovernanceDomain;
  readonly action: CatalogGovernanceAction;
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly subjectId: string;
  readonly state: CatalogGovernanceChangeState;
  readonly reason: string;
  readonly requestedByOxyUserId: string;
  readonly requestedAt: string;
  readonly requiresSecondApproval: boolean;
  readonly approvedByOxyUserId?: string;
  readonly approvedAt?: string;
  readonly appliedAt?: string;
  readonly failureDetail?: string;
  readonly impact: CatalogGovernanceImpactReport;
}

/** A role grant, as the operator surface serves it. */
export interface CatalogGovernanceRoleGrant {
  readonly id: string;
  readonly subjectOxyUserId: string;
  readonly role: CatalogGovernanceRole;
  readonly grantedByOxyUserId: string;
  readonly grantedAt: string;
  readonly reason: string;
  readonly revokedByOxyUserId?: string;
  readonly revokedAt?: string;
}

/** One audited act. `before`/`after` are immutable snapshots, never live reads. */
export interface CatalogGovernanceAuditEvent {
  readonly id: string;
  readonly domain: CatalogGovernanceDomain;
  readonly action: CatalogGovernanceAuditAction;
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly subjectId: string;
  readonly actorKind: CatalogGovernanceActorKind;
  readonly actorOxyUserId?: string;
  readonly reason: string;
  readonly source: CatalogGovernanceAuditSource;
  readonly changeRequestId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly at: string;
}

/**
 * Completeness by one dimension. The epic asks for metrics "by category, type,
 * locale and source"; `dimension` names which, and `key` is the stable id or
 * tag — never a translated label, which would make the same metric read
 * differently per request.
 */
export const CATALOG_GOVERNANCE_COMPLETENESS_DIMENSIONS = [
  'category',
  'product_type',
  'locale',
  'source',
] as const;

export type CatalogGovernanceCompletenessDimension =
  (typeof CATALOG_GOVERNANCE_COMPLETENESS_DIMENSIONS)[number];

/**
 * One completeness cell.
 *
 * `eligible` is the denominator and is reported even when it is zero, which is
 * the point: `complete = 0 / 0` is not 100%, and a dashboard that renders it as
 * one tells an operator a locale is finished when nothing was ever measured.
 * `ratio` is therefore absent when `eligible` is zero rather than defaulted.
 */
export interface CatalogGovernanceCompletenessCell {
  readonly dimension: CatalogGovernanceCompletenessDimension;
  readonly key: string;
  readonly eligible: number;
  readonly present: number;
  readonly stale: number;
  /** Absent exactly when `eligible` is zero. */
  readonly ratio?: number;
}

/** A duplicate-detection finding across governed definitions. */
export interface CatalogGovernanceDuplicateFinding {
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly detector: string;
  readonly normalizedValue: string;
  readonly subjectIds: readonly string[];
}

/**
 * A duplicate scan. `population` is the positive control: a detector that read
 * nothing reports zero findings, exactly like one that read everything and
 * found nothing clean.
 */
export interface CatalogGovernanceDuplicateScan {
  readonly population: number;
  readonly findings: readonly CatalogGovernanceDuplicateFinding[];
}

/** One entity a snapshot restore looked at. */
export interface CatalogGovernanceRestoreStep {
  readonly entity: string;
  readonly identity: string;
  readonly outcome: CatalogGovernanceRestoreOutcome;
  readonly detail?: string;
}

/** What a snapshot restore did, or would do when planned. */
export interface CatalogGovernanceRestoreReport {
  readonly snapshotId: string;
  readonly applied: boolean;
  readonly steps: readonly CatalogGovernanceRestoreStep[];
  readonly created: number;
  readonly present: number;
  readonly divergent: number;
}

/* -------------------------------------------------------------------------- */
/* The unresolved compatibility-claim queue (#367 Workstream 14)               */
/* -------------------------------------------------------------------------- */

/**
 * One unresolved claim, as an OPERATOR sees it.
 *
 * ## Why this lives here and not in `compatibility.ts`
 *
 * `COMPATIBILITY_FORBIDDEN_VIEW_FIELDS` forbids `rawTargetText`, `confidence`,
 * `claimId`, `sourceRecordId` and both `assertedBy*` ids from being DECLARED in
 * that module at all, gated statically and by a runtime walk of a real emitted
 * view. That gate is right and this view is the reason it has to be scoped: the
 * PUBLIC surface must never carry the source's own words, and the operator queue
 * exists precisely to show them. Somebody adjudicating "fits BMW 320d" needs the
 * eleven characters the supplier actually published, not a normalization of
 * them.
 *
 * So the prohibition keeps its full force where a shopper reads, and this type
 * sits in the operator module behind `CATALOG_OPERATOR_OXY_USER_IDS` — where
 * every other field an operator may see and a shopper may not already lives.
 * `catalog-governance-isolation.test.ts` asserts the public projection cannot
 * reach it.
 */
export interface CompatibilityClaimReviewView {
  readonly id: string;
  /** Exactly one is non-null; a claim naming no subject cannot be promoted. */
  readonly subjectProductId: string | null;
  readonly subjectVariantId: string | null;
  /** NULL on an automotive claim — the kind is decided by what it is promoted into. */
  readonly kind: string | null;
  /** The source's own words, verbatim and frozen by a trigger. The point of the queue. */
  readonly rawTargetText: string;
  readonly rawQualifierText: string | null;
  /** Why it could not be resolved. NOT NULL on an unresolved row, by CHECK. */
  readonly unresolvedReason: string | null;
  readonly assertedByKind: string;
  readonly assertedBySourceId: string | null;
  readonly sourceUrl: string | null;
  readonly observedAt: string;
  readonly confidence: number | null;
  readonly reviewedByOxyUserId: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
}

/** How many unresolved claims carry each reason. */
export interface CompatibilityClaimReasonCount {
  readonly reason: string;
  readonly count: number;
}

/**
 * The queue, with its own vacuity control.
 *
 * `examinedLimit` and `truncated` come from the bound the query was GIVEN rather
 * than from what survived it, so a full page and a page that happened to end at
 * the limit are distinguishable — `readCompatibilityRelationPage`'s rule, one
 * domain over. `byReason` is a breakdown over the WHOLE unresolved set and not
 * over the page, because an operator deciding what to work on next needs the
 * shape of the backlog rather than the shape of one screen.
 */
export interface CompatibilityClaimQueueView {
  readonly claims: readonly CompatibilityClaimReviewView[];
  readonly byReason: readonly CompatibilityClaimReasonCount[];
  readonly unreviewed: number;
  readonly examinedLimit: number;
  readonly truncated: boolean;
}

/**
 * Ten things that may never decide which vehicle a claim is promoted to, stated
 * as VALUES so a plausible future addition fails a scan rather than a review.
 *
 * ## The failure this exists for
 *
 * An ambiguous fitment resolved to the LIKELIEST vehicle. It is the false merge
 * #58 is shaped around, one domain over, and it is worse here: a wrong product
 * match shows somebody the wrong page, and a wrong fitment sells them a brake
 * pad that does not fit their car. It is discovered by the customer, and every
 * naive convenience on this list makes it likelier.
 *
 * `promoteCompatibilityClaimToFitment` takes the vehicle as REQUIRED input from
 * the operator and there is no shape in which it is optional or derived — which
 * is the structural half. This list is the half that stops the derivation being
 * added later under a helpful name, and it is scanned across BOTH the governance
 * domain and `services/compatibility/`. Three of them are already refused by an
 * existing wall (`RANKING_REFERENCE` forbids `search.service` under
 * `services/compatibility/`); the other seven were not refused anywhere.
 */
export const COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS: readonly string[] = [
  'likeliestVehicle',
  'guessVehicle',
  'inferVehicle',
  'bestMatchVehicle',
  'resolveClaimTargetAutomatically',
  'autoPromoteClaim',
  'suggestFitmentTarget',
  'rankVehicleCandidates',
  'fuzzyVehicleMatch',
  'vehicleFromRawText',
];
