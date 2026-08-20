/**
 * Catalog proposals and operator review (#367 step 6, ADR 0007 D9) —
 * `catalog_proposals`, `catalog_proposal_duplicate_candidates`,
 * `catalog_proposal_references` and `catalog_review_events`.
 *
 * A proposal is a merchant saying "the thing I am describing is not in your
 * catalogue". ADR 0007 D9's binding sentence is that **a merchant proposal never
 * becomes globally trusted data by being submitted**, and these four tables are
 * where that either holds structurally or quietly stops holding.
 *
 * ## The four places the rule is a ROW SHAPE
 *
 * 1. **There is no `key` column and no `slug` column, on any table here.**
 *    ADR 0007 D1 makes the machine key identity, frozen by trigger after insert,
 *    cited by every seed, fixture, external mapping and export. A submitter who
 *    could propose one would be proposing identity. The operator mints the key at
 *    approval time, in the request body — so a merchant's spelling has no column
 *    it could arrive in, which is stronger than any check that would have to
 *    refuse it.
 * 2. **`resolved_entity_id` is present EXACTLY in a resolved state**
 *    (`catalog_proposals_resolution_check`, rendered from
 *    `CATALOG_PROPOSAL_RESOLVED_STATES`). A `submitted` row naming a catalogue
 *    entity has no shape, so nothing that joins through this column can pick up
 *    an undecided proposal whatever a service does.
 * 3. **A resolution names a DECIDER, and the decider is not the submitter**
 *    (`catalog_proposals_decision_audit_check`,
 *    `catalog_proposals_decider_distinct_check`). The second is the one worth
 *    reading: a merchant who is also on the operator allow-list must not approve
 *    their own request, and the CHECK costs an operator nothing because an
 *    operator wanting to create catalogue data has the surface that owns it.
 * 4. **`catalog_review_events` is append-only against UPDATE *and* DELETE**, and
 *    its foreign key is `restrict` so the declaration agrees with the trigger —
 *    the `buyer_request_events` rule. A cascade beside a no-delete trigger is a
 *    way to delete the audit trail by deleting its parent.
 *
 * ## Convergence, and why the key is GENERATED
 *
 * `convergence_key` is `type : attribute : category : product type : normalized
 * label`, STORED and GENERATED, with a partial unique over the OPEN states
 * (`CATALOG_PROPOSAL_OPEN_STATES`). Two merchants asking for the same colour on
 * the same attribute converge on ONE proposal and the second becomes a
 * REFERENCE — which is the difference between an operator reading one request
 * with two people waiting and a queue of forty identical rows.
 *
 * The join is INJECTIVE without escaping because only the LAST component is free
 * text: every other component is a uuid or a member of a closed tuple, none of
 * which can contain the `:` separator. #63's identity key had to escape its
 * components precisely because they were all free text; stating the difference
 * here is what stops somebody "simplifying" this into the ambiguous shape.
 *
 * ## What no row here can say
 *
 * - **That a proposal is evidence.** Nothing in the catalogue joins TO
 *   `catalog_proposals`; the references point the other way, from this domain at
 *   the drafts and claims that are waiting. A ranking, a search or a facet
 *   cannot reach a proposal, and `catalog-proposal-isolation.test.ts` fails the
 *   build if a module in this domain reaches ranking, fees or referrals.
 * - **That a scan found nothing because there was nothing to find.**
 *   `duplicate_scan_population` is counted from the set the detector actually
 *   read, so an empty candidate list beside a population of zero and one beside a
 *   population of nine hundred are different rows. A CHECK holds
 *   `candidates <= population`, which is the vacuity floor stated at the row.
 * - **That a value was backfilled twice.** `catalog_proposal_references
 *   .backfilled_at` moves NULL → a value exactly once, by a compare-and-swap
 *   whose empty `RETURNING` set IS the "already applied" answer.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CATALOG_PROPOSAL_DUPLICATE_CANDIDATE_KINDS,
  CATALOG_PROPOSAL_DUPLICATE_DETECTORS,
  CATALOG_PROPOSAL_OPEN_STATES,
  CATALOG_PROPOSAL_ORIGINS,
  CATALOG_PROPOSAL_REFERENCE_KINDS,
  CATALOG_PROPOSAL_REJECTION_REASONS,
  CATALOG_PROPOSAL_RESOLVED_STATES,
  CATALOG_PROPOSAL_STATES,
  CATALOG_PROPOSAL_TYPES,
  CATALOG_REVIEW_ACTIONS,
  CATALOG_REVIEW_ACTOR_KINDS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { attributeDefinitions } from './attributeRegistry';
import { categories } from './catalog';
import { catalogAuthoringDrafts, catalogAuthoringDraftValues } from './catalogAuthoring';
import { productTypeDefinitions } from './productTypes';
import { nativeListingAttributeClaims } from './variantAxes';
import { stores } from './stores';

/**
 * `catalog_proposals` — one request for a missing catalogue concept.
 *
 * ## The context columns are PINS, and each is `restrict`
 *
 * A `controlled_value` proposal is about ONE attribute definition VERSION: the
 * controlled-value set a submitter was shown belongs to that version, and a
 * proposal that named only the attribute KEY would be answerable against a set
 * nobody saw. The version is DERIVED from the definition the submitter names and
 * is deliberately absent from the submission shape
 * (`CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS`).
 *
 * ## `store_id` is nullable, and the biconditional is why
 *
 * A merchant proposal always names its store; an operator-opened one — the row a
 * `redirect` mints — never does. One column with
 * `catalog_proposals_origin_scope_check` over `origin` says both, where a NOT
 * NULL column would force the redirect to borrow a store that did not ask for it.
 */
export const catalogProposals = pgTable(
  'catalog_proposals',
  {
    id: generatedId(),
    type: text({ enum: asEnumValues(CATALOG_PROPOSAL_TYPES) }).notNull(),
    origin: text({ enum: asEnumValues(CATALOG_PROPOSAL_ORIGINS) }).notNull().default('merchant'),
    state: text({ enum: asEnumValues(CATALOG_PROPOSAL_STATES) }).notNull().default('submitted'),

    /**
     * The store that asked. `restrict`, unlike the authoring draft's `cascade`:
     * a draft is working state that expires on its own, and a proposal is a
     * REQUEST an operator answered — deleting the store must not silently remove
     * the record of a decision, or of the value that decision minted.
     */
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    submittedByOxyUserId: text().notNull(),

    /** The submitter's own words, VERBATIM. Never normalized away (ADR 0007 D7). */
    proposedLabel: text().notNull(),
    /** A folded BCP 47 tag — the stored form the localization family uses. */
    sourceLocale: text().notNull(),
    /**
     * The candidate-generation form, written by the service from
     * `normalizeEntityName`. A PLAIN column and not GENERATED, the
     * `organizations.normalized_name` decision: the folding is application
     * vocabulary that may deepen, and a generated column's rewrite drops indexes.
     */
    normalizedLabel: text().notNull(),
    /**
     * The SEARCH form — accent-folded and lower-cased, the space the trigram
     * index lives in. Separate from `normalized_label` because the two answer
     * different questions: the normalized form decides CONVERGENCE (is this the
     * same request) and the search form decides RETRIEVAL (what looks like it).
     * Folding legal suffixes out of a retrieval key would make `Limited` the
     * brand unfindable.
     */
    searchLabel: text().notNull(),

    proposedDescription: text(),
    /** Free text the submitter wrote for the reviewer. */
    submitterNote: text(),

    /** `restrict`: nothing deletes a category, and a pin may not be orphaned. */
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    productTypeDefinitionId: text().references(() => productTypeDefinitions.id, {
      onDelete: 'restrict',
    }),
    attributeDefinitionId: text().references(() => attributeDefinitions.id, {
      onDelete: 'restrict',
    }),
    /** DERIVED from the definition above, never supplied. See the table doc. */
    attributeDefinitionVersion: integer(),

    /**
     * The catalogue entity this became. Polymorphic by `type`, and carrying NO
     * foreign key.
     *
     * Ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` for two reasons at once. One
     * column cannot reference eight tables, and eight nullable typed columns plus
     * a CHECK would buy a constraint on rows whose targets are never hard-deleted
     * — the `merchant_claim_scopes.scope_ref` ruling. The other is the merge:
     * four of the eight types are MERGEABLE entities, and a `restrict` key here
     * would let an answered proposal block a catalogue merge while every other
     * `ON DELETE` would erase or silently empty the record of what an operator
     * decided. A resolved id that has since been merged resolves through the
     * tombstone's own `merged_into_id`, exactly as an authoring draft's selection
     * does — which is also why this domain needs no `merge-plan.ts` entry.
     */
    resolvedEntityId: text(),
    /**
     * The proposal an operator REDIRECTED this one into. A self-FK, `restrict`:
     * the row a redirect points at is the continuation of this request and must
     * not vanish from under it.
     */
    redirectedToProposalId: text().references((): AnyPgColumn => catalogProposals.id, {
      onDelete: 'restrict',
    }),

    rejectionReason: text({ enum: asEnumValues(CATALOG_PROPOSAL_REJECTION_REASONS) }),
    /** The reviewer's words, written to be read by the submitter. */
    decisionReason: text(),
    /** An Oxy account id — no foreign key. */
    decidedByOxyUserId: text(),
    decidedAt: timestamptz(),
    /** When a `deferred` proposal comes back to the queue. */
    deferredUntil: timestamptz(),

    /**
     * The duplicate scan's own positive control: how many existing labels the
     * detector COMPARED AGAINST. Zero is a real and useful answer — it says there
     * was nothing to be a duplicate of — and it is a different fact from an empty
     * candidate list over a population of nine hundred.
     */
    duplicateScanPopulation: integer().notNull().default(0),
    duplicateScanCandidates: integer().notNull().default(0),
    duplicateScanAt: timestamptz(),

    /**
     * The convergence key (see the file header). GENERATED and STORED, so the
     * stored spelling and the uniqueness key cannot disagree — and injective
     * because only the last component is free text.
     */
    convergenceKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`"type" || ':' || coalesce("attribute_definition_id", '') || ':' || coalesce("category_id", '') || ':' || coalesce("product_type_definition_id", '') || ':' || "normalized_label"`,
      ),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_proposals_type_check', t.type, CATALOG_PROPOSAL_TYPES),
    checkOneOf('catalog_proposals_origin_check', t.origin, CATALOG_PROPOSAL_ORIGINS),
    checkOneOf('catalog_proposals_state_check', t.state, CATALOG_PROPOSAL_STATES),
    checkOneOf(
      'catalog_proposals_rejection_reason_check',
      t.rejectionReason,
      CATALOG_PROPOSAL_REJECTION_REASONS,
    ),
    // A merchant proposal names its store; an operator-opened one names none.
    check(
      'catalog_proposals_origin_scope_check',
      sql`(${t.origin} = 'merchant') = (${t.storeId} is not null)`,
    ),
    // An empty request is not a smaller request, it is a row nobody can act on.
    check('catalog_proposals_label_check', sql`btrim(${t.proposedLabel}) <> ''`),
    check('catalog_proposals_normalized_label_check', sql`btrim(${t.normalizedLabel}) <> ''`),
    check('catalog_proposals_search_label_check', sql`btrim(${t.searchLabel}) <> ''`),
    // The stored forms, stated at the row: a lookup that folded and a write that
    // did not are a MISS rather than an error anybody sees.
    check(
      'catalog_proposals_normalized_shape_check',
      sql`${t.normalizedLabel} = lower(btrim(${t.normalizedLabel}))`,
    ),
    check(
      'catalog_proposals_search_shape_check',
      sql`${t.searchLabel} = lower(btrim(${t.searchLabel}))`,
    ),
    // Identical to `catalog_authoring_drafts_locale_shape_check`, so the two
    // vocabularies cannot diverge on what a legal tag looks like.
    check(
      'catalog_proposals_locale_shape_check',
      sql`${t.sourceLocale} = lower(btrim(${t.sourceLocale})) and ${t.sourceLocale} ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'`,
    ),
    // A value proposal is ABOUT one attribute, and it pins the version whose
    // controlled-value set the submitter was shown. Both halves, because an
    // attribute with no version is a pin nobody can reproduce.
    check(
      'catalog_proposals_controlled_value_subject_check',
      sql`${t.type} <> 'controlled_value'
          or (${t.attributeDefinitionId} is not null and ${t.attributeDefinitionVersion} is not null)`,
    ),
    check(
      'catalog_proposals_attribute_pin_check',
      sql`(${t.attributeDefinitionId} is null) = (${t.attributeDefinitionVersion} is null)`,
    ),
    check('catalog_proposals_attribute_version_check', sql`${t.attributeDefinitionVersion} >= 1`),
    // THE row-level half of "never becomes globally trusted by being submitted":
    // only a resolved state names an entity, and every resolved state names one.
    check(
      'catalog_proposals_resolution_check',
      sql`(${t.state} in (${sql.raw(inList(CATALOG_PROPOSAL_RESOLVED_STATES))}))
          = (${t.resolvedEntityId} is not null)`,
    ),
    // A redirect names its continuation; nothing else carries one.
    check(
      'catalog_proposals_redirect_check',
      sql`(${t.state} = 'redirected') = (${t.redirectedToProposalId} is not null)`,
    ),
    check(
      'catalog_proposals_redirect_self_check',
      sql`${t.redirectedToProposalId} is distinct from ${t.id}`,
    ),
    // A rejection carries its code; nothing else does. TWO biconditionals would
    // be needed if this were two facts — it is one, and the code is only ever
    // meaningful on a rejection.
    check(
      'catalog_proposals_rejection_shape_check',
      sql`(${t.state} = 'rejected') = (${t.rejectionReason} is not null)`,
    ),
    // A decision names a decider, a time and a reason. `withdrawn` is the
    // submitter's own act and is excluded — it is not a review outcome, and
    // demanding an operator for it would make a submitter unable to close their
    // own request.
    check(
      'catalog_proposals_decision_audit_check',
      sql`${t.state} in ('submitted', 'needs_information', 'deferred', 'withdrawn')
          or (${t.decidedByOxyUserId} is not null
              and ${t.decidedAt} is not null
              and btrim(coalesce(${t.decisionReason}, '')) <> '')`,
    ),
    // Nobody approves their own request. A merchant who is also on the operator
    // allow-list is the case this exists for; it costs a real operator nothing,
    // because creating catalogue data directly is what the owning surface is for.
    check(
      'catalog_proposals_decider_distinct_check',
      sql`${t.decidedByOxyUserId} is null
          or ${t.decidedByOxyUserId} <> ${t.submittedByOxyUserId}`,
    ),
    // A deferral names when it comes back; nothing else has a date to come back on.
    check(
      'catalog_proposals_deferred_check',
      sql`(${t.state} = 'deferred') = (${t.deferredUntil} is not null)`,
    ),
    // The vacuity floor, at the row. A scan cannot report more hits than the set
    // it read, and both counters are non-negative.
    check('catalog_proposals_scan_population_check', sql`${t.duplicateScanPopulation} >= 0`),
    check(
      'catalog_proposals_scan_candidates_check',
      sql`${t.duplicateScanCandidates} >= 0
          and ${t.duplicateScanCandidates} <= ${t.duplicateScanPopulation}`,
    ),
    // A scan that ran is dated; one that has not is not. Without this a row could
    // report a population with no instant, which is a measurement nobody can age.
    check(
      'catalog_proposals_scan_dated_check',
      sql`${t.duplicateScanAt} is not null
          or (${t.duplicateScanPopulation} = 0 and ${t.duplicateScanCandidates} = 0)`,
    ),
    /**
     * ONE open proposal per concept. See the file header for why the generated
     * key is injective without escaping.
     *
     * Partial over `CATALOG_PROPOSAL_OPEN_STATES` and rendered from that tuple,
     * so the index predicate and the service's own idea of "open" cannot drift.
     * A decided proposal leaves the index, which is what lets the same concept be
     * proposed again after a rejection — `match_blocked_pairs` is where a
     * re-proposal loop gets stopped, and it is not this index's job.
     */
    uniqueIndex('catalog_proposals_open_convergence_key')
      .on(t.convergenceKey)
      .where(sql`${t.state} in (${sql.raw(inList(CATALOG_PROPOSAL_OPEN_STATES))})`),
    /** The operator queue: by state, oldest first. */
    index('catalog_proposals_state_created_at_idx').on(t.state, t.createdAt),
    /** A store's own proposals, newest first — the merchant surface's only feed. */
    index('catalog_proposals_store_idx').on(t.storeId, t.state, t.createdAt.desc()),
    /** The duplicate scan's exact-match probe, and the convergence lookup. */
    index('catalog_proposals_normalized_label_idx').on(
      t.type,
      t.attributeDefinitionId,
      t.normalizedLabel,
    ),
    /**
     * The near-match probe. GiST rather than GIN, and the distance operator
     * rather than `similarity(...)`: #61 measured the same shape on
     * `canonical_products.normalized_name` at 81.6 ms scanning 31,094 rows
     * against 16.6 ms scanning 25, because `ORDER BY x <-> $1` can be served by a
     * GiST index and `ORDER BY similarity(x, $1) DESC` can be served by no index
     * at all.
     */
    index('catalog_proposals_search_label_gist_trgm_idx').using(
      'gist',
      t.searchLabel.op('gist_trgm_ops'),
    ),
    /** The deferral sweep: partial, the size of the deferred set. */
    index('catalog_proposals_deferred_until_idx')
      .on(t.deferredUntil)
      .where(sql`${t.deferredUntil} is not null`),
  ],
);

/**
 * `catalog_proposal_duplicate_candidates` — what the pre-submission scan found.
 *
 * ADR 0007 D9 asks for duplicate detection BEFORE submission, and this table is
 * what makes "detection ran" auditable rather than assumed. The evidence is
 * stored beside the proposal because the operator's first question is always
 * "did anybody check", and a detector that quietly matched nothing and one that
 * was never called produce the same empty list.
 *
 * Append-only against UPDATE by trigger. DELETE is permitted, for the
 * `analytics_events` reason inverted onto a cascade: these rows exist only to
 * explain one proposal and a retention sweep must be able to remove them without
 * a trigger making it fail silently.
 *
 * `candidate_ref` carries NO foreign key: it is polymorphic across eight entity
 * kinds AND `catalog_proposals` itself, and half the targets are mergeable
 * entities where a `restrict` key would let a stale scan record block a merge.
 */
export const catalogProposalDuplicateCandidates = pgTable(
  'catalog_proposal_duplicate_candidates',
  {
    id: generatedId(),
    proposalId: text()
      .notNull()
      .references(() => catalogProposals.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(CATALOG_PROPOSAL_DUPLICATE_CANDIDATE_KINDS) }).notNull(),
    detector: text({ enum: asEnumValues(CATALOG_PROPOSAL_DUPLICATE_DETECTORS) }).notNull(),
    /** The entity id or the open proposal id. Polymorphic; see the table doc. */
    candidateRef: text().notNull(),
    /** The candidate's label as it stood when the scan ran. Evidence, not a join. */
    candidateLabel: text().notNull(),
    /** Present EXACTLY for `trigram_similarity`. See the CHECK below. */
    similarity: doublePrecision(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_proposal_duplicate_candidates_kind_check',
      t.kind,
      CATALOG_PROPOSAL_DUPLICATE_CANDIDATE_KINDS,
    ),
    checkOneOf(
      'catalog_proposal_duplicate_candidates_detector_check',
      t.detector,
      CATALOG_PROPOSAL_DUPLICATE_DETECTORS,
    ),
    check(
      'catalog_proposal_duplicate_candidates_ref_check',
      sql`btrim(${t.candidateRef}) <> '' and btrim(${t.candidateLabel}) <> ''`,
    ),
    /**
     * A score belongs to the detector that measured one, and to no other.
     *
     * An exact hit has no similarity, and writing `1.0` beside it would invite a
     * threshold comparison against a number nobody measured — the
     * `RankingSignalOutcome` rule, one domain over.
     */
    check(
      'catalog_proposal_duplicate_candidates_similarity_check',
      sql`(${t.detector} = 'trigram_similarity') = (${t.similarity} is not null)`,
    ),
    check(
      'catalog_proposal_duplicate_candidates_similarity_range_check',
      sql`${t.similarity} is null or (${t.similarity} > 0 and ${t.similarity} <= 1)`,
    ),
    /** One row per candidate per proposal — a re-scan converges rather than piling up. */
    uniqueIndex('catalog_proposal_duplicate_candidates_key').on(t.proposalId, t.candidateRef),
    index('catalog_proposal_duplicate_candidates_proposal_idx').on(t.proposalId),
  ],
);

/**
 * `catalog_proposal_references` — who is WAITING on this proposal.
 *
 * This is what makes ADR 0007 D9's "backfill affected drafts and listings
 * idempotently" a bounded, enumerable job. The alternative — finding the affected
 * rows by re-deriving them at approval time from a label — is a scan of the
 * catalogue whose answer changes between the approval and the retry, which is
 * exactly the shape an idempotent backfill cannot have.
 *
 * ## The link lives HERE and not on the draft value, and that is a decision
 *
 * ADR 0007 D9 has a proposal referenced from a draft. A column on
 * `catalog_authoring_draft_values` would express one draft's one proposal and
 * could not express the convergence this domain is built around: two merchants
 * asking for the same colour are ONE proposal with TWO drafts waiting, which is a
 * many-to-many and needs a row of its own whichever side declares it. Putting it
 * here also keeps the dependency pointing one way — this domain reads authoring,
 * and authoring knows nothing about proposals.
 *
 * ## `backfilled_at` is the idempotency, and it is a CAS
 *
 * `UPDATE … SET backfilled_at = now() WHERE id = $1 AND backfilled_at IS NULL
 * RETURNING *`, whose EMPTY result set IS the "already applied" answer — the
 * `moderation_events` claim shape. A read-then-write would let two operators
 * both see NULL and both apply.
 */
export const catalogProposalReferences = pgTable(
  'catalog_proposal_references',
  {
    id: generatedId(),
    proposalId: text()
      .notNull()
      .references(() => catalogProposals.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(CATALOG_PROPOSAL_REFERENCE_KINDS) }).notNull(),
    /**
     * The draft that is waiting. `cascade`: the draft-expiry sweep deletes
     * abandoned drafts, and a reference to a draft that no longer exists is not a
     * weaker reference, it is one about nothing.
     */
    draftId: text().references(() => catalogAuthoringDrafts.id, { onDelete: 'cascade' }),
    draftValueId: text().references(() => catalogAuthoringDraftValues.id, {
      onDelete: 'cascade',
    }),
    /**
     * The published listing's retained claim (ADR 0007 D7) that is waiting.
     * `cascade` for the same reason and by the same route: the claim already
     * cascades from its listing.
     */
    listingClaimId: text().references(() => nativeListingAttributeClaims.id, {
      onDelete: 'cascade',
    }),
    /** NULL until the approval's backfill applied this one. Moves once. */
    backfilledAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('catalog_proposal_references_kind_check', t.kind, CATALOG_PROPOSAL_REFERENCE_KINDS),
    /**
     * The discriminant, as TWO biconditionals and never one over their
     * conjunction. The single-CHECK spelling is satisfied by a row carrying
     * NEITHER pointer, because both sides evaluate false — which is exactly the
     * reference that names nothing. Measured three times already in this schema
     * (`category_redirects`, `retail_delivery_promises`,
     * `catalog_authoring_drafts`).
     */
    check(
      'catalog_proposal_references_draft_shape_check',
      sql`(${t.kind} = 'authoring_draft_value') = (${t.draftValueId} is not null)`,
    ),
    check(
      'catalog_proposal_references_claim_shape_check',
      sql`(${t.kind} = 'listing_attribute_claim') = (${t.listingClaimId} is not null)`,
    ),
    /** A draft value names its draft, so the backfill can bump the draft's version. */
    check(
      'catalog_proposal_references_draft_pair_check',
      sql`(${t.draftValueId} is null) = (${t.draftId} is null)`,
    ),
    /**
     * TWO partial uniques rather than one over both pointers, because Postgres
     * treats NULLs as DISTINCT: a single index over
     * `(proposal_id, draft_value_id, listing_claim_id)` would admit any number of
     * rows for either kind, since each carries exactly one NULL.
     */
    uniqueIndex('catalog_proposal_references_draft_value_key')
      .on(t.proposalId, t.draftValueId)
      .where(sql`${t.draftValueId} is not null`),
    uniqueIndex('catalog_proposal_references_listing_claim_key')
      .on(t.proposalId, t.listingClaimId)
      .where(sql`${t.listingClaimId} is not null`),
    /**
     * The backfill's own page. Partial over the OUTSTANDING set, so the index is
     * the size of the work rather than of the history.
     */
    index('catalog_proposal_references_pending_idx')
      .on(t.proposalId, t.createdAt)
      .where(sql`${t.backfilledAt} is null`),
    /** The publication gate: does THIS draft carry an open proposal? */
    index('catalog_proposal_references_draft_idx')
      .on(t.draftId)
      .where(sql`${t.draftId} is not null`),
  ],
);

/**
 * `catalog_review_events` — the append-only review timeline (ADR 0007 D9).
 *
 * `at` and no `updated_at`: the `order_status_history` / `merchant_claim_events`
 * contract. One row per ACTION, refusals included, so "what happened to my
 * proposal" is answerable without trusting anybody to remember to log it.
 *
 * The foreign key is `restrict` and NOT `cascade`, deliberately, because
 * `mercaria_catalog_review_event_append_only` refuses DELETE: a cascade beside a
 * no-delete trigger is a way to remove the audit trail by removing its parent,
 * and the two would disagree with the trigger winning in the confusing direction
 * (the delete of the proposal fails, naming a table the operator did not touch).
 * The declaration agreeing with the trigger is what makes the refusal legible.
 */
export const catalogReviewEvents = pgTable(
  'catalog_review_events',
  {
    id: generatedId(),
    proposalId: text()
      .notNull()
      .references(() => catalogProposals.id, { onDelete: 'restrict' }),
    action: text({ enum: asEnumValues(CATALOG_REVIEW_ACTIONS) }).notNull(),
    actorKind: text({ enum: asEnumValues(CATALOG_REVIEW_ACTOR_KINDS) }).notNull(),
    /** An Oxy account id — no foreign key. NULL exactly when the actor is `system`. */
    actorOxyUserId: text(),
    fromState: text({ enum: asEnumValues(CATALOG_PROPOSAL_STATES) }),
    toState: text({ enum: asEnumValues(CATALOG_PROPOSAL_STATES) }),
    reason: text(),
    at: timestamptz().notNull(),
    /**
     * The order these events were WRITTEN, and the only thing that can say it.
     *
     * `at` is not enough and that is not a rounding problem: a submission and
     * its duplicate scan are written in ONE transaction from ONE `now`, so they
     * share the column exactly. The tiebreak was the uuid v7 primary key, which
     * `@oxyhq/db` does not make monotonic within a millisecond — so the trail's
     * order was decided by the low bits of a random id (#775), in the operator
     * TIMELINE as well as in a test.
     *
     * That the order is a FACT rather than a rendering choice is already stored
     * beside it: `duplicate_scan_recorded` carries `from_state = 'submitted'`,
     * which presupposes the submission. Reverse the two and that column is a
     * lie about a state which had not been reached.
     *
     * NULLABLE, and every row written before this column existed is NULL — a
     * deliberate refusal, not a backfill somebody forgot. Adding the column with
     * a sequence-backed DEFAULT would have assigned history distinct values in
     * HEAP order (measured: three rows inserted `c, a, b` came out `1, 2, 3` by
     * physical position), which is an invented order indistinguishable from a
     * real one afterwards. Those rows never recorded their sequence and this
     * column does not pretend otherwise.
     */
    sequence: bigint({ mode: 'number' }),
  },
  (t) => [
    checkOneOf('catalog_review_events_action_check', t.action, CATALOG_REVIEW_ACTIONS),
    checkOneOf('catalog_review_events_actor_kind_check', t.actorKind, CATALOG_REVIEW_ACTOR_KINDS),
    checkOneOf('catalog_review_events_from_state_check', t.fromState, CATALOG_PROPOSAL_STATES),
    checkOneOf('catalog_review_events_to_state_check', t.toState, CATALOG_PROPOSAL_STATES),
    // A human action names its human. `system` is the only actorless kind, and
    // making that a CHECK stops an unattributed operator decision existing.
    check(
      'catalog_review_events_actor_presence_check',
      sql`(${t.actorKind} = 'system') = (${t.actorOxyUserId} is null)`,
    ),
    index('catalog_review_events_proposal_at_idx').on(t.proposalId, t.at),
  ],
);
