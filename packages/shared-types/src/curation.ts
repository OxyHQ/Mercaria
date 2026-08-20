/**
 * Catalog curation — the review queue, the merge and split jobs, the
 * corrections and the audit timeline (issue #59, ADR 0002 D12/D16).
 *
 * This is the operator's half of the canonical commerce graph. #58 decides what
 * a matcher may do WITHOUT a person; this vocabulary describes what a person
 * does with everything the matcher refused, plus the corrections that no
 * automatic rule may make at all.
 *
 * ## The failure mode that shapes every tuple here
 *
 * A merge is the only operation in the graph that DESTROYS an identity, and the
 * damage is invisible: offers keep resolving, pages keep rendering, and the two
 * things that were quietly made one are discovered months later by a seller
 * whose sales landed on somebody else's product page. So every value set below
 * is closed, every high-impact action names a durable job with resumable
 * phases, and nothing that moves an entity is representable without an actor
 * and a reason.
 *
 * ## The three vocabularies, and why they are not one
 *
 * - {@link CURATION_SUBJECT_TYPES} — what a review ITEM can be about. The
 *   widest set: it includes rows that are not entities at all (an identifier
 *   assertion, a match decision, an observation).
 * - {@link MERGEABLE_ENTITY_TYPES} — what a MERGE can act on. A strict subset,
 *   and the subset relation is asserted rather than assumed
 *   ({@link isMergeableEntityType}), because a subject type that quietly became
 *   mergeable without a rehoming plan is the exact shape of a silent data loss.
 * - {@link SPLITTABLE_ENTITY_TYPES} — what a SPLIT can act on. Narrower still:
 *   only a product and a variant have children an operator can meaningfully
 *   reassign, and #59 names exactly those two.
 */

/**
 * Everything a review item may be ABOUT.
 *
 * Deliberately wider than the mergeable set: "this identifier assertion
 * conflicts" and "this match decision is ambiguous" are review work whose
 * subject is a row, not an entity, and forcing them onto an entity subject
 * would lose which of a product's twelve identifiers is actually disputed.
 */
export type CurationSubjectType =
  | 'organization'
  | 'brand'
  | 'merchant'
  | 'storefront'
  | 'canonical_product_family'
  | 'canonical_product'
  | 'canonical_variant'
  | 'product_identifier'
  | 'commerce_relationship'
  | 'source_record'
  | 'offer'
  | 'match_decision'
  | 'canonical_attribute_value';

export const CURATION_SUBJECT_TYPES: readonly CurationSubjectType[] = [
  'organization',
  'brand',
  'merchant',
  'storefront',
  'canonical_product_family',
  'canonical_product',
  'canonical_variant',
  'product_identifier',
  'commerce_relationship',
  'source_record',
  'offer',
  'match_decision',
  'canonical_attribute_value',
];

/**
 * The canonical entities a MERGE may act on (ADR 0002 D12/D16).
 *
 * Each one carries the tombstone shape — `status='merged'` plus
 * `merged_into_id` — so a merged row survives forever and its slug is never
 * reused. A type is on this list only when the backend declares a complete
 * rehoming plan for it, and that completeness is checked against the drizzle
 * schema rather than trusted (see `services/curation/merge-plan.ts`).
 */
export type MergeableEntityType = Extract<
  CurationSubjectType,
  | 'organization'
  | 'brand'
  | 'merchant'
  | 'storefront'
  | 'canonical_product_family'
  | 'canonical_product'
  | 'canonical_variant'
>;

export const MERGEABLE_ENTITY_TYPES: readonly MergeableEntityType[] = [
  'organization',
  'brand',
  'merchant',
  'storefront',
  'canonical_product_family',
  'canonical_product',
  'canonical_variant',
];

/**
 * The entities a SPLIT may act on (#59 split invariants).
 *
 * The issue names a product and a variant, and the narrowness is the point: a
 * split reassigns CHILDREN, and an organization or a brand has no children an
 * operator selects between — undoing a wrong brand merge is a merge reversal,
 * which is what the compensating correction is for.
 */
export type SplittableEntityType = Extract<
  MergeableEntityType,
  'canonical_product' | 'canonical_variant'
>;

export const SPLITTABLE_ENTITY_TYPES: readonly SplittableEntityType[] = [
  'canonical_product',
  'canonical_variant',
];

/** Whether a review subject is one a merge may act on. */
export function isMergeableEntityType(value: CurationSubjectType): value is MergeableEntityType {
  return (MERGEABLE_ENTITY_TYPES as readonly CurationSubjectType[]).includes(value);
}

/** Whether a mergeable entity is one a split may act on. */
export function isSplittableEntityType(value: MergeableEntityType): value is SplittableEntityType {
  return (SPLITTABLE_ENTITY_TYPES as readonly MergeableEntityType[]).includes(value);
}

// ── The review queue ────────────────────────────────────────────────────────

/**
 * The eight kinds of work the queue holds — exactly #59's list, in its order.
 *
 * They are KINDS of question rather than sources of signal, which is why
 * `ambiguous_match` covers both a matcher's `manual_review` outcome and an
 * operator's own doubt: a queue keyed on which detector spoke would show one
 * problem twice the moment two detectors noticed it.
 */
export type CurationReviewKind =
  /** A match the pipeline refused to make automatically (#58 `manual_review`). */
  | 'ambiguous_match'
  /** Two entities asserting one valid identifier (ADR 0002 D14's collision gate). */
  | 'identifier_conflict'
  /** Two brands, merchants, organizations or storefronts that may be one thing. */
  | 'entity_collision'
  /** An unverified `commerce_relationships` claim awaiting evidence review (#55). */
  | 'relationship_candidate'
  /** Sources disagreeing about a canonical field, with no value selected (#94). */
  | 'source_fact_disagreement'
  /** Two canonical products or variants that may be duplicates. */
  | 'suspected_duplicate'
  /** An observation or offer attached to nothing a buyer can reach. */
  | 'orphaned_record'
  /** Outcomes that moved the wrong way after a matching-policy change (#58). */
  | 'policy_regression';

export const CURATION_REVIEW_KINDS: readonly CurationReviewKind[] = [
  'ambiguous_match',
  'identifier_conflict',
  'entity_collision',
  'relationship_candidate',
  'source_fact_disagreement',
  'suspected_duplicate',
  'orphaned_record',
  'policy_regression',
];

/**
 * The kinds whose statement is about a PAIR.
 *
 * "These two are duplicates" and "these two claim one GTIN" are propositions
 * about two rows; a queue item that could hold only one of them would be
 * unactionable. The backend turns this into a CHECK, so a pair-shaped item with
 * no counterpart cannot be stored.
 */
export const CURATION_PAIRED_REVIEW_KINDS: readonly CurationReviewKind[] = [
  'identifier_conflict',
  'entity_collision',
  'suspected_duplicate',
];

/** Whether a review kind requires a counterpart subject. */
export function reviewKindRequiresCounterpart(kind: CurationReviewKind): boolean {
  return CURATION_PAIRED_REVIEW_KINDS.includes(kind);
}

/**
 * Where a queue item came from.
 *
 * Recorded because "why is this in my inbox" is the first question an operator
 * asks, and because a detector that starts producing noise has to be
 * identifiable without re-deriving every item in the queue.
 */
export type CurationDetector =
  | 'match_pipeline'
  | 'identifier_collision_gate'
  | 'duplicate_scan'
  | 'relationship_intake'
  | 'attribute_conflict_scan'
  | 'orphan_scan'
  | 'policy_regression_scan'
  | 'operator'
  /**
   * A reader disputed a published catalogue fact from a public page (#72
   * identity rule 2).
   *
   * Its own member rather than `operator`, because the two lead a reviewer to
   * opposite conclusions: an `operator` item is somebody inside Mercaria
   * referring work they have already looked at, and this is somebody outside
   * saying a page is wrong. Merging them would make a queue full of public
   * disputes read as a queue full of internal referrals.
   *
   * The item records the DISPUTE and never the disputer — there is no column
   * for one here, deliberately, so submitting a correction confers no standing
   * (#72 identity rule 1).
   */
  | 'public_correction';

export const CURATION_DETECTORS: readonly CurationDetector[] = [
  'match_pipeline',
  'identifier_collision_gate',
  'duplicate_scan',
  'relationship_intake',
  'attribute_conflict_scan',
  'orphan_scan',
  'policy_regression_scan',
  'operator',
  'public_correction',
];

/**
 * The queue item's lifecycle.
 *
 * `in_review` exists so two operators do not both start the same merge — an
 * assignment is a claim, not a label. `dismissed` and `resolved` are different
 * facts: one says the queue was wrong to raise it, the other says a person
 * changed the graph.
 */
export type CurationReviewState = 'open' | 'in_review' | 'resolved' | 'dismissed';

export const CURATION_REVIEW_STATES: readonly CurationReviewState[] = [
  'open',
  'in_review',
  'resolved',
  'dismissed',
];

/** The states in which an item is still WORK — the convergence window. */
export const CURATION_ACTIVE_REVIEW_STATES: readonly CurationReviewState[] = ['open', 'in_review'];

/**
 * The bounded reasons a detector may state.
 *
 * `text[]` with an element CHECK rather than free text, the `MATCH_REASON_CODES`
 * precedent: a reviewer filtering "show me every brand disagreement" needs an
 * indexable predicate, and a sentence is not one.
 */
export type CurationReasonCode =
  | 'ambiguous_candidates'
  | 'conflicting_identifier'
  | 'brand_disagreement'
  | 'no_deterministic_support'
  | 'normalized_name_collision'
  | 'shared_domain'
  | 'shared_identifier'
  | 'variant_signature_collision'
  | 'awaiting_evidence'
  | 'insufficient_evidence'
  | 'sources_disagree'
  | 'no_selected_value'
  | 'unattached_source_record'
  | 'unattached_offer'
  | 'lost_automatic_match'
  | 'gained_blocker'
  | 'operator_referred'
  /**
   * A reader disputed a published fact from a public catalogue page (#72
   * identity rule 2), through `POST /catalog-pages/corrections`.
   *
   * ONE code rather than one per disputed FIELD, and the reason is a property
   * of this table: an item converges on `dedupe_key`, which is grained per
   * SUBJECT, and the conflict branch REPLACES `reason_codes`. Per-field codes
   * would therefore drop whichever field was reported first the moment a second
   * reader reported another one — worse than not recording it, because the item
   * would look precise while being wrong. The first submission's field reaches
   * the `note` (which the conflict branch leaves alone) and `detection_count`
   * carries the volume; per-field fidelity needs a column this table does not
   * have, and adding one is #59's decision, not #72's.
   */
  | 'public_correction_submitted';

export const CURATION_REASON_CODES: readonly CurationReasonCode[] = [
  'ambiguous_candidates',
  'conflicting_identifier',
  'brand_disagreement',
  'no_deterministic_support',
  'normalized_name_collision',
  'shared_domain',
  'shared_identifier',
  'variant_signature_collision',
  'awaiting_evidence',
  'insufficient_evidence',
  'sources_disagree',
  'no_selected_value',
  'unattached_source_record',
  'unattached_offer',
  'lost_automatic_match',
  'gained_blocker',
  'operator_referred',
  'public_correction_submitted',
];

/**
 * How an item left the queue — #59's ten operator actions, plus the two ways an
 * item can close without one.
 *
 * `no_action_needed` and `not_reproducible` are deliberately different: the
 * first says a person looked and the graph was already right, the second says
 * the condition had gone by the time anybody looked. A detector producing many
 * of the second is measurably noisy; one producing many of the first is
 * measurably wrong.
 */
export type CurationResolution =
  | 'matched_to_entity'
  | 'created_entity'
  | 'rejected_candidate'
  | 'merged'
  | 'split'
  | 'reassigned_identifier'
  | 'corrected_value'
  | 'relationship_decided'
  | 'suppressed'
  | 'compensated'
  | 'no_action_needed'
  | 'not_reproducible';

export const CURATION_RESOLUTIONS: readonly CurationResolution[] = [
  'matched_to_entity',
  'created_entity',
  'rejected_candidate',
  'merged',
  'split',
  'reassigned_identifier',
  'corrected_value',
  'relationship_decided',
  'suppressed',
  'compensated',
  'no_action_needed',
  'not_reproducible',
];

/** The resolutions that close an item WITHOUT a graph change. */
export const CURATION_DISMISSAL_RESOLUTIONS: readonly CurationResolution[] = [
  'no_action_needed',
  'not_reproducible',
];

// ── The audit timeline ──────────────────────────────────────────────────────

/**
 * Every action that appears in `catalog_revisions` (#59 acceptance 4).
 *
 * ADR 0002 D16 specifies eight — create, update, merge, split, correct, verify,
 * revoke, redirect. The six additions are #59's own operator actions, each
 * naming an act D16's list could only have recorded as an unqualified `update`:
 * an identifier reassignment, a rejection that persists a blocked pair, a
 * suppression and its lift, a source attachment, and the compensating
 * correction that undoes a reversible action. Collapsing them into `update`
 * would make the timeline unreadable for exactly the questions it exists to
 * answer.
 */
export type CatalogRevisionAction =
  | 'create'
  | 'update'
  | 'merge'
  | 'split'
  | 'correct'
  | 'verify'
  | 'revoke'
  | 'redirect'
  | 'link_source'
  | 'reject_candidate'
  | 'reassign_identifier'
  | 'suppress'
  | 'unsuppress'
  | 'compensate';

export const CATALOG_REVISION_ACTIONS: readonly CatalogRevisionAction[] = [
  'create',
  'update',
  'merge',
  'split',
  'correct',
  'verify',
  'revoke',
  'redirect',
  'link_source',
  'reject_candidate',
  'reassign_identifier',
  'suppress',
  'unsuppress',
  'compensate',
];

/**
 * Who acted (ADR 0002 D16).
 *
 * An operator revision must name a person; the other two must not, because an
 * `oxy_user_id` on an ingestion row would read as somebody having decided
 * something a feed asserted. Both directions are a CHECK.
 */
export type CatalogRevisionActorKind = 'operator' | 'ingestion' | 'backfill';

export const CATALOG_REVISION_ACTOR_KINDS: readonly CatalogRevisionActorKind[] = [
  'operator',
  'ingestion',
  'backfill',
];

/**
 * The actions whose damage is wide enough to require a second operator when
 * four-eyes review is on (#59 security 4).
 *
 * The issue names "official relationships and large merges". Relationship
 * verification already has its own four-eyes device (`relationship_reviews`,
 * #55) and is deliberately NOT duplicated here; what this list adds is the
 * merge, whose size is measured rather than assumed — see
 * `CURATION_LARGE_MERGE_IMPACT_THRESHOLD`.
 */
export const CURATION_SECOND_APPROVAL_ACTIONS: readonly CatalogRevisionAction[] = ['merge', 'split'];

/**
 * The impact above which a merge or split is "large" and needs a second pair of
 * eyes when four-eyes review is on.
 *
 * A number rather than a judgement, so the same merge is treated the same way
 * whoever proposes it. It counts the rows the job would MOVE — the estimate the
 * operator was shown — because that is what a mistake would have to be undone
 * one by one.
 */
export const CURATION_LARGE_MERGE_IMPACT_THRESHOLD = 100;

// ── Merge jobs ─────────────────────────────────────────────────────────────

/**
 * The ordered phases of a merge (#59 merge invariant 7).
 *
 * The order is not arbitrary and re-ordering it breaks correctness:
 *
 * 1. `plan` measures the impact and DETECTS every conflict before a single row
 *    moves, so an operator sees the size of what they are about to do.
 * 2. `awaiting_resolution` is where invariant 4 lives — the job cannot advance
 *    while any conflict lacks an explicit decision.
 * 3. `children` moves child ENTITIES (a family's products, a product's
 *    variants, a merchant's storefronts) first, because everything after this
 *    point repoints rows that hang off them.
 * 4. `identifiers` before `aliases` and `source_links`, because identifier
 *    resolution can RETIRE a row and the retirement must land before the
 *    collision gate sees two active owners.
 * 5. `saves` moves what a PERSON recorded about the entity (#80's canonical
 *    product saves). It sits after `reviews` and before `redirects` for the
 *    reason every phase after `children` does — the rows hang off identities
 *    the earlier phases settled — and it is its own phase rather than a line in
 *    `reviews` because a save is a live preference a buyer will act on, not a
 *    historical record, and an operator reading a phase trail has to be able to
 *    tell which of the two a job was in the middle of.
 * 6. `redirects` stamps the tombstone LAST of the mutating phases: until it
 *    runs, the loser is still a live entity and a crash leaves a resumable job
 *    rather than a half-dead identity nothing points at.
 * 7. `rollups` rebuilds counters FROM the rehomed rows (invariant 6), which is
 *    why it cannot precede them.
 * 8. `verify` is the final consistency check invariant 7 requires, and it is a
 *    phase rather than an assertion so its failure is visible and resumable.
 */
export type CatalogMergePhase =
  | 'plan'
  | 'awaiting_resolution'
  | 'children'
  | 'identifiers'
  | 'aliases'
  | 'source_links'
  | 'offers'
  | 'relationships'
  | 'reviews'
  | 'saves'
  | 'alerts'
  | 'agents'
  | 'redirects'
  | 'rollups'
  | 'verify'
  | 'done';

export const CATALOG_MERGE_PHASES: readonly CatalogMergePhase[] = [
  'plan',
  'awaiting_resolution',
  'children',
  'identifiers',
  'aliases',
  'source_links',
  'offers',
  'relationships',
  'reviews',
  'saves',
  // #79's price alerts. An ordinary rehoming phase like `saves` and not bespoke
  // logic: the columns it moves are declared in `merge-plan.ts` like every
  // other, so the census still forces a decision when a new one appears. It
  // runs AFTER `saves` because the two are independent and the order of two
  // independent phases has to be SOME order — and before `rollups`, because
  // nothing a counter derives from moves here.
  'alerts',
  // #97's saved shopping agents. A third rehoming phase beside `saves` and
  // `alerts` rather than a line inside either, for #80's reason: an operator
  // reading a phase trail has to be able to tell which of the three a job was
  // in the middle of, and an agent is a live standing instruction where a save
  // is a preference and an alert is one condition. It runs after `alerts`
  // because the three are independent and independence still needs SOME order,
  // and before `rollups`, because nothing a counter derives from moves here.
  'agents',
  'redirects',
  'rollups',
  'verify',
  'done',
];

/** The next phase after `phase`, or `null` when the job is finished. */
export function nextMergePhase(phase: CatalogMergePhase): CatalogMergePhase | null {
  const index = CATALOG_MERGE_PHASES.indexOf(phase);
  return CATALOG_MERGE_PHASES[index + 1] ?? null;
}

/**
 * The ordered phases of a split.
 *
 * `mint` creates or REVIVES the destination before anything is reassigned, so
 * an interrupted split never has rows pointing at an entity that does not
 * exist; `assignments` applies exactly the operator's list (invariant 1) and is
 * idempotent per item, which is what makes invariant 5's resume safe.
 *
 * `saves` is #80 migration rule 8 and split invariant 3: a split divides one
 * identity into two, and no rule can say which of them a person's saved product
 * meant — so every save of the source is MARKED for the buyer to resolve. It
 * runs after `assignments` because the two candidates only both exist and only
 * hold their final contents once the named rows have moved, and before
 * `rollups` because the marking changes nothing a counter derives from. The
 * marking is an UPDATE with its own predicate, so a resumed job re-runs it as a
 * no-op.
 *
 * `alerts` is #79 evaluation 9 and is the same shape for the same reason, with
 * one thing more: an ambiguous ALERT is also PAUSED, because a save sitting on
 * the wrong side of a split shows a buyer the wrong page while an alert on the
 * wrong side would actively notify them about a product they may not have
 * meant. Deterministic migration was refused here exactly as it was there.
 */
export type CatalogSplitPhase =
  | 'plan'
  | 'mint'
  | 'assignments'
  | 'saves'
  | 'alerts'
  | 'agents'
  | 'redirects'
  | 'rollups'
  | 'verify'
  | 'done';

export const CATALOG_SPLIT_PHASES: readonly CatalogSplitPhase[] = [
  'plan',
  'mint',
  'assignments',
  'saves',
  'alerts',
  // #97, and the strongest form of the same refusal: an ambiguous SAVE shows a
  // shopper the wrong page, an ambiguous ALERT actively notifies them about a
  // product they may not have meant, and an ambiguous AGENT goes on doing that
  // on its own schedule for as long as nobody looks. So a split BLOCKS every
  // agent of the source and never picks a side.
  'agents',
  'redirects',
  'rollups',
  'verify',
  'done',
];

/** The next phase after `phase`, or `null` when the job is finished. */
export function nextSplitPhase(phase: CatalogSplitPhase): CatalogSplitPhase | null {
  const index = CATALOG_SPLIT_PHASES.indexOf(phase);
  return CATALOG_SPLIT_PHASES[index + 1] ?? null;
}

/**
 * The lifecycle of a curation job.
 *
 * `blocked` is separate from `failed` on purpose: a job waiting on an operator
 * to resolve a conflict is not an error and must not be retried, while a job
 * that threw is and must. Collapsing them would either spin the dispatcher
 * against a decision only a person can make, or bury a real fault in a queue of
 * things "waiting for review".
 */
export type CatalogJobStatus =
  | 'pending'
  | 'processing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

export const CATALOG_JOB_STATUSES: readonly CatalogJobStatus[] = [
  'pending',
  'processing',
  'blocked',
  'completed',
  'failed',
  'dead_letter',
  'cancelled',
];

/** The statuses a dispatcher may claim. */
export const CATALOG_JOB_CLAIMABLE_STATUSES: readonly CatalogJobStatus[] = ['pending', 'processing'];

/**
 * A collision the database would refuse, which an operator must decide BEFORE
 * the merge commits (#59 merge invariant 4).
 *
 * Every member names a real constraint in this schema, and that is the test of
 * whether a kind belongs here: a "conflict" with no constraint behind it is a
 * warning, and warnings do not block.
 *
 * - `identifier` — `product_identifiers_canonical_active_key`, ADR 0002 D14's
 *   one-active-owner-per-GTIN gate.
 * - `variant_signature` — `canonical_variants_product_signature_key`.
 * - `default_variant` — `canonical_variants_product_default_key`.
 * - `relationship_endpoint` — `commerce_relationships_open_claim_key`.
 * - `active_offer` — `offers_active_commercial_key`.
 * - `verified_claim` — `merchant_claims`' `(merchant_id) WHERE state='verified'`
 *   partial unique (#83 acceptance 4). It is a SEPARATE kind rather than a
 *   relationship one because what it decides is who may OPERATE the surviving
 *   merchant, which is an access decision and not a graph edge.
 * - `compatibility_endpoint_collapse` —
 *   `generic_compatibility_relations_distinct_endpoints_check` (#405).
 * - `bundle_self_containment` — `bundle_components_self_check` (#405). Its
 *   remedy is a THIRD one again: the table has no state short of existing, so
 *   the component is removed through the catalogue's own writer and this records
 *   that it was — curation itself deletes nothing.
 * - `redirect_endpoint_collapse` — `canonical_product_redirects_self_check` and
 *   `canonical_family_redirects_self_check` (#405). ONE kind for two tables
 *   because it is one constraint written twice over the same shape, and the
 *   conflict names whichever row it is about.
 *
 * ## The collapse kinds are ONE row, and that is why they are separate members
 *
 * The six kinds above are all PAIR collisions: two legal rows that become one
 * illegal key, where an operator picks a survivor and the other is retired in
 * its own domain's terms. `catalog_merge_conflicts_pair_shape_check` requires
 * BOTH sides to be NOT NULL for every one of them, which is that shape stated
 * once.
 *
 * A COLLAPSE is not that. One row names the losing entity on BOTH of its ends —
 * or on one end with the winner on the other — and rehoming makes the two equal,
 * which a distinct-endpoints CHECK refuses with `23514`. There is no winner
 * counterpart to point at and nothing to choose between, so `keep_winner` and
 * `keep_loser` have no referent here and are refused by a CHECK rather than
 * reinterpreted per kind. It is also why `absenceGuard` cannot express the case:
 * that guard hunts a COLLIDING WINNER ROW, and in a collapse none exists.
 *
 * A SLUG collision is deliberately absent. Slugs are unique forever and a
 * tombstone keeps its own (D12), so a merge never contends for one: the loser
 * keeps its slug and its old URL resolves through the redirect, which is
 * invariant 5 satisfied by the identity model rather than by a decision.
 */
export type CatalogMergeConflictKind =
  | 'identifier'
  | 'variant_signature'
  | 'default_variant'
  | 'relationship_endpoint'
  | 'active_offer'
  | 'verified_claim'
  | 'compatibility_endpoint_collapse'
  | 'redirect_endpoint_collapse'
  | 'bundle_self_containment'
  | 'entity_suppressed';

export const CATALOG_MERGE_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'identifier',
  'variant_signature',
  'default_variant',
  'relationship_endpoint',
  'active_offer',
  'verified_claim',
  'compatibility_endpoint_collapse',
  'redirect_endpoint_collapse',
  'bundle_self_containment',
  'entity_suppressed',
];

/**
 * How an operator resolved one conflict.
 *
 * `keep_winner` and `keep_loser` name which of the two colliding rows stays
 * ACTIVE; the other is retired, superseded or closed in its own domain's terms,
 * and never deleted.
 *
 * `merge_pair` is the only resolution for a `variant_signature` conflict and is
 * refused for every other kind, because keeping one of two variants that carry
 * the same option assignments would silently strand the loser's offers on a row
 * nothing links to. It opens a CHILD merge job for the two variants, which the
 * parent's `children` phase waits on.
 *
 * `suppression_cleared` is `drop_component`'s device one domain over (#694): it
 * does not mean "proceed anyway", it means an operator has ALREADY lifted the
 * suppression, or already suppressed the other side, in the suppression domain
 * where that act belongs. `resolveMergeConflict` refuses to record it while an
 * open suppression still stands on either side, so a decision whose act has not
 * happened can never unblock the job.
 *
 * `close_relation` and `retain_history` are the COLLAPSE resolutions, and reusing
 * `keep_winner` for it was refused deliberately. That word is defined two lines
 * above as "which of the two colliding rows stays ACTIVE", and a collapse has
 * one row; making it mean something else for one kind would put the difference
 * in a `switch` an operator never sees, in a vocabulary frozen into a CHECK
 * where correcting it costs a migration. It CLOSES the relation — `valid_to`,
 * plus the revocation attribution `generic_compatibility_relations_revoked_state_check`
 * demands — and the merge then leaves the closed row on the tombstone, because
 * the row it would move is the row the CHECK refuses.
 */
export type CatalogMergeConflictResolution =
  | 'keep_winner'
  | 'keep_loser'
  | 'merge_pair'
  | 'close_relation'
  | 'retain_history'
  | 'drop_component'
  | 'suppression_cleared';

export const CATALOG_MERGE_CONFLICT_RESOLUTIONS: readonly CatalogMergeConflictResolution[] = [
  'keep_winner',
  'keep_loser',
  'merge_pair',
  'close_relation',
  'retain_history',
  'drop_component',
  'suppression_cleared',
];

/** The conflict kinds `merge_pair` is a legal resolution for. */
export const CATALOG_MERGE_PAIR_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'variant_signature',
];

/**
 * The conflict kinds that name ONE row rather than a colliding pair, and the
 * only kinds `close_relation` is a legal resolution for (#405).
 *
 * Two CHECKs read this tuple and neither implies the other: one refuses
 * `close_relation` on a pair kind, the other refuses `keep_winner`/`keep_loser`
 * on a collapse kind. Without the second, an operator could "keep the winner" of
 * a conflict that has no winner row, and the applier would look up a column the
 * shape CHECK guarantees is NULL — a resolution that records a decision and
 * changes nothing, after which the merge proceeds into the same `23514`.
 */
export const CATALOG_MERGE_COLLAPSE_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'compatibility_endpoint_collapse',
  'redirect_endpoint_collapse',
  'bundle_self_containment',
];

/** The resolutions a collapse kind admits. Disjoint from the pair ones. */
export const CATALOG_MERGE_COLLAPSE_RESOLUTIONS: readonly CatalogMergeConflictResolution[] = [
  'close_relation',
  'retain_history',
  'drop_component',
];

/**
 * And which collapse kind admits which, because they are NOT interchangeable.
 *
 * An OPEN compatibility relation left on a tombstone is a live claim about a
 * dead identity, so it must be CLOSED. A redirect naming the winner and the
 * loser is TRUE HISTORY — the winner really did once redirect there, which is
 * reachable because #59 acceptance 2 revives a tombstone and leaves its redirect
 * rows standing — so the row stays and the operator's decision is RECORDED
 * rather than executed. Offering either resolution for the other's kind would
 * mean revoking a historical fact, or "closing" a table with no state to close.
 */
export const CATALOG_MERGE_CLOSE_RELATION_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'compatibility_endpoint_collapse',
];

export const CATALOG_MERGE_RETAIN_HISTORY_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'redirect_endpoint_collapse',
];

/**
 * `drop_component` RECORDS that the operator already removed the component, in
 * the catalogue, before deciding. It never performs the removal.
 *
 * `bundle_components` has no `valid_to`, no status and both columns NOT NULL, so
 * the only way one of its rows stops being current is that it stops existing —
 * and `curation-isolation.test.ts` fails the build on a delete anywhere in this
 * domain, correctly: a merge leaves a tombstone, a suppression hides, a
 * correction appends. So the ACT belongs to the catalogue's own writer and the
 * DECISION belongs here, and `resolveMergeConflict` refuses the decision while
 * the row is still there rather than taking it on trust — which is also what
 * keeps the job out of a state nothing can unblock, since a job leaves `blocked`
 * only when a resolution is accepted.
 */
export const CATALOG_MERGE_DROP_COMPONENT_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'bundle_self_containment',
];

/**
 * `entity_suppressed` is the FIRST kind that names no database constraint, and
 * the first that applies to EVERY mergeable entity type (#694).
 *
 * `docs/curation.md` used to test membership here by asking whether a kind names
 * a real constraint — "a conflict with no constraint behind it is a warning, and
 * warnings do not block". Nothing in this schema refuses a merge of a suppressed
 * entity; that absence IS the bug. The rule was written to exclude WARNINGS, and
 * a suppression is not one: proceeding destroys a decision a person made, which
 * is the property the constraint test was a proxy for. **The amended test is
 * whether proceeding destroys something somebody decided.** The doc carries the
 * amendment and names this case.
 *
 * A trigger refusing the tombstone stamp was considered — it would have given
 * this kind a constraint to name — and rejected: it raises MID-MERGE, aborting
 * the phase transaction, so the job FAILS and retries on the backoff ladder
 * instead of parking with a reason. A blocked job an operator can read beats a
 * raised constraint the dispatcher has to interpret.
 *
 * It is neither a PAIR kind nor a COLLAPSE kind — a third shape, naming one
 * suppression row and no catalogue row at all, which is why it carries its own
 * biconditional rather than a branch in either shape CHECK.
 */
export const CATALOG_MERGE_SUPPRESSION_CONFLICT_KINDS: readonly CatalogMergeConflictKind[] = [
  'entity_suppressed',
];

// ── Split jobs ─────────────────────────────────────────────────────────────

/**
 * Where the split's destination comes from.
 *
 * `revive_tombstone` is what makes #59 acceptance 2 work: undoing a mistaken
 * merge must give the losing entity its OWN id, slug and URL back, not a new
 * one — every source mapping that ever pointed at it, and every price
 * observation recorded against its offers, is keyed on that id. Minting a fresh
 * entity would satisfy the words "split" and lose exactly what the acceptance
 * criterion protects.
 */
export type CatalogSplitTargetMode = 'revive_tombstone' | 'new_entity';

export const CATALOG_SPLIT_TARGET_MODES: readonly CatalogSplitTargetMode[] = [
  'revive_tombstone',
  'new_entity',
];

/**
 * What a split may reassign (#59 split invariant 1).
 *
 * The list is exhaustive over the rows that HANG OFF a canonical product or
 * variant, so "exactly which things move" is answerable by reading the
 * assignment rows and nothing else. A child not named in an assignment stays
 * where it is — silence is never a move.
 */
export type CatalogSplitItemType =
  | 'canonical_variant'
  | 'product_identifier'
  | 'source_link'
  | 'offer'
  | 'native_listing_link'
  | 'alias'
  | 'attribute_value'
  | 'image';

export const CATALOG_SPLIT_ITEM_TYPES: readonly CatalogSplitItemType[] = [
  'canonical_variant',
  'product_identifier',
  'source_link',
  'offer',
  'native_listing_link',
  'alias',
  'attribute_value',
  'image',
];

/**
 * Which item types are assignable per splittable entity — a TABLE rather than a
 * switch, the `claim-methods.ts` device.
 *
 * Splitting a PRODUCT moves whole variants and the product-grain rows; it never
 * moves an individual offer, because an offer names a variant and follows it.
 * Splitting a VARIANT is the opposite: there are no child variants, and the
 * offers and native links attached to it are exactly what has to be divided.
 */
export const CATALOG_SPLIT_ITEM_TYPES_BY_ENTITY: Readonly<
  Record<SplittableEntityType, readonly CatalogSplitItemType[]>
> = {
  canonical_product: [
    'canonical_variant',
    'product_identifier',
    'source_link',
    'alias',
    'attribute_value',
    'image',
  ],
  canonical_variant: [
    'product_identifier',
    'source_link',
    'offer',
    'native_listing_link',
    'alias',
    'attribute_value',
    'image',
  ],
};

// ── Suppression ────────────────────────────────────────────────────────────

/**
 * What a suppression hides (#59 operator action 9).
 *
 * ONE scope today, and naming it is what stops "suppressed" quietly widening
 * into "deleted": a suppression removes an entity from public DISCOVERY and
 * touches no evidence, no offer history and no placed order.
 */
export type CatalogSuppressionScope = 'public_discovery';

export const CATALOG_SUPPRESSION_SCOPES: readonly CatalogSuppressionScope[] = ['public_discovery'];

/** Why an entity or offer was hidden. Closed, so a suppression is auditable. */
export type CatalogSuppressionReason =
  | 'suspected_duplicate'
  | 'unverified_claim'
  | 'data_quality'
  | 'legal_request'
  | 'pending_investigation';

export const CATALOG_SUPPRESSION_REASONS: readonly CatalogSuppressionReason[] = [
  'suspected_duplicate',
  'unverified_claim',
  'data_quality',
  'legal_request',
  'pending_investigation',
];

/** What a suppression may be applied to: a mergeable entity, or one offer. */
export type CatalogSuppressibleType = MergeableEntityType | 'offer';

export const CATALOG_SUPPRESSIBLE_TYPES: readonly CatalogSuppressibleType[] = [
  ...MERGEABLE_ENTITY_TYPES,
  'offer',
];

// ── Projections ────────────────────────────────────────────────────────────

/** A reference to one curated row: its type and its id, never a bare id. */
export interface CurationSubjectRef {
  readonly type: CurationSubjectType;
  readonly id: string;
}

/**
 * The downstream impact of an action, as it was ESTIMATED before the action ran
 * (#59 security 2).
 *
 * Typed counts rather than a `jsonb` bag, the `provider_accounts`
 * requirements-count reasoning: an operator confirming a merge needs to compare
 * numbers, and a number is not a sentence. Every field counts rows that WOULD
 * MOVE, so a zero is meaningful — it says the entity is unattached, which is
 * the safest merge there is.
 */
export interface CatalogImpactEstimate {
  readonly sourceLinks: number;
  readonly identifiers: number;
  readonly aliases: number;
  readonly offers: number;
  readonly nativeListingLinks: number;
  readonly relationships: number;
  readonly reviews: number;
  readonly childEntities: number;
  readonly attributeValues: number;
  readonly images: number;
  /**
   * Rows a merge would leave ALONE and a reader might expect it to touch —
   * placed order lines referencing the entity's native listings.
   *
   * It is reported precisely because it is untouched (#59 merge invariant 3):
   * an operator seeing "12 order lines" beside "0 will move" learns that a
   * merge cannot disturb somebody's purchase history, which is the reassurance
   * the invariant exists to give.
   */
  readonly untouchedOrderItems: number;
  /** The sum of the moving counts — what the four-eyes threshold compares. */
  readonly totalMoving: number;
}

/** The zero estimate. Used as the identity when summing per-table counts. */
export const EMPTY_CATALOG_IMPACT: CatalogImpactEstimate = {
  sourceLinks: 0,
  identifiers: 0,
  aliases: 0,
  offers: 0,
  nativeListingLinks: 0,
  relationships: 0,
  reviews: 0,
  childEntities: 0,
  attributeValues: 0,
  images: 0,
  untouchedOrderItems: 0,
  totalMoving: 0,
};

/**
 * Sum the moving counts of an estimate.
 *
 * `untouchedOrderItems` is deliberately excluded: it counts rows the job does
 * not touch, and including it would make a merge look large because the seller
 * has sold things.
 */
export function totalMovingImpact(
  estimate: Omit<CatalogImpactEstimate, 'totalMoving' | 'untouchedOrderItems'>,
): number {
  return (
    estimate.sourceLinks +
    estimate.identifiers +
    estimate.aliases +
    estimate.offers +
    estimate.nativeListingLinks +
    estimate.relationships +
    estimate.reviews +
    estimate.childEntities +
    estimate.attributeValues +
    estimate.images
  );
}

/** Whether an action of this size needs a second operator's approval. */
export function requiresSecondApproval(
  action: CatalogRevisionAction,
  totalMoving: number,
  fourEyesRequired: boolean,
): boolean {
  if (!fourEyesRequired) return false;
  if (!CURATION_SECOND_APPROVAL_ACTIONS.includes(action)) return false;
  return totalMoving >= CURATION_LARGE_MERGE_IMPACT_THRESHOLD;
}

/** One row of the queue, as the operator surface projects it. */
export interface CurationReviewItemDTO {
  readonly id: string;
  readonly kind: CurationReviewKind;
  readonly detector: CurationDetector;
  readonly subject: CurationSubjectRef;
  readonly counterpart: CurationSubjectRef | null;
  readonly reasonCodes: readonly CurationReasonCode[];
  readonly confidence: number | null;
  readonly state: CurationReviewState;
  readonly assignedToOxyUserId: string | null;
  readonly resolution: CurationResolution | null;
  readonly resolutionReason: string | null;
  readonly resolvedByOxyUserId: string | null;
  readonly resolvedAt: string | null;
  readonly detectionCount: number;
  readonly firstDetectedAt: string;
  readonly lastDetectedAt: string;
  readonly matchDecisionId: string | null;
  readonly policyVersionId: string | null;
  readonly note: string | null;
}

/** One audit row, as the timeline projects it. */
export interface CatalogRevisionDTO {
  readonly id: string;
  readonly entityType: CurationSubjectType;
  readonly entityId: string;
  readonly action: CatalogRevisionAction;
  readonly actorKind: CatalogRevisionActorKind;
  readonly actorOxyUserId: string | null;
  readonly reason: string;
  readonly note: string | null;
  readonly sourceRecordId: string | null;
  readonly policyVersionId: string | null;
  readonly mergeJobId: string | null;
  readonly splitJobId: string | null;
  readonly reviewItemId: string | null;
  readonly compensatesRevisionId: string | null;
  readonly createdAt: string;
}

/** One merge job, as the operator surface projects it. */
export interface CatalogMergeJobDTO {
  readonly id: string;
  readonly entityType: MergeableEntityType;
  readonly loserId: string;
  readonly winnerId: string;
  readonly status: CatalogJobStatus;
  readonly phase: CatalogMergePhase;
  readonly attempts: number;
  readonly reason: string;
  readonly requestedByOxyUserId: string;
  readonly approvedByOxyUserId: string | null;
  readonly parentJobId: string | null;
  readonly impact: CatalogImpactEstimate;
  readonly completedPhases: readonly CatalogMergePhase[];
  readonly unresolvedConflicts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** One split job, as the operator surface projects it. */
export interface CatalogSplitJobDTO {
  readonly id: string;
  readonly entityType: SplittableEntityType;
  readonly sourceEntityId: string;
  readonly targetMode: CatalogSplitTargetMode;
  readonly targetEntityId: string | null;
  readonly status: CatalogJobStatus;
  readonly phase: CatalogSplitPhase;
  readonly attempts: number;
  readonly reason: string;
  readonly requestedByOxyUserId: string;
  readonly approvedByOxyUserId: string | null;
  readonly impact: CatalogImpactEstimate;
  readonly completedPhases: readonly CatalogSplitPhase[];
  readonly assignedItems: number;
  readonly appliedItems: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}
