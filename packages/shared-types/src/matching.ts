/**
 * The deterministic matching vocabulary (#58, ADR 0002 D14/D19).
 *
 * Turning a source record or a native listing variant into a canonical product
 * and variant is the one place in the commerce graph where a wrong answer is
 * worse than no answer: a false merge contaminates every product page, every
 * price comparison and every offer list derived from it, and it does so
 * silently, because a merged product looks exactly like a correct one. So this
 * vocabulary is built around three refusals rather than around a score.
 *
 * ## The three refusals, and where each one actually lives
 *
 * - **A conflicting identifier can never auto-merge.** Not by policy — by
 *   `match_decisions_blockers_auto_check`, a CHECK on the row. An outcome of
 *   `automatic_match` with a non-empty {@link MatchBlocker} list is a value the
 *   database will not store, so the rule survives a bug in every function
 *   above it.
 * - **A semantic score is never the sole authority.** {@link MatchStage}'s
 *   `semantic_assist` cannot appear without a deterministic stage having
 *   produced the candidate set first, and a candidate whose only support is a
 *   similarity carries `no_deterministic_support`, which is a blocker. The
 *   deterministic stages run identically with every semantic service disabled.
 * - **A category with no recorded qualifying benchmark run cannot auto-match.**
 *   Enablement is a `match_category_gates` row whose benchmark citation is a
 *   NOT NULL foreign key, so "enabled without a measurement" is unrepresentable
 *   rather than discouraged.
 *
 * Everything else here is explanation: reason codes an operator can read, the
 * stage that decided, and the feature values the decision was computed from.
 */

/**
 * The ordered pipeline stages (#58 matching pipeline 1–8).
 *
 * The order is the decision procedure, not documentation: each stage runs only
 * when every stage above it produced no answer, so a deterministic identifier
 * always beats a normalized attribute agreement, which always beats a title
 * similarity. `decided_stage` on a decision names the stage that produced the
 * outcome, which is what makes "why did this match" answerable without
 * re-running anything.
 */
export type MatchStage =
  /** Stage 1 — this exact source object is already linked to a canonical entity. */
  | 'existing_source_link'
  /** Stage 2 — a valid GTIN/ISBN resolved to exactly one active canonical owner. */
  | 'global_identifier'
  /** Stage 3 — an MPN or model number, scoped by an agreeing brand. */
  | 'brand_scoped_identifier'
  /** Stage 4 — normalized brand + model + variant-attribute agreement. */
  | 'normalized_attributes'
  /** Stage 5 — category-aware title/attribute candidate retrieval. */
  | 'candidate_retrieval'
  /** Stage 6 — a semantic score refined a ranking stage 5 had already produced. */
  | 'semantic_assist'
  /** Nothing was retrievable. An honest terminal, never an error. */
  | 'no_candidate';

export const MATCH_STAGES: readonly MatchStage[] = [
  'existing_source_link',
  'global_identifier',
  'brand_scoped_identifier',
  'normalized_attributes',
  'candidate_retrieval',
  'semantic_assist',
  'no_candidate',
];

/**
 * The stages that reach an answer with EVERY semantic or LLM service disabled
 * (#58 acceptance 6).
 *
 * Stated as data rather than as prose so the test that pins acceptance 6 can
 * assert the pipeline's own stage sequence against it, and so adding a stage
 * forces a decision about which half of the line it falls on.
 */
export const DETERMINISTIC_MATCH_STAGES: readonly MatchStage[] = [
  'existing_source_link',
  'global_identifier',
  'brand_scoped_identifier',
  'normalized_attributes',
  'candidate_retrieval',
  'no_candidate',
];

/**
 * What the pipeline decided to DO (#58 matching pipeline 8).
 *
 * Exactly three, and `create_new` is a RECOMMENDATION rather than an action:
 * minting a canonical product from an unmatched observation is ADR 0002 D23's
 * backfill (#60) and #59's operator tooling. This domain records that nothing
 * matched and stops, because a matcher that mints on its own doubt is a matcher
 * that manufactures the duplicates it exists to prevent.
 */
export type MatchOutcome = 'automatic_match' | 'create_new' | 'manual_review';

export const MATCH_OUTCOMES: readonly MatchOutcome[] = [
  'automatic_match',
  'create_new',
  'manual_review',
];

/**
 * What is being matched.
 *
 * A native variant is matched so its listing can materialize a native offer
 * (#57's `native_listing_links` seam); a source record is matched so an
 * external observation attaches to the same canonical variant. One pipeline,
 * because the FEATURES are the same question asked of differently-shaped input,
 * and two would drift.
 */
export type MatchSubjectKind = 'native_variant' | 'source_record';

export const MATCH_SUBJECT_KINDS: readonly MatchSubjectKind[] = [
  'native_variant',
  'source_record',
];

/**
 * The human-review state of one decision (#58 match record 7).
 *
 * `not_required` is the state of an automatic match and of a `create_new`
 * recommendation nobody has to look at; `pending` is what a `manual_review`
 * outcome opens. Approval and rejection are #59's to write — this domain
 * models the states so the queue it hands over is not a shape #59 has to
 * invent.
 */
export type MatchReviewState = 'not_required' | 'pending' | 'approved' | 'rejected';

export const MATCH_REVIEW_STATES: readonly MatchReviewState[] = [
  'not_required',
  'pending',
  'approved',
  'rejected',
];

/**
 * A fact that FORBIDS an automatic merge (#58 product/variant rules 2, 3, 5, 7).
 *
 * Every member is a reason code too (see {@link MatchReasonCode}), so the
 * operator-facing explanation always names the block — and the database
 * enforces both halves: `blockers <@ reason_codes`, and
 * `outcome <> 'automatic_match' or cardinality(blockers) = 0`. That is the
 * whole of "conflicting valid identifiers never auto-merge" (acceptance 2): it
 * is a CHECK, not a branch somebody has to keep writing.
 */
export type MatchBlocker =
  /** A VALID identifier on the subject resolves to a different canonical entity. */
  | 'conflicting_identifier'
  /** The subject's brand and the candidate's brand disagree, with no evidenced alias. */
  | 'brand_mismatch'
  /** A variant-defining axis has a value the candidate does not carry. */
  | 'variant_attribute_mismatch'
  /** The subject is a bundle and the candidate is one of its components, or vice versa. */
  | 'bundle_mismatch'
  /** The pack counts differ — a 6-pack is not the single (ADR 0002 D15). */
  | 'multipack_mismatch'
  /** The subject is an accessory FOR the candidate, not the candidate. */
  | 'accessory_mismatch'
  /** The subject is a replacement part for the candidate. */
  | 'replacement_part_mismatch'
  /** Regional models with different specifications are different variants. */
  | 'regional_variant_mismatch'
  /** The subject's category and the candidate's disagree. */
  | 'category_mismatch'
  /** An operator rejected exactly this pair, and the rejection has not been cleared. */
  | 'blocked_pair'
  /** No qualifying benchmark run has enabled automatic matching for this category. */
  | 'category_gate_closed'
  /** Two or more candidates are indistinguishable at this policy's separation. */
  | 'ambiguous_candidates'
  /** The best candidate scored below the policy's automatic threshold. */
  | 'below_auto_threshold'
  /** A required variant-defining axis is ABSENT from the subject — never invented. */
  | 'missing_required_attributes'
  /** The only support is a title or semantic similarity. Never enough on its own. */
  | 'no_deterministic_support'
  /** A variant candidate was sought before a product was resolved (rule 1). */
  | 'unresolved_product';

export const MATCH_BLOCKERS: readonly MatchBlocker[] = [
  'conflicting_identifier',
  'brand_mismatch',
  'variant_attribute_mismatch',
  'bundle_mismatch',
  'multipack_mismatch',
  'accessory_mismatch',
  'replacement_part_mismatch',
  'regional_variant_mismatch',
  'category_mismatch',
  'blocked_pair',
  'category_gate_closed',
  'ambiguous_candidates',
  'below_auto_threshold',
  'missing_required_attributes',
  'no_deterministic_support',
  'unresolved_product',
];

/**
 * A code that EXPLAINS a decision, positive or negative (#58 match record 9).
 *
 * Every {@link MatchBlocker} is one of these BY TYPE, which is what makes the
 * `blockers <@ reason_codes` containment a fact the compiler already knows
 * rather than a convention the CHECK discovers at runtime. The additional
 * members are the positive and neutral half — the things that DID support the
 * decision — because an explanation that only lists objections cannot tell an
 * operator why the pipeline chose the candidate it chose.
 */
export type MatchReasonCode =
  | MatchBlocker
  /** The exact source object was already linked; nothing was re-derived. */
  | 'existing_link_reused'
  /** A GTIN on the subject resolved to exactly one active canonical owner. */
  | 'gtin_exact_match'
  /** A brand-scoped MPN or model number resolved under an agreeing brand. */
  | 'mpn_brand_scoped_match'
  /** The subject's brand matched the candidate's brand or an evidenced alias. */
  | 'brand_agreed'
  /** Every variant-defining axis the product declares agreed. */
  | 'all_axes_agreed'
  /** The normalized model name matched exactly. */
  | 'model_name_exact'
  /** Candidates came from the category-aware title/attribute retrieval. */
  | 'title_candidate_retrieved'
  /** A semantic score reordered candidates a deterministic stage had already produced. */
  | 'semantic_reranked'
  /** Semantic scoring was available and deliberately not consulted. */
  | 'semantic_disabled'
  /** Nothing was retrievable at all. */
  | 'no_candidate_found'
  /** The subject declares no brand; brand agreement contributed nothing. */
  | 'brand_unknown'
  /** The subject carries no identifier of any scheme. */
  | 'no_identifier_present'
  /** The subject is a used listing; condition and photos stay the seller's (rule 8). */
  | 'used_condition_preserved'
  /** A merchant SKU was observed and deliberately NOT used across sources (rule 6). */
  | 'sku_scoped_to_source';

export const MATCH_REASON_CODES: readonly MatchReasonCode[] = [
  ...MATCH_BLOCKERS,
  'existing_link_reused',
  'gtin_exact_match',
  'mpn_brand_scoped_match',
  'brand_agreed',
  'all_axes_agreed',
  'model_name_exact',
  'title_candidate_retrieved',
  'semantic_reranked',
  'semantic_disabled',
  'no_candidate_found',
  'brand_unknown',
  'no_identifier_present',
  'used_condition_preserved',
  'sku_scoped_to_source',
];

/**
 * The closed feature set one candidate is scored on (#58 match record 3).
 *
 * They are REAL COLUMNS on `match_decision_candidates`, not a jsonb summary —
 * the `provider_accounts` requirements-count reasoning, applied to a matcher: a
 * `double precision` column cannot hold a sentence, and an operator asking
 * "which candidates did brand agreement rule out" needs an indexable predicate.
 * Adding a feature is a migration and a policy version, deliberately.
 *
 * **A NULL feature is UNKNOWN and is never read as zero** (#58 rule 5). It
 * lowers confidence by leaving the weight out of the denominator; it never
 * contributes a zero that would look like a measured disagreement.
 */
export type MatchFeatureName =
  | 'identifierAgreement'
  | 'brandAgreement'
  | 'modelAgreement'
  | 'attributeAgreement'
  | 'titleSimilarity'
  | 'categoryAgreement'
  | 'semanticSimilarity';

export const MATCH_FEATURE_NAMES: readonly MatchFeatureName[] = [
  'identifierAgreement',
  'brandAgreement',
  'modelAgreement',
  'attributeAgreement',
  'titleSimilarity',
  'categoryAgreement',
  'semanticSimilarity',
];

/**
 * The features that count as DETERMINISTIC support.
 *
 * A candidate with no positive value among these carries
 * `no_deterministic_support`, which is a blocker — so a title similarity and a
 * semantic score, however high, produce a review and never a merge. This is
 * #58's "semantic scoring as one feature, never the sole authority", stated as
 * the set it is rather than as a threshold somebody can raise.
 */
export const DETERMINISTIC_MATCH_FEATURES: readonly MatchFeatureName[] = [
  'identifierAgreement',
  'brandAgreement',
  'modelAgreement',
  'attributeAgreement',
];

/**
 * The lifecycle of a decision-policy version.
 *
 * `active` versions are IMMUTABLE (a database trigger refuses every economic
 * edit), the fee-schedule device: outcomes recorded under a policy have to stay
 * comparable to each other, and a policy somebody edited after the fact makes
 * every recorded confidence a number nobody can reproduce (#58 operations 2).
 */
export type MatchPolicyStatus = 'draft' | 'active' | 'superseded';

export const MATCH_POLICY_STATUSES: readonly MatchPolicyStatus[] = [
  'draft',
  'active',
  'superseded',
];

/** The lifecycle of one queued match request. The `offer_outboxes` tuple. */
export type MatchQueueStatus = 'pending' | 'processing' | 'done' | 'dead_letter';

export const MATCH_QUEUE_STATUSES: readonly MatchQueueStatus[] = [
  'pending',
  'processing',
  'done',
  'dead_letter',
];

/**
 * Why something was queued.
 *
 * Recorded so "the queue is 40,000 deep" can be told apart from "a bulk
 * re-evaluation is running", which are the same number and completely
 * different operational facts (#58 operations 5).
 */
export type MatchQueueTrigger =
  | 'catalog_write'
  | 'source_observation'
  | 'policy_activation'
  | 'operator'
  | 'bulk_sweep';

export const MATCH_QUEUE_TRIGGERS: readonly MatchQueueTrigger[] = [
  'catalog_write',
  'source_observation',
  'policy_activation',
  'operator',
  'bulk_sweep',
];

/**
 * The bounded, resumable bulk enqueuers (#58 operations 3).
 *
 * One cursor row per job, the `reconciliation_cursors` shape. A sweep ENQUEUES
 * and never matches: the queue's own dispatcher is the only thing that runs the
 * pipeline, so a bulk re-evaluation and a single catalogue write take exactly
 * the same code path and cannot diverge.
 */
export type MatchSweepJob = 'native_variants' | 'source_records';

export const MATCH_SWEEP_JOBS: readonly MatchSweepJob[] = ['native_variants', 'source_records'];

/**
 * What a candidate's rejection reason is at the CANDIDATE grain.
 *
 * A decision's `blockers` say why the DECISION could not be automatic; this
 * says why one particular candidate lost, which is the question an operator
 * reviewing a queue actually asks. `null` means the candidate was not rejected
 * — it was the selected one, or it simply scored lower.
 */
export type MatchCandidateRejection = MatchBlocker;

/**
 * One candidate as an operator sees it.
 *
 * Feature values ride along verbatim, including their NULLs: an operator
 * looking at a review needs to see that brand agreement was UNKNOWN rather than
 * zero, because those two facts justify opposite corrections.
 */
export interface MatchCandidateView {
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly rank: number;
  readonly score: number;
  readonly selected: boolean;
  readonly rejection: MatchCandidateRejection | null;
  readonly features: Readonly<Partial<Record<MatchFeatureName, number>>>;
}

/** One decision as an operator sees it (#58 match record 1–10). */
export interface MatchDecisionView {
  readonly id: string;
  readonly subjectKind: MatchSubjectKind;
  readonly subjectKey: string;
  readonly sourceRecordId: string | null;
  readonly productVariantId: string | null;
  readonly policyVersionId: string;
  readonly policyVersionKey: string;
  readonly outcome: MatchOutcome;
  readonly decidedStage: MatchStage;
  readonly confidence: number | null;
  readonly matchedCanonicalProductId: string | null;
  readonly matchedCanonicalVariantId: string | null;
  readonly reasonCodes: readonly MatchReasonCode[];
  readonly blockers: readonly MatchBlocker[];
  readonly positiveIdentifiers: readonly string[];
  readonly conflictingIdentifiers: readonly string[];
  readonly normalizedBrand: string | null;
  readonly normalizedModel: string | null;
  readonly normalizedTitle: string;
  readonly categoryKey: string | null;
  readonly reviewState: MatchReviewState;
  readonly reviewedByOxyUserId: string | null;
  readonly reviewedAt: string | null;
  readonly evaluationCount: number;
  readonly createdAt: string;
  readonly lastEvaluatedAt: string;
  readonly candidates: readonly MatchCandidateView[];
}

/**
 * The metrics a benchmark run reports, per category and per source
 * (#58 evaluation).
 *
 * Every rate is DERIVED in Postgres from the counts beside it (a generated
 * column), so a reported precision that nobody measured is not a number this
 * type can carry: the counts are the input and the rate is a function of them.
 * A denominator of zero yields `null` rather than zero — "no positives were
 * predicted" is not "precision is 0%".
 */
export interface MatchBenchmarkMetrics {
  readonly categoryKey: string;
  readonly sourceKey: string;
  readonly totalCases: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly automaticMatches: number;
  readonly manualReviews: number;
  readonly createNews: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly automaticMatchCoverage: number | null;
  readonly manualReviewRate: number | null;
}

/** A whole benchmark run, as the operator surface and the CI reporter render it. */
export interface MatchBenchmarkReport {
  readonly id: string;
  readonly policyVersionId: string;
  readonly policyVersionKey: string;
  readonly datasetVersion: string;
  readonly datasetChecksum: string;
  readonly totalCases: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly metrics: readonly MatchBenchmarkMetrics[];
}

/**
 * The observability surface (#58 operations 5).
 *
 * Queue age and ambiguity rate are the two numbers that say whether matching is
 * healthy without anyone opening a decision: a queue whose oldest pending row
 * is hours old is a stopped dispatcher, and an ambiguity rate that moves is a
 * catalogue or a policy that changed underneath it.
 */
export interface MatchQueueMetrics {
  readonly pending: number;
  readonly processing: number;
  readonly done: number;
  readonly deadLetter: number;
  /** Seconds since the OLDEST pending row was enqueued. `null` when nothing is pending. */
  readonly oldestPendingAgeSeconds: number | null;
  /** Decisions blocked by `ambiguous_candidates`, over decisions under the active policy. */
  readonly ambiguityRate: number | null;
  /** Decisions whose review is `pending`, over decisions under the active policy. */
  readonly manualReviewRate: number | null;
  readonly decisionsUnderActivePolicy: number;
}
