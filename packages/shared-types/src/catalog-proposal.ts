/**
 * Catalog proposals and operator review (#367 step 6, ADR 0007 D9).
 *
 * A proposal is somebody saying "the thing I am trying to describe is not in
 * your catalogue". It is a REQUEST, and the whole vocabulary here exists to keep
 * it one: ADR 0007 D9's binding sentence is that **a merchant proposal never
 * becomes globally trusted data by being submitted**, and a vocabulary is where
 * that either holds structurally or quietly stops holding.
 *
 * ## The three places the rule is a SHAPE rather than a check
 *
 * 1. **There is no `key` anywhere a submitter can reach.** ADR 0007 D1 makes the
 *    machine key identity and freezes it after insert, so a submitter who could
 *    propose one would be proposing an identity — and every seed, fixture,
 *    external mapping and export that later cited it would be citing a merchant's
 *    guess. {@link CatalogProposalSubmission} therefore carries a LABEL and no
 *    key, and the key is minted by the operator in
 *    {@link CatalogProposalApproval}. A submitter cannot express one, so there is
 *    nothing to refuse.
 * 2. **{@link CATALOG_PROPOSAL_MINTABLE_TYPES} has ONE member.** Approving a
 *    proposal can mint exactly one kind of entity — a controlled value under an
 *    attribute an operator already published. Everything else is
 *    {@link CATALOG_PROPOSAL_LINK_ONLY_TYPES}: the operator names an entity that
 *    already exists, created through the surface that owns it. The two tuples are
 *    DISJOINT and their union is {@link CATALOG_PROPOSAL_TYPES} exactly, which is
 *    a census a test runs rather than a claim this comment makes.
 * 3. **{@link CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS} names what a
 *    submitter may never supply**, disjoint from
 *    {@link CATALOG_PROPOSAL_SUBMITTER_FIELDS}. The `RETAIL_FORBIDDEN_COMPONENT_KINDS`
 *    device: a refusal that NAMES the prohibited field is a different experience
 *    from "unrecognized key", and the prohibition is a value a gate can scan for
 *    rather than a sentence in a review.
 *
 * ## Where the pending-publication decision lives
 *
 * Not here. `product_type_definitions.pending_proposal_policy` (ADR 0007 D9's
 * last paragraph) is a property of the VERSION, so it is versioned and
 * reviewable; this domain reads it and never re-decides it.
 */

/**
 * What is missing (ADR 0007 D9's own list, in the order the ADR writes it).
 *
 * These are CONCEPT kinds and not table names, deliberately: `product_family`
 * and `canonical_product` are two levels of one graph and a submitter picks
 * between them by what they are describing, not by which table it lands in.
 */
export type CatalogProposalType =
  | 'category'
  | 'product_type'
  | 'brand'
  | 'product_family'
  | 'canonical_product'
  | 'canonical_variant'
  | 'attribute'
  | 'controlled_value';

export const CATALOG_PROPOSAL_TYPES: readonly CatalogProposalType[] = [
  'category',
  'product_type',
  'brand',
  'product_family',
  'canonical_product',
  'canonical_variant',
  'attribute',
  'controlled_value',
];

/**
 * The one type an approval may MINT.
 *
 * A controlled value is an `attribute_enum_values` row under an attribute
 * definition an operator has already drafted, reviewed and published. Adding one
 * is a single idempotent insert into a table whose parent this domain already
 * cites, it moves no identity, and the authoring cache already has a subject for
 * it (`attribute_values`) precisely because the controlled-value set is the one
 * thing that can still move under a live schema.
 *
 * Everything else in {@link CATALOG_PROPOSAL_TYPES} is
 * {@link CATALOG_PROPOSAL_LINK_ONLY_TYPES}.
 */
export const CATALOG_PROPOSAL_MINTABLE_TYPES: readonly CatalogProposalType[] = ['controlled_value'];

/**
 * Every type an approval may only LINK, and the surface that owns creating one.
 *
 * This is the design and not a deferral. A category carries a key and an
 * ancestry and has a write chokepoint; a product type is a versioned schema an
 * operator drafts, scopes and publishes; a brand, family, product and variant are
 * the canonical graph, with identity, alias and merge machinery around every
 * mint; an attribute definition is #94's registry with its own version freeze.
 * A second writer for any of them is exactly what those chokepoints exist to
 * refuse, and "a proposal surface may create one" is how the second writer
 * arrives wearing a reasonable name.
 *
 * So an operator creates the entity where it is owned, and then MERGES the
 * proposal into it — which is one of ADR 0007 D9's own six operator actions, and
 * which leaves the record saying exactly what happened.
 */
export const CATALOG_PROPOSAL_LINK_ONLY_TYPES: Readonly<Record<string, string>> = {
  category: '/internal/commerce-graph — the taxonomy write chokepoint owns a category key and its ancestry.',
  product_type: '/internal/product-types — a product type is a versioned schema an operator drafts and publishes.',
  brand: '/internal/canonical-catalog — the canonical graph owns a brand, its aliases and its merge history.',
  product_family: '/internal/canonical-catalog — a family is a canonical entity with its own identity gate.',
  canonical_product: '/internal/canonical-catalog — minting a product is #60/#58 work, never a side effect of review.',
  canonical_variant: '/internal/canonical-catalog — a variant identity is its option assignments, which a label cannot supply.',
  attribute: '/internal/catalog-attributes — #94 owns the registry and freezes a published definition version.',
};

/**
 * Where a proposal came from.
 *
 * `merchant` always names a store; `operator` never does — the CHECK on the row
 * is a biconditional over exactly that, so an operator-opened proposal (the one
 * a `redirect` mints) cannot borrow a merchant's scope and a merchant's cannot
 * lose it.
 */
export type CatalogProposalOrigin = 'merchant' | 'operator';

export const CATALOG_PROPOSAL_ORIGINS: readonly CatalogProposalOrigin[] = ['merchant', 'operator'];

/**
 * The lifecycle.
 *
 * ADR 0007 D9 names six operator actions — approve, reject, request information,
 * merge into existing, redirect, defer — and each lands the row somewhere. The
 * seventh state, `withdrawn`, is the SUBMITTER's: somebody who realises their own
 * mistake must be able to close their request without an operator spending a
 * decision on it.
 *
 * `approved` and `merged` are separate states and not one `resolved`, because
 * they answer different questions about the catalogue: `approved` means this
 * domain minted the value, `merged` means an operator pointed the request at
 * something that already existed. Collapsing them makes "how much of our
 * catalogue arrived through proposals" unanswerable.
 */
export type CatalogProposalState =
  | 'submitted'
  | 'needs_information'
  | 'deferred'
  | 'approved'
  | 'merged'
  | 'redirected'
  | 'rejected'
  | 'withdrawn';

export const CATALOG_PROPOSAL_STATES: readonly CatalogProposalState[] = [
  'submitted',
  'needs_information',
  'deferred',
  'approved',
  'merged',
  'redirected',
  'rejected',
  'withdrawn',
];

/**
 * The states in which a proposal is still WAITING on somebody.
 *
 * Read by the convergence index's predicate and by the publication gate, from
 * this one tuple, so "is this proposal still open" cannot be answered two ways.
 * `deferred` is open: an operator saying "not now" has not decided, and a draft
 * carrying a deferred proposal is still carrying an unanswered question.
 */
export const CATALOG_PROPOSAL_OPEN_STATES: readonly CatalogProposalState[] = [
  'submitted',
  'needs_information',
  'deferred',
];

/**
 * The states that carry a resolved entity, and the only two an approval reaches.
 *
 * A biconditional CHECK on the row reads this tuple, so a `submitted` proposal
 * naming an entity is unrepresentable — which is the row-level half of "never
 * becomes globally trusted data by being submitted".
 */
export const CATALOG_PROPOSAL_RESOLVED_STATES: readonly CatalogProposalState[] = [
  'approved',
  'merged',
];

/** Whether a proposal is still waiting on somebody. */
export function isOpenCatalogProposalState(state: CatalogProposalState): boolean {
  return CATALOG_PROPOSAL_OPEN_STATES.includes(state);
}

/** Whether a proposal state names a resolved catalogue entity. */
export function isResolvedCatalogProposalState(state: CatalogProposalState): boolean {
  return CATALOG_PROPOSAL_RESOLVED_STATES.includes(state);
}

/**
 * Why a proposal was refused, as a CODE.
 *
 * Coded rather than free text for the reason every refusal in this repository is
 * coded: a client renders its own sentence, an operator dashboard counts them,
 * and nothing matches on prose. `decision_reason` still carries the reviewer's
 * words, written to be read by the submitter — the `merchant_claims` split.
 *
 * There is deliberately no `already_exists` member: that outcome is `merged`,
 * which names WHICH entity, and a rejection code saying the same thing without
 * the pointer would be the strictly worse record of the same decision.
 */
export type CatalogProposalRejectionReason =
  | 'not_a_distinct_concept'
  | 'out_of_scope'
  | 'insufficient_evidence'
  | 'misclassified'
  | 'prohibited_content'
  | 'other';

export const CATALOG_PROPOSAL_REJECTION_REASONS: readonly CatalogProposalRejectionReason[] = [
  'not_a_distinct_concept',
  'out_of_scope',
  'insufficient_evidence',
  'misclassified',
  'prohibited_content',
  'other',
];

/**
 * Everything that happens to a proposal, recorded in `catalog_review_events`.
 *
 * Wider than the state vocabulary on purpose: `duplicate_scan_recorded`,
 * `information_supplied` and `backfill_applied` move no state and are exactly the
 * events an operator needs to answer "what happened to my proposal" — and
 * `duplicate_scan_recorded` in particular is what makes "detection ran and found
 * nothing" distinguishable from "detection never ran", which are otherwise the
 * same silence.
 */
export type CatalogReviewAction =
  | 'submitted'
  | 'duplicate_scan_recorded'
  | 'information_requested'
  | 'information_supplied'
  | 'approved'
  | 'merged_into_existing'
  | 'redirected'
  | 'deferred'
  | 'rejected'
  | 'withdrawn'
  | 'backfill_applied';

export const CATALOG_REVIEW_ACTIONS: readonly CatalogReviewAction[] = [
  'submitted',
  'duplicate_scan_recorded',
  'information_requested',
  'information_supplied',
  'approved',
  'merged_into_existing',
  'redirected',
  'deferred',
  'rejected',
  'withdrawn',
  'backfill_applied',
];

/**
 * Who acted.
 *
 * `system` is the actorless kind and a CHECK makes it the ONLY one — an
 * unattributed operator decision has no row shape. The `merchant_claim_events`
 * device, for its reason.
 */
export type CatalogReviewActorKind = 'submitter' | 'operator' | 'system';

export const CATALOG_REVIEW_ACTOR_KINDS: readonly CatalogReviewActorKind[] = [
  'submitter',
  'operator',
  'system',
];

/* -------------------------------------------------------------------------- */
/* Duplicate detection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How a duplicate candidate was found.
 *
 * Three detectors and no fourth, and the ORDER matters to the reader rather than
 * to the code: an exact normalized hit is a fact, an alias hit is a fact somebody
 * recorded, and a trigram hit is a similarity score. Only the first two are
 * strong enough to refuse a submission; the third is evidence an operator reads.
 */
export type CatalogProposalDuplicateDetector =
  | 'exact_normalized'
  | 'recorded_alias'
  | 'trigram_similarity';

export const CATALOG_PROPOSAL_DUPLICATE_DETECTORS: readonly CatalogProposalDuplicateDetector[] = [
  'exact_normalized',
  'recorded_alias',
  'trigram_similarity',
];

/** The detectors whose hit is strong enough to REFUSE a submission outright. */
export const CATALOG_PROPOSAL_BLOCKING_DETECTORS: readonly CatalogProposalDuplicateDetector[] = [
  'exact_normalized',
  'recorded_alias',
];

/**
 * What a candidate IS.
 *
 * An existing entity and an open proposal are different answers to a submitter:
 * the first means "use this", the second means "somebody already asked and you
 * are now waiting with them". Collapsing them would make the second look like a
 * refusal of work that is in fact already under way.
 */
export type CatalogProposalDuplicateCandidateKind = 'existing_entity' | 'open_proposal';

export const CATALOG_PROPOSAL_DUPLICATE_CANDIDATE_KINDS: readonly CatalogProposalDuplicateCandidateKind[] =
  ['existing_entity', 'open_proposal'];

/**
 * One thing the duplicate scan found.
 *
 * `similarity` is present EXACTLY for `trigram_similarity` — a biconditional on
 * the row — because an exact hit has no score and printing `1.0` beside it would
 * invite a threshold comparison against a number that was never measured.
 */
export interface CatalogProposalDuplicateCandidate {
  readonly id: string;
  readonly kind: CatalogProposalDuplicateCandidateKind;
  readonly detector: CatalogProposalDuplicateDetector;
  /** The entity id or the open proposal's id. Polymorphic; carries no foreign key. */
  readonly ref: string;
  /** The candidate's own label, as it stands today. */
  readonly label: string;
  readonly similarity: number | null;
}

/**
 * What a duplicate scan REPORTS, and the reason `population` is in the type.
 *
 * A scan that examined nothing and a scan that examined nine hundred rows and
 * liked none of them produce the same empty candidate list. `population` is the
 * positive control: it is counted from the set the scan actually read, so an
 * operator reading `population: 0` knows there was nothing to compare against,
 * and a caller cannot fabricate it because it is returned by the detector rather
 * than supplied to it.
 */
export interface CatalogProposalDuplicateScan {
  /** How many existing labels the scan compared against. The positive control. */
  readonly population: number;
  readonly candidates: readonly CatalogProposalDuplicateCandidate[];
  /**
   * The candidate a submission would be REFUSED for, when there is one — an
   * exact or alias hit on an existing entity.
   */
  readonly blocking: CatalogProposalDuplicateCandidate | null;
  /**
   * The OPEN proposal a submission would converge onto, when there is one. A
   * different outcome from `blocking`: the submitter joins a request rather than
   * being told to use something that exists.
   */
  readonly convergesOnto: CatalogProposalDuplicateCandidate | null;
}

/* -------------------------------------------------------------------------- */
/* What a submitter may and may not send                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every property a submitter supplies. Paired with
 * {@link CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS}, which must stay disjoint.
 */
export const CATALOG_PROPOSAL_SUBMITTER_FIELDS: readonly string[] = [
  'type',
  'storeId',
  'proposedLabel',
  'sourceLocale',
  'proposedDescription',
  'submitterNote',
  'categoryId',
  'productTypeDefinitionId',
  'attributeDefinitionId',
  'draftId',
  'draftValueId',
];

/**
 * What a submitter may NEVER supply, named so a refusal can name it.
 *
 * Each one is a way a request would become an assertion:
 *
 * - `key`, `slug` — ADR 0007 D1 identity. A submitter proposing a key is
 *   proposing what every future seed and export will cite.
 * - `lifecycle`, `state`, `publishedAt` — the decision itself.
 * - `resolvedEntityId`, `canonicalProductId`, `brandId` — the link an approval
 *   makes.
 * - `verified`, `confidence`, `trustTier` — a claim about how much the proposal
 *   is worth, which is the reviewer's to form and nobody else's.
 * - `rankBoost`, `sponsored` — ranking, which #74 owns behind a versioned policy
 *   and which no catalogue write may reach.
 * - `attributeDefinitionVersion` — the pin. It is DERIVED from the definition the
 *   submitter names, because a submitter-supplied version could cite a version
 *   whose controlled-value set is not the one they were shown.
 */
export const CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS: readonly string[] = [
  'key',
  'slug',
  'lifecycle',
  'state',
  'publishedAt',
  'resolvedEntityId',
  'canonicalProductId',
  'brandId',
  'verified',
  'confidence',
  'trustTier',
  'rankBoost',
  'sponsored',
  'attributeDefinitionVersion',
];

/** A submission, as the HTTP surface accepts it. */
export interface CatalogProposalSubmission {
  readonly type: CatalogProposalType;
  /** The store this is submitted for. Required — an operator proposal is minted by a redirect. */
  readonly storeId: string;
  /** The label VERBATIM, in the locale the submitter was working in. */
  readonly proposedLabel: string;
  /** A folded BCP 47 tag, the stored form the localization family uses. */
  readonly sourceLocale: string;
  readonly proposedDescription?: string;
  readonly submitterNote?: string;
  /** The category the submitter was authoring under, or the PARENT of a proposed category. */
  readonly categoryId?: string;
  readonly productTypeDefinitionId?: string;
  /** Required for `controlled_value`: which attribute the value belongs to. */
  readonly attributeDefinitionId?: string;
  /** The draft that is waiting on this, when it came out of an authoring form. */
  readonly draftId?: string;
  readonly draftValueId?: string;
}

/* -------------------------------------------------------------------------- */
/* The public projection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A proposal, as every read emits it.
 *
 * The projection NAMES every field (the `provider_accounts` device) rather than
 * spreading a row, so a column added later is absent from the wire until
 * somebody decides it belongs there. It carries no submitter identity beyond the
 * account that made it — and the operator projection adds nothing about a
 * submitter either, because "which merchant asked for this" is answerable from
 * the store and does not need a second handle beside it.
 */
export interface CatalogProposal {
  readonly id: string;
  readonly type: CatalogProposalType;
  readonly origin: CatalogProposalOrigin;
  readonly state: CatalogProposalState;
  readonly storeId: string | null;
  readonly submittedByOxyUserId: string;
  readonly proposedLabel: string;
  readonly sourceLocale: string;
  /** The candidate-generation form. Never rendered as the concept's name. */
  readonly normalizedLabel: string;
  readonly proposedDescription: string | null;
  readonly submitterNote: string | null;
  readonly categoryId: string | null;
  readonly productTypeDefinitionId: string | null;
  readonly attributeDefinitionId: string | null;
  readonly attributeDefinitionVersion: number | null;
  /** Present EXACTLY in a resolved state. Polymorphic by `type`. */
  readonly resolvedEntityId: string | null;
  readonly redirectedToProposalId: string | null;
  readonly rejectionReason: CatalogProposalRejectionReason | null;
  readonly decisionReason: string | null;
  readonly decidedByOxyUserId: string | null;
  readonly decidedAt: string | null;
  readonly deferredUntil: string | null;
  /** The scan's own positive control. See {@link CatalogProposalDuplicateScan}. */
  readonly duplicateScanPopulation: number;
  readonly duplicateScanCandidates: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One entry in the append-only review timeline. */
export interface CatalogReviewEvent {
  readonly id: string;
  readonly proposalId: string;
  readonly action: CatalogReviewAction;
  readonly actorKind: CatalogReviewActorKind;
  readonly actorOxyUserId: string | null;
  readonly fromState: CatalogProposalState | null;
  readonly toState: CatalogProposalState | null;
  readonly reason: string | null;
  readonly at: string;
}

/**
 * What is waiting on a proposal.
 *
 * A reference is what makes "backfill affected drafts and listings" a bounded,
 * enumerable job rather than a scan of the catalogue, and `backfilledAt` is what
 * makes it idempotent: the backfill is a compare-and-swap on it being NULL, so a
 * second run applies nothing and says so.
 */
export type CatalogProposalReferenceKind = 'authoring_draft_value' | 'listing_attribute_claim';

export const CATALOG_PROPOSAL_REFERENCE_KINDS: readonly CatalogProposalReferenceKind[] = [
  'authoring_draft_value',
  'listing_attribute_claim',
];

export interface CatalogProposalReference {
  readonly id: string;
  readonly proposalId: string;
  readonly kind: CatalogProposalReferenceKind;
  readonly draftId: string | null;
  readonly draftValueId: string | null;
  readonly listingClaimId: string | null;
  readonly backfilledAt: string | null;
  readonly createdAt: string;
}

/** A proposal with everything an operator trace shows. */
export interface CatalogProposalTrace {
  readonly proposal: CatalogProposal;
  readonly duplicateCandidates: readonly CatalogProposalDuplicateCandidate[];
  readonly references: readonly CatalogProposalReference[];
  readonly events: readonly CatalogReviewEvent[];
}

/* -------------------------------------------------------------------------- */
/* Operator actions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Approving a proposal — the one action that mints.
 *
 * `key` is the operator's, and it is REQUIRED: ADR 0007 D1's machine key is
 * identity, is frozen after insert and is what every seed and export cites. The
 * submitter's label became {@link CatalogProposal.proposedLabel} and is offered
 * as the value's LABEL; it never becomes the key, in any code path, because the
 * submission has no field that could carry one.
 */
export interface CatalogProposalApproval {
  /** The stable machine key (ADR 0007 D1). Lower-case, namespaced, immutable. */
  readonly key: string;
  /** The base-locale label. Defaults to the proposed label when omitted. */
  readonly label?: string;
  /** Also record the submitter's verbatim spelling as an alias of the new value. */
  readonly recordSubmittedSpellingAsAlias?: boolean;
  readonly reason: string;
}

/** Linking a proposal to something that already exists (D9's "merge into existing"). */
export interface CatalogProposalMerge {
  /** The entity the proposal actually names. Its kind is the proposal's `type`. */
  readonly resolvedEntityId: string;
  readonly reason: string;
}

/** The outcome of a backfill pass, with its own vacuity floor. */
export type CatalogProposalBackfill =
  | {
      readonly outcome: 'applied';
      readonly referencesTotal: number;
      readonly referencesBackfilled: number;
      readonly referencesRemaining: number;
      readonly appliedNow: number;
    }
  | {
      /**
       * NOT `applied` with four zeroes. A pass that found nothing to do and a
       * pass over a proposal nobody is waiting on are the same numbers and
       * different facts, and the second is the one that reads as "finished".
       */
      readonly outcome: 'nothing_to_apply';
      readonly referencesTotal: number;
    };

/**
 * The publication verdict a draft carrying pending proposals gets.
 *
 * A STRING discriminant, because the backend compiles with `strict: false` and
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * discriminant without `strictNullChecks` — measured in #68 and again in #110.
 */
export type CatalogProposalPublicationVerdict =
  | { readonly verdict: 'clear' }
  | {
      readonly verdict: 'blocked';
      readonly proposalIds: readonly string[];
    }
  | {
      /** The product type version permits a local claim (ADR 0007 D7/D9). */
      readonly verdict: 'permitted_as_local_claim';
      readonly proposalIds: readonly string[];
    };
