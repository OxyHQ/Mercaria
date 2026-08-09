/**
 * Deterministic product and variant matching — issue #58, bound by ADR 0002
 * D14/D19/D20/D22: `match_policy_versions`, `match_benchmark_runs`,
 * `match_benchmark_categories`, `match_category_gates`, `match_decisions`,
 * `match_decision_candidates`, `match_blocked_pairs`, `match_queue`,
 * `match_sweep_cursors`.
 *
 * A matcher's failure mode is not "it missed one". It is a FALSE MERGE, which
 * looks exactly like a correct match, contaminates every product page and price
 * comparison downstream of it, and is discovered by a customer. Every decision
 * in this file exists to make the wrong answer unrepresentable rather than
 * unlikely.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **A conflicting valid identifier can never auto-merge** (#58 acceptance 2).
 *    `match_decisions_blockers_auto_check` refuses a row whose `outcome` is
 *    `automatic_match` while `blockers` is non-empty, and
 *    `match_decisions_conflicting_identifier_check` refuses a row that records a
 *    conflicting identifier WITHOUT the matching blocker. Two CHECKs on one row,
 *    so the rule holds against a bug anywhere above them and against a writer
 *    that never went through the service.
 * 2. **The blocker set is the SAME mechanism for every product/variant rule.**
 *    Brand mismatch, bundle/multipack/accessory confusion, a missing required
 *    axis, an operator's rejected pair and a closed category gate are all
 *    members of `MATCH_BLOCKERS`, so rules 2, 3, 5 and 7 are one CHECK rather
 *    than four branches somebody has to keep writing. Adding a rule is adding a
 *    blocker.
 * 3. **A category with no recorded qualifying benchmark run cannot have
 *    automatic matching enabled** (#58 acceptance 5). `match_category_gates`
 *    cites its benchmark by a NOT NULL foreign key, and the citation is a
 *    COMPOSITE key carrying the policy version — so a gate citing a run measured
 *    under a DIFFERENT policy is refused by the database, not by a comparison in
 *    a service.
 * 4. **A reported metric is a function of counts nobody typed.** Every rate on
 *    `match_benchmark_categories` is `GENERATED ALWAYS ... STORED` from the
 *    confusion-matrix counts beside it. A precision that was not measured is not
 *    a value these tables can hold, and a zero denominator yields NULL rather
 *    than zero — "nothing was predicted positive" is not "precision is 0%".
 * 5. **Re-evaluation is idempotent and comparable across policies.**
 *    `UNIQUE(evaluation_key, policy_version_id)` means one decision per subject
 *    per policy: re-running converges on the same row (bumping
 *    `evaluation_count` and `last_evaluated_at`), and a NEW policy version
 *    produces a NEW row beside the old one, which is what makes outcomes
 *    comparable (#58 operations 1 and 2).
 *
 * ## What is deliberately NOT here
 *
 * - **No `jsonb`.** Feature values are seven real `double precision` columns on
 *   the candidate, reason codes and blockers are `text[]` with element CHECKs
 *   rendered from the shared-types tuples, and the confusion matrix is four
 *   integers. The `provider_accounts` requirements-count reasoning: an integer
 *   column cannot hold a sentence, and an operator asking "which candidates did
 *   brand disagreement rule out" needs an indexable predicate.
 * - **No `canonical_variants.product_id` copy.** `match_decisions` carries BOTH
 *   `matched_canonical_product_id` and `matched_canonical_variant_id`, and that
 *   is not a denormalization: rule 1 makes product identity a SEPARATE stage
 *   from variant identity, so a decision that resolved the product and failed at
 *   the variant is a real, common state that a single column could not record.
 *   The CHECK states the dependency in the direction rule 1 asserts.
 * - **No auto-mint of a canonical product.** `create_new` is a RECOMMENDATION.
 *   Minting is ADR 0002 D23's backfill (#60) and #59's operator tooling; a
 *   matcher that mints on its own doubt manufactures the duplicates it exists to
 *   prevent.
 * - **No second review table.** `match_decisions.review_state` is #59's inbox,
 *   modelled here so the queue handed over is not a shape #59 has to invent.
 *   The four-eyes device (`relationship_reviews`) is deliberately NOT copied: a
 *   match correction is reversible by another correction, so the two-operator
 *   cost buys nothing a badge's irreversibility buys.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  MATCH_BLOCKERS,
  MATCH_OUTCOMES,
  MATCH_POLICY_STATUSES,
  MATCH_QUEUE_STATUSES,
  MATCH_QUEUE_TRIGGERS,
  MATCH_REASON_CODES,
  MATCH_REVIEW_STATES,
  MATCH_STAGES,
  MATCH_SUBJECT_KINDS,
  MATCH_SWEEP_JOBS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { productVariants } from './catalog';
import { sourceRecords } from './provenance';

/**
 * The longest error a queue row may carry, and the longest note an operator may
 * attach. The `offer_outboxes` bound, for the same reason: an unbounded text
 * column on a row a retry loop writes is how a table grows without anybody
 * choosing to grow it.
 */
export const MATCH_MAX_TEXT_LENGTH = 2_000;

/**
 * `match_policy_versions` — the decision policy, versioned and immutable once
 * active (#58 operations 2, acceptance 5).
 *
 * ## Why the thresholds are columns rather than constants
 *
 * A confidence recorded on a decision is only meaningful against the thresholds
 * that produced it. Constants in code make every historical decision
 * unreproducible the moment somebody tunes one — the number stays on the row and
 * the rule that turned it into an outcome is gone. Storing them here, immutably,
 * is what makes "outcomes can be compared" (operations 2) true rather than
 * aspirational: two decisions under one `policy_version_id` were judged by
 * exactly the same rule, and the rule is still readable.
 *
 * ## Immutability is a TRIGGER, not a convention
 *
 * `match_policy_versions_immutable` (in this domain's migration, the
 * `fee_schedule_versions` and `product_identifiers` precedent) refuses every
 * economic edit once `status = 'active'`, permitting only the status transition
 * to `superseded`. A policy edited after the fact would silently re-interpret
 * every benchmark run that cited it, which is precisely the measurement
 * acceptance 5 rests on.
 *
 * ## The weights and the confidence they produce
 *
 * Confidence is the weighted mean of the features that HAVE a value:
 * `Σ(wᶠ · vᶠ) / Σ(wᶠ)` over features where `vᶠ IS NOT NULL`. A missing feature
 * leaves its weight out of the denominator, so it lowers nothing and invents
 * nothing — #58 rule 5, "missing attributes reduce confidence rather than being
 * invented", is that arithmetic: an unknown brand cannot push a score up, and it
 * cannot fabricate a disagreement either.
 */
export const matchPolicyVersions = pgTable(
  'match_policy_versions',
  {
    id: generatedId(),
    /**
     * The human-readable version key an operator quotes and a decision records
     * — `2026-08-v1`. Unique FOREVER, tombstones included: a key reused for a
     * different rule set makes every recorded outcome ambiguous.
     */
    versionKey: text().notNull(),
    status: text({ enum: asEnumValues(MATCH_POLICY_STATUSES) }).notNull().default('draft'),
    description: text().notNull(),

    // ── The decision thresholds ──────────────────────────────────────────────
    /** At or above this confidence a candidate may be matched AUTOMATICALLY. */
    autoMinConfidence: doublePrecision().notNull(),
    /** At or above this confidence but below the auto bar, a REVIEW is opened. */
    reviewMinConfidence: doublePrecision().notNull(),
    /**
     * The margin the best candidate must beat the runner-up by.
     *
     * Without it, two candidates at 0.97 and 0.969 produce an automatic match on
     * a coin flip. Below the margin the decision carries `ambiguous_candidates`,
     * which is a blocker, so the pair goes to review together.
     */
    minCandidateSeparation: doublePrecision().notNull(),
    /** Candidates retrieved per stage. A bound, so one pathological title cannot scan a catalogue. */
    maxCandidates: integer().notNull(),
    /** Below this, a title similarity is not even worth carrying as a feature. */
    minTitleSimilarity: doublePrecision().notNull(),

    // ── The feature weights (the closed set, one column each) ────────────────
    weightIdentifier: doublePrecision().notNull(),
    weightBrand: doublePrecision().notNull(),
    weightModel: doublePrecision().notNull(),
    weightAttribute: doublePrecision().notNull(),
    weightTitle: doublePrecision().notNull(),
    weightCategory: doublePrecision().notNull(),
    /**
     * The semantic feature's weight.
     *
     * It can be zero and it can be positive; what it can NEVER be is sufficient
     * on its own, because a candidate with no positive deterministic feature
     * carries `no_deterministic_support` — a blocker — whatever this weight is.
     * That is why the ceiling here is a sanity bound and not the mechanism.
     */
    weightSemantic: doublePrecision().notNull().default(0),
    /**
     * Whether this policy consults a semantic scorer at all.
     *
     * Three independent levers turn semantics off (#58 acceptance 6): this
     * column, `config.matching.semanticEnabled`, and the absence of a registered
     * scorer — which is the default. The deterministic stages are identical in
     * every combination, and a test runs the whole pipeline with all three off.
     */
    semanticEnabled: boolean().notNull().default(false),

    // ── The benchmark bar a category gate must clear ─────────────────────────
    /** The precision a category's benchmark must reach before it may auto-match. */
    minBenchmarkPrecision: doublePrecision().notNull(),
    /** The labelled positive cases a category needs before its precision means anything. */
    minBenchmarkSamples: integer().notNull(),

    activatedAt: timestamptz(),
    supersededAt: timestamptz(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    createdByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('match_policy_versions_status_check', t.status, MATCH_POLICY_STATUSES),
    check('match_policy_versions_version_key_check', sql`btrim(${t.versionKey}) <> ''`),
    check('match_policy_versions_description_check', sql`btrim(${t.description}) <> ''`),
    check('match_policy_versions_actor_check', sql`btrim(${t.createdByOxyUserId}) <> ''`),
    // Every threshold is a probability, and the review bar cannot sit ABOVE the
    // automatic bar: that would make a band where a candidate is good enough to
    // merge and not good enough to review, which is not a state anybody meant.
    check(
      'match_policy_versions_thresholds_check',
      sql`${t.autoMinConfidence} > 0 and ${t.autoMinConfidence} <= 1
          and ${t.reviewMinConfidence} > 0 and ${t.reviewMinConfidence} <= 1
          and ${t.reviewMinConfidence} <= ${t.autoMinConfidence}
          and ${t.minCandidateSeparation} >= 0 and ${t.minCandidateSeparation} <= 1
          and ${t.minTitleSimilarity} >= 0 and ${t.minTitleSimilarity} <= 1`,
    ),
    check('match_policy_versions_max_candidates_check', sql`${t.maxCandidates} between 1 and 500`),
    check(
      'match_policy_versions_weights_check',
      sql`${t.weightIdentifier} >= 0 and ${t.weightBrand} >= 0 and ${t.weightModel} >= 0
          and ${t.weightAttribute} >= 0 and ${t.weightTitle} >= 0 and ${t.weightCategory} >= 0
          and ${t.weightSemantic} >= 0
          and (${t.weightIdentifier} + ${t.weightBrand} + ${t.weightModel}
               + ${t.weightAttribute} + ${t.weightTitle} + ${t.weightCategory}) > 0`,
    ),
    /**
     * Launch thresholds favour precision (#58 evaluation), and the FLOOR is in
     * the schema so a tuning pass cannot quietly drop below it. 0.95 is not a
     * target — it is the point under which a category's automatic matching is
     * doing more damage than the review queue it avoids.
     */
    check(
      'match_policy_versions_benchmark_bar_check',
      sql`${t.minBenchmarkPrecision} >= 0.95 and ${t.minBenchmarkPrecision} <= 1
          and ${t.minBenchmarkSamples} >= 20`,
    ),
    check(
      'match_policy_versions_activation_check',
      sql`(${t.status} = 'draft') = (${t.activatedAt} is null)`,
    ),
    check(
      'match_policy_versions_supersession_check',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    uniqueIndex('match_policy_versions_key_key').on(t.versionKey),
    /**
     * ONE active policy at a time. The matcher asks "what is the policy" and a
     * second answer is not a tie to break — it is two different sets of
     * decisions being written into one table under two rules.
     */
    uniqueIndex('match_policy_versions_active_key')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
    index('match_policy_versions_status_idx').on(t.status, t.createdAt.desc()),
  ],
);

/**
 * `match_benchmark_runs` — one execution of the versioned labelled dataset
 * against one policy version (#58 evaluation).
 *
 * Append-only: there is no `updated_at` and the migration's trigger refuses
 * UPDATE and DELETE. A benchmark that can be edited is a benchmark a gate cannot
 * rest on, and `match_category_gates` rests on exactly this.
 *
 * `dataset_checksum` is the digest of the labelled cases as they were when the
 * run executed. A gate cites a run; a run cites a dataset; the dataset's content
 * is pinned by its hash — so "which cases produced this precision" survives
 * every later edit to the dataset, which is what makes the number reproducible
 * rather than merely recorded.
 */
export const matchBenchmarkRuns = pgTable(
  'match_benchmark_runs',
  {
    id: generatedId(),
    policyVersionId: text()
      .notNull()
      .references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),
    /** The dataset's own version, bumped whenever a case is added or relabelled. */
    datasetVersion: text().notNull(),
    /** sha-256 hex of the labelled cases, in canonical order. */
    datasetChecksum: text().notNull(),
    totalCases: integer().notNull(),
    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),
    /** An Oxy account id — no foreign key. NULL for a run executed by CI. */
    startedByOxyUserId: text(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check('match_benchmark_runs_dataset_version_check', sql`btrim(${t.datasetVersion}) <> ''`),
    // The same shape check `source_records.content_hash` carries: a checksum that
    // is not a sha-256 hex digest is not one this codebase produced.
    check('match_benchmark_runs_checksum_check', sql`${t.datasetChecksum} ~ '^[0-9a-f]{64}$'`),
    check('match_benchmark_runs_total_cases_check', sql`${t.totalCases} >= 0`),
    check(
      'match_benchmark_runs_completion_check',
      sql`${t.completedAt} is null or ${t.completedAt} >= ${t.startedAt}`,
    ),
    check(
      'match_benchmark_runs_note_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(MATCH_MAX_TEXT_LENGTH))}`,
    ),
    index('match_benchmark_runs_policy_idx').on(t.policyVersionId, t.startedAt.desc()),
    /**
     * The composite key `match_benchmark_categories` cites through, declared as
     * a table CONSTRAINT rather than a unique INDEX: a composite foreign key
     * needs its referenced columns unique at the moment the constraint is added,
     * and drizzle-kit emits table constraints with the CREATE TABLE while it
     * emits indexes afterwards. A unique index would satisfy Postgres and lose
     * the race in the generated migration.
     */
    unique('match_benchmark_runs_identity_key').on(t.id, t.policyVersionId),
  ],
);

/**
 * `match_benchmark_categories` — the per-category, per-source metrics of one run
 * (#58 evaluation: "Report precision, recall, automatic-match coverage and
 * manual-review rate by category and source").
 *
 * ## Every rate is GENERATED, and that is the point
 *
 * The four counts are what the runner measured. The four rates are functions of
 * them, computed by Postgres and unwritable by any path — route, service,
 * backfill or `psql`. So a category gate citing "precision 0.99" is citing
 * arithmetic over a confusion matrix somebody would have had to fabricate whole,
 * rather than a number a caller could pass. `NULLIF(denominator, 0)` yields NULL
 * on an empty denominator, because "nothing was predicted positive" and
 * "precision is zero" are different facts and a gate must not confuse them.
 *
 * Division is IMMUTABLE, so it is legal in a stored generated column — unlike
 * the `to_tsvector`/`unaccent` traps CONVENTIONS.md records.
 */
export const matchBenchmarkCategories = pgTable(
  'match_benchmark_categories',
  {
    id: generatedId(),
    runId: text()
      .notNull()
      .references(() => matchBenchmarkRuns.id, { onDelete: 'cascade' }),
    /**
     * Denormalized from the run so a gate's composite citation can carry it.
     * Kept in agreement by the composite foreign key below, not by the writer:
     * `(run_id, policy_version_id)` must exist on `match_benchmark_runs`, so a
     * row claiming a policy its run did not use cannot be inserted.
     */
    policyVersionId: text().notNull(),
    /**
     * The category this slice measures. A category SLUG rather than a
     * `categories.id`: a benchmark case is written against a taxonomy position,
     * and a run has to stay readable after a category row is renamed or merged.
     * `'*'` is the whole-dataset slice.
     */
    categoryKey: text().notNull(),
    /** The source this slice measures — a connector id, a feed name, or `'*'`. */
    sourceKey: text().notNull(),

    totalCases: integer().notNull(),
    truePositives: integer().notNull(),
    falsePositives: integer().notNull(),
    falseNegatives: integer().notNull(),
    trueNegatives: integer().notNull(),
    automaticMatches: integer().notNull(),
    manualReviews: integer().notNull(),
    createNews: integer().notNull(),

    /** TP / (TP + FP). The number a category gate must clear. */
    precision: doublePrecision().generatedAlwaysAs(
      (): SQL =>
        sql`${matchBenchmarkCategories.truePositives}::double precision
            / nullif(${matchBenchmarkCategories.truePositives} + ${matchBenchmarkCategories.falsePositives}, 0)`,
    ),
    /** TP / (TP + FN). */
    recall: doublePrecision().generatedAlwaysAs(
      (): SQL =>
        sql`${matchBenchmarkCategories.truePositives}::double precision
            / nullif(${matchBenchmarkCategories.truePositives} + ${matchBenchmarkCategories.falseNegatives}, 0)`,
    ),
    /** Automatic matches over all cases — how much of the work the matcher took. */
    automaticMatchCoverage: doublePrecision().generatedAlwaysAs(
      (): SQL =>
        sql`${matchBenchmarkCategories.automaticMatches}::double precision
            / nullif(${matchBenchmarkCategories.totalCases}, 0)`,
    ),
    /** Reviews over all cases — what the matcher handed to a person. */
    manualReviewRate: doublePrecision().generatedAlwaysAs(
      (): SQL =>
        sql`${matchBenchmarkCategories.manualReviews}::double precision
            / nullif(${matchBenchmarkCategories.totalCases}, 0)`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    check('match_benchmark_categories_category_check', sql`btrim(${t.categoryKey}) <> ''`),
    check('match_benchmark_categories_source_check', sql`btrim(${t.sourceKey}) <> ''`),
    check(
      'match_benchmark_categories_counts_check',
      sql`${t.totalCases} >= 0 and ${t.truePositives} >= 0 and ${t.falsePositives} >= 0
          and ${t.falseNegatives} >= 0 and ${t.trueNegatives} >= 0
          and ${t.automaticMatches} >= 0 and ${t.manualReviews} >= 0 and ${t.createNews} >= 0`,
    ),
    /**
     * The outcome counts partition the cases: every case ended as exactly one of
     * automatic, review or create-new. A slice whose three do not sum to its
     * total is a run that lost cases, and a precision computed over a lost set
     * is a number a gate must never see.
     */
    check(
      'match_benchmark_categories_partition_check',
      sql`${t.automaticMatches} + ${t.manualReviews} + ${t.createNews} = ${t.totalCases}`,
    ),
    // Likewise the confusion matrix: every case is one cell of it.
    check(
      'match_benchmark_categories_matrix_check',
      sql`${t.truePositives} + ${t.falsePositives} + ${t.falseNegatives} + ${t.trueNegatives}
          = ${t.totalCases}`,
    ),
    foreignKey({
      name: 'match_benchmark_categories_run_policy_fk',
      columns: [t.runId, t.policyVersionId],
      foreignColumns: [matchBenchmarkRuns.id, matchBenchmarkRuns.policyVersionId],
    }).onDelete('cascade'),
    uniqueIndex('match_benchmark_categories_slice_key').on(t.runId, t.categoryKey, t.sourceKey),
    /** The composite key a gate cites. A CONSTRAINT, for the reason stated on the run's. */
    unique('match_benchmark_categories_identity_key').on(t.id, t.policyVersionId),
    index('match_benchmark_categories_category_idx').on(t.categoryKey, t.sourceKey),
  ],
);

/**
 * `match_category_gates` — which categories may match AUTOMATICALLY, and the
 * measurement that permits it (#58 acceptance 5).
 *
 * ## The citation is a NOT NULL composite foreign key, and that IS the rule
 *
 * "A category with no recorded qualifying benchmark run cannot have automatic
 * matching enabled" is normally written as a check in whatever service opens the
 * gate. Here it is the shape of the row: `benchmark_category_id` is NOT NULL, so
 * a gate with no measurement cannot exist; and the reference carries
 * `policy_version_id` too, so a gate citing a run measured under a DIFFERENT
 * policy is refused by Postgres rather than by a comparison somebody has to
 * remember. What the SERVICE still enforces — because it is a cross-table
 * comparison and a CHECK may not contain a subquery — is that the cited slice's
 * generated `precision` cleared the policy's `min_benchmark_precision` on a
 * sample of at least `min_benchmark_samples`. Both halves are pinned by realdb
 * cases.
 *
 * A gate is CLOSED by default, everywhere: there is no row until somebody opens
 * one, and `resolveCategoryGate` answers "closed" for an absent row. So a new
 * category, a new policy version and a fresh database all start with automatic
 * matching off, and turning it on is a deliberate, audited, measured act.
 */
export const matchCategoryGates = pgTable(
  'match_category_gates',
  {
    id: generatedId(),
    policyVersionId: text()
      .notNull()
      .references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),
    categoryKey: text().notNull(),
    /** The measurement that permits this gate. NOT NULL — see the note above. */
    benchmarkCategoryId: text().notNull(),
    /** The precision the cited slice actually reported, snapshotted for the audit trail. */
    observedPrecision: doublePrecision().notNull(),
    /** The positive sample the cited slice was measured over. */
    observedSamples: integer().notNull(),
    /** An Oxy account id — no foreign key. */
    enabledByOxyUserId: text().notNull(),
    enabledAt: timestamptz().notNull(),
    reason: text().notNull(),
    disabledAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    disabledByOxyUserId: text(),
    disableReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('match_category_gates_category_check', sql`btrim(${t.categoryKey}) <> ''`),
    check('match_category_gates_actor_check', sql`btrim(${t.enabledByOxyUserId}) <> ''`),
    check('match_category_gates_reason_check', sql`btrim(${t.reason}) <> ''`),
    check(
      'match_category_gates_observed_check',
      sql`${t.observedPrecision} >= 0 and ${t.observedPrecision} <= 1 and ${t.observedSamples} >= 0`,
    ),
    // A closure is attributable or it did not happen — the `native_listing_links`
    // revocation rule, for the same reason: an unaudited change to what matches
    // automatically is not one anybody can review.
    check(
      'match_category_gates_disabled_state_check',
      sql`${t.disabledAt} is null
          or (${t.disabledByOxyUserId} is not null and btrim(${t.disableReason}) <> '')`,
    ),
    foreignKey({
      name: 'match_category_gates_benchmark_fk',
      columns: [t.benchmarkCategoryId, t.policyVersionId],
      foreignColumns: [matchBenchmarkCategories.id, matchBenchmarkCategories.policyVersionId],
    }).onDelete('restrict'),
    /** ONE open gate per (policy, category). History is closed rows. */
    uniqueIndex('match_category_gates_open_key')
      .on(t.policyVersionId, t.categoryKey)
      .where(sql`${t.disabledAt} is null`),
    index('match_category_gates_category_idx').on(t.categoryKey),
  ],
);

/**
 * `match_decisions` — the auditable record of one evaluation (#58 match record
 * 1–10).
 *
 * ## The subject: two real foreign keys, one generated evaluation key
 *
 * A native `product_variants` row and a `source_records` row are both matched by
 * the same pipeline, and both key spaces live in THIS database — so they are two
 * nullable FKs plus a CHECK, the `product_identifiers` grain device, rather than
 * a polymorphic `{kind, id}` pair. `evaluation_key` collapses them for the
 * idempotency unique, because Postgres treats NULLs as distinct and a plain
 * multi-column unique over two nullable columns would let duplicates through
 * (the `commerce_relationships.endpoint_key` device).
 *
 * ## `subject_key` is NOT a second representation of the foreign keys
 *
 * It is the STABLE identity of the thing being matched, which for a source
 * record is `(source_id, external_type, external_id)` — one join away — and for
 * a native variant is the variant id. It exists because a blocked pair has to
 * survive re-observation: a source that re-publishes a product mints a NEW
 * `source_records` row (the content-hash unique, D19), so a rejection keyed on
 * the observation would evaporate on the next crawl, which is exactly the
 * "rejected matches are not proposed repeatedly" failure acceptance 4 forbids.
 * It is a plain column rather than a generated one because a generated
 * expression cannot read another table.
 *
 * ## Product before variant, in the row shape
 *
 * `matched_canonical_product_id` may be set while
 * `matched_canonical_variant_id` is NULL — the product was identified and the
 * variant was not, which is the normal state of a listing whose colour nobody
 * declared. The reverse is refused by CHECK: a variant match without a resolved
 * product would be rule 1 run backwards.
 */
export const matchDecisions = pgTable(
  'match_decisions',
  {
    id: generatedId(),
    subjectKind: text({ enum: asEnumValues(MATCH_SUBJECT_KINDS) }).notNull(),
    /** The stable identity of the subject. See the note above. */
    subjectKey: text().notNull(),
    /** RESTRICT: an observation is never deleted under a decision it produced (D19). */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** CASCADE from the native side (D20): a seller's delete is never blocked. */
    productVariantId: text().references(() => productVariants.id, { onDelete: 'cascade' }),
    policyVersionId: text()
      .notNull()
      .references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),

    outcome: text({ enum: asEnumValues(MATCH_OUTCOMES) }).notNull(),
    decidedStage: text({ enum: asEnumValues(MATCH_STAGES) }).notNull(),
    /**
     * 0–1, and NULL for a DETERMINISTIC outcome.
     *
     * The `source_links` and `native_listing_links` semantics, unchanged: NULL
     * means certainty by construction and OUTRANKS every number. A GTIN that
     * resolved to exactly one owner is not 0.99 confident; it is an identifier
     * match, and putting a number on it invites a threshold to be applied to a
     * fact no threshold governs.
     */
    confidence: doublePrecision(),

    matchedCanonicalProductId: text().references(() => canonicalProducts.id, {
      onDelete: 'restrict',
    }),
    matchedCanonicalVariantId: text().references(() => canonicalVariants.id, {
      onDelete: 'restrict',
    }),

    /** The full explanation, positive and negative (#58 match record 9). */
    reasonCodes: text().array().notNull().default(sql`'{}'::text[]`),
    /** The subset that FORBIDS an automatic merge. Non-empty ⇒ never automatic. */
    blockers: text().array().notNull().default(sql`'{}'::text[]`),
    /** Normalized identifiers that AGREED with the selected candidate — `gtin:00000…`. */
    positiveIdentifiers: text().array().notNull().default(sql`'{}'::text[]`),
    /** VALID identifiers on the subject that resolved to a DIFFERENT entity. */
    conflictingIdentifiers: text().array().notNull().default(sql`'{}'::text[]`),

    /** The normalized fields the decision was computed from (#58 match record 3). */
    normalizedBrand: text(),
    normalizedModel: text(),
    normalizedTitle: text().notNull(),
    /** The taxonomy position the retrieval and the category gate both used. */
    categoryKey: text(),
    /** How many candidates the pipeline actually considered, including rejected ones. */
    candidateCount: integer().notNull().default(0),

    reviewState: text({ enum: asEnumValues(MATCH_REVIEW_STATES) }).notNull().default('not_required'),
    /** An Oxy account id — no foreign key. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
    reviewNote: text(),

    /** How many times this subject has been evaluated under this policy. */
    evaluationCount: integer().notNull().default(1),
    lastEvaluatedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The idempotency key. `coalesce` collapses the two nullable subject columns
     * into one non-null value so the unique below actually constrains — the
     * `offers.source_key` device, for the identical NULL-distinctness reason.
     */
    evaluationKey: text().generatedAlwaysAs(
      (): SQL =>
        sql`coalesce('src:' || ${matchDecisions.sourceRecordId}, 'var:' || ${matchDecisions.productVariantId})`,
    ),
  },
  (t) => [
    checkOneOf('match_decisions_subject_kind_check', t.subjectKind, MATCH_SUBJECT_KINDS),
    checkOneOf('match_decisions_outcome_check', t.outcome, MATCH_OUTCOMES),
    checkOneOf('match_decisions_stage_check', t.decidedStage, MATCH_STAGES),
    checkOneOf('match_decisions_review_state_check', t.reviewState, MATCH_REVIEW_STATES),
    checkEveryElementOf('match_decisions_reason_codes_check', t.reasonCodes, MATCH_REASON_CODES),
    checkEveryElementOf('match_decisions_blockers_check', t.blockers, MATCH_BLOCKERS),
    /**
     * The subject shape: exactly one foreign key, and it must agree with the
     * declared kind. The `else false` branch is load-bearing for the reason
     * `offers_kind_shape_check`'s is — a kind added to the tuple without a
     * branch here fails its first write rather than storing an unconstrained row.
     */
    check(
      'match_decisions_subject_shape_check',
      sql`case ${t.subjectKind}
            when 'source_record' then ${t.sourceRecordId} is not null and ${t.productVariantId} is null
            when 'native_variant' then ${t.productVariantId} is not null and ${t.sourceRecordId} is null
            else false
          end`,
    ),
    check('match_decisions_subject_key_check', sql`btrim(${t.subjectKey}) <> ''`),
    /**
     * ACCEPTANCE 2, AS A CHECK. An automatic match with ANY blocker is a row
     * Postgres refuses — so a conflicting GTIN, a brand disagreement, a bundle
     * mistaken for its component, a rejected pair and a closed category gate all
     * stop an automatic merge through ONE mechanism that no service bug can walk
     * around.
     */
    check(
      'match_decisions_blockers_auto_check',
      sql`${t.outcome} <> 'automatic_match' or cardinality(${t.blockers}) = 0`,
    ),
    /**
     * A conflicting identifier is never recordable WITHOUT its blocker. Without
     * this, a writer could store the conflict in the audit array, omit it from
     * `blockers`, and pass the CHECK above — the audit trail would say
     * "conflicting" and the outcome would say "merged".
     */
    check(
      'match_decisions_conflicting_identifier_check',
      sql`cardinality(${t.conflictingIdentifiers}) = 0
          or 'conflicting_identifier' = any(${t.blockers})`,
    ),
    /** Every blocker is also in the explanation, so a refusal always names itself. */
    check('match_decisions_blockers_explained_check', sql`${t.blockers} <@ ${t.reasonCodes}`),
    /**
     * Rule 1, in the row: a variant match implies a resolved product. The
     * converse is deliberately permitted — resolving a product and failing at
     * the variant is the ordinary outcome for a listing that declared no axes.
     */
    check(
      'match_decisions_grain_order_check',
      sql`${t.matchedCanonicalVariantId} is null or ${t.matchedCanonicalProductId} is not null`,
    ),
    /** An automatic match matched something; the outcome and the result agree. */
    check(
      'match_decisions_outcome_shape_check',
      sql`case ${t.outcome}
            when 'automatic_match' then ${t.matchedCanonicalProductId} is not null
            when 'create_new' then ${t.matchedCanonicalProductId} is null and ${t.matchedCanonicalVariantId} is null
            else true
          end`,
    ),
    check(
      'match_decisions_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    /**
     * A DETERMINISTIC stage records NULL confidence, and a heuristic stage
     * records a number. Two representations of certainty would let a reviewer's
     * filter on `confidence < 0.9` silently skip every deterministic decision or
     * every heuristic one, depending on which convention the writer followed.
     */
    check(
      'match_decisions_confidence_stage_check',
      sql`case
            when ${t.decidedStage} in ('existing_source_link', 'global_identifier', 'brand_scoped_identifier')
              then ${t.confidence} is null
            when ${t.decidedStage} = 'no_candidate' then ${t.confidence} is null
            else true
          end`,
    ),
    /** A review verdict is attributable, or it did not happen. */
    check(
      'match_decisions_review_attribution_check',
      sql`${t.reviewState} not in ('approved', 'rejected')
          or (${t.reviewedByOxyUserId} is not null and ${t.reviewedAt} is not null)`,
    ),
    /** A review is only OPEN on a decision that asked for one. */
    check(
      'match_decisions_review_opening_check',
      sql`${t.reviewState} = 'not_required' or ${t.outcome} = 'manual_review'`,
    ),
    check(
      'match_decisions_counts_check',
      sql`${t.evaluationCount} >= 1 and ${t.candidateCount} >= 0`,
    ),
    check(
      'match_decisions_review_note_check',
      sql`${t.reviewNote} is null or length(${t.reviewNote}) <= ${sql.raw(String(MATCH_MAX_TEXT_LENGTH))}`,
    ),
    /** ONE decision per subject per policy — idempotent re-evaluation (operations 1). */
    uniqueIndex('match_decisions_evaluation_key').on(t.evaluationKey, t.policyVersionId),
    /** Every decision ever made about this thing, across observations and policies. */
    index('match_decisions_subject_idx').on(t.subjectKey, t.createdAt.desc()),
    /** #59's inbox, and the manual-review-rate metric. */
    index('match_decisions_review_idx')
      .on(t.reviewState, t.createdAt)
      .where(sql`${t.reviewState} = 'pending'`),
    index('match_decisions_policy_outcome_idx').on(t.policyVersionId, t.outcome),
    index('match_decisions_matched_variant_idx')
      .on(t.matchedCanonicalVariantId)
      .where(sql`${t.matchedCanonicalVariantId} is not null`),
    /** The ambiguity-rate metric scans exactly this (operations 5). */
    index('match_decisions_blockers_idx').using('gin', t.blockers),
  ],
);

/**
 * `match_decision_candidates` — every canonical entity the pipeline CONSIDERED,
 * with the feature values it was scored on (#58 match record 2 and 3).
 *
 * Rejected candidates are stored, not discarded. "Why did it not pick the other
 * one" is the question a reviewer actually asks, and a decision that recorded
 * only its winner cannot answer it — which makes every review a re-derivation
 * against a catalogue that has since moved.
 *
 * The seven feature columns are the closed set from
 * `MATCH_FEATURE_NAMES`. A NULL is UNKNOWN and is never read as zero: the
 * confidence arithmetic leaves an unknown feature's weight out of the
 * denominator entirely, so a missing brand lowers the score by widening the
 * uncertainty rather than by asserting a disagreement nobody observed (#58
 * rule 5).
 */
export const matchDecisionCandidates = pgTable(
  'match_decision_candidates',
  {
    id: generatedId(),
    decisionId: text()
      .notNull()
      .references(() => matchDecisions.id, { onDelete: 'cascade' }),
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    /** 1-based, ordered by score descending. Ties are broken by canonical id. */
    rank: integer().notNull(),
    score: doublePrecision().notNull(),
    selected: boolean().notNull().default(false),
    /** Why this candidate lost, when it lost for a NAMED reason rather than on score. */
    rejection: text({ enum: asEnumValues(MATCH_BLOCKERS) }),

    identifierAgreement: doublePrecision(),
    brandAgreement: doublePrecision(),
    modelAgreement: doublePrecision(),
    attributeAgreement: doublePrecision(),
    titleSimilarity: doublePrecision(),
    categoryAgreement: doublePrecision(),
    semanticSimilarity: doublePrecision(),

    createdAt: createdAt(),
  },
  (t) => [
    check(
      'match_decision_candidates_target_check',
      sql`${t.canonicalProductId} is not null or ${t.canonicalVariantId} is not null`,
    ),
    check('match_decision_candidates_rank_check', sql`${t.rank} >= 1`),
    check(
      'match_decision_candidates_score_check',
      sql`${t.score} >= 0 and ${t.score} <= 1`,
    ),
    checkOneOf('match_decision_candidates_rejection_check', t.rejection, MATCH_BLOCKERS),
    /** A SELECTED candidate cannot simultaneously be a rejected one. */
    check(
      'match_decision_candidates_selection_check',
      sql`not ${t.selected} or ${t.rejection} is null`,
    ),
    // Every feature is a probability or unknown. The seven are checked together
    // because they are one closed set and a per-column CHECK invites the eighth
    // to arrive without one.
    check(
      'match_decision_candidates_features_check',
      sql`(${t.identifierAgreement} is null or (${t.identifierAgreement} >= 0 and ${t.identifierAgreement} <= 1))
          and (${t.brandAgreement} is null or (${t.brandAgreement} >= 0 and ${t.brandAgreement} <= 1))
          and (${t.modelAgreement} is null or (${t.modelAgreement} >= 0 and ${t.modelAgreement} <= 1))
          and (${t.attributeAgreement} is null or (${t.attributeAgreement} >= 0 and ${t.attributeAgreement} <= 1))
          and (${t.titleSimilarity} is null or (${t.titleSimilarity} >= 0 and ${t.titleSimilarity} <= 1))
          and (${t.categoryAgreement} is null or (${t.categoryAgreement} >= 0 and ${t.categoryAgreement} <= 1))
          and (${t.semanticSimilarity} is null or (${t.semanticSimilarity} >= 0 and ${t.semanticSimilarity} <= 1))`,
    ),
    uniqueIndex('match_decision_candidates_rank_key').on(t.decisionId, t.rank),
    /** At most ONE selected candidate per decision. */
    uniqueIndex('match_decision_candidates_selected_key')
      .on(t.decisionId)
      .where(sql`${t.selected}`),
    index('match_decision_candidates_variant_idx')
      .on(t.canonicalVariantId)
      .where(sql`${t.canonicalVariantId} is not null`),
  ],
);

/**
 * `match_blocked_pairs` — the negative link (#58 match record 10, acceptance 4).
 *
 * "Rejected pairs stay rejected until evidence or policy changes." The two
 * halves of that sentence are two different mechanisms and both are here:
 *
 * - **Until evidence changes.** The block is keyed on the STABLE `subject_key`,
 *   not on a `source_records` id, so re-crawling the same external product
 *   (which mints a new observation row) does not resurrect the proposal. New
 *   evidence is an operator CLEARING the row, with an actor and a reason.
 * - **Until policy changes.** `blocked_under_policy_version_id` records the
 *   policy in force when a person made the judgement — for the audit trail, and
 *   deliberately NOT as a scope. A block that expired on the next policy version
 *   would silently re-propose every rejected pair on a tuning change, which is
 *   the exact failure acceptance 4 names; clearing stays a deliberate act.
 *
 * The target is a product or a variant. Blocking a PRODUCT blocks every variant
 * under it, because a reviewer who says "this listing is not that product" has
 * said something about all of its configurations.
 */
export const matchBlockedPairs = pgTable(
  'match_blocked_pairs',
  {
    id: generatedId(),
    /** The stable subject identity — the same key `match_decisions` carries. */
    subjectKey: text().notNull(),
    subjectKind: text({ enum: asEnumValues(MATCH_SUBJECT_KINDS) }).notNull(),
    targetCanonicalProductId: text().references(() => canonicalProducts.id, {
      onDelete: 'cascade',
    }),
    targetCanonicalVariantId: text().references(() => canonicalVariants.id, {
      onDelete: 'cascade',
    }),
    /** The decision this rejection came out of, when it came out of one. */
    decisionId: text().references(() => matchDecisions.id, { onDelete: 'set null' }),
    blockedUnderPolicyVersionId: text()
      .notNull()
      .references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key. */
    blockedByOxyUserId: text().notNull(),
    reason: text().notNull(),
    clearedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    clearedByOxyUserId: text(),
    clearReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * The collapsed target, so the open-block unique actually constrains across
     * two nullable foreign keys. The `endpoint_key` device again.
     */
    targetKey: text().generatedAlwaysAs(
      (): SQL =>
        sql`coalesce('var:' || ${matchBlockedPairs.targetCanonicalVariantId}, 'prd:' || ${matchBlockedPairs.targetCanonicalProductId})`,
    ),
  },
  (t) => [
    checkOneOf('match_blocked_pairs_subject_kind_check', t.subjectKind, MATCH_SUBJECT_KINDS),
    check('match_blocked_pairs_subject_key_check', sql`btrim(${t.subjectKey}) <> ''`),
    check(
      'match_blocked_pairs_target_check',
      sql`num_nonnulls(${t.targetCanonicalProductId}, ${t.targetCanonicalVariantId}) = 1`,
    ),
    check('match_blocked_pairs_actor_check', sql`btrim(${t.blockedByOxyUserId}) <> ''`),
    check('match_blocked_pairs_reason_check', sql`btrim(${t.reason}) <> ''`),
    /**
     * Clearing a block is attributable and reasoned, or it did not happen. A
     * rejection that can be lifted anonymously is a rejection that does not
     * hold, and "until evidence changes" is the promise this CHECK keeps.
     */
    check(
      'match_blocked_pairs_cleared_state_check',
      sql`${t.clearedAt} is null
          or (${t.clearedByOxyUserId} is not null and btrim(${t.clearReason}) <> '')`,
    ),
    /** ONE open block per pair. History is cleared rows; nothing is deleted. */
    uniqueIndex('match_blocked_pairs_open_key')
      .on(t.subjectKey, t.targetKey)
      .where(sql`${t.clearedAt} is null`),
    /** The pipeline's own lookup: every open block for this subject, in one scan. */
    index('match_blocked_pairs_subject_idx')
      .on(t.subjectKey)
      .where(sql`${t.clearedAt} is null`),
    index('match_blocked_pairs_target_idx').on(t.targetKey),
  ],
);

/**
 * `match_queue` — the durable promise that a subject will be matched (#58
 * operations 3 and 4).
 *
 * One row per SUBJECT, so this is a CONVERGENCE queue and not a delivery queue —
 * the `offer_outboxes` shape, and it inverts the moderation outbox's rules for
 * the same reasons. Five catalogue writes to one listing in a second owe ONE
 * evaluation, not five; the enqueue is therefore `ON CONFLICT DO UPDATE` that
 * bumps `requested_revision`, and the `requested_revision`/`claimed_revision`
 * pair is what stops a write landing mid-evaluation from being swallowed by the
 * completion that follows it.
 *
 * ## Match failure never blocks source progress (operations 4)
 *
 * A row here is the ONLY thing that fails when matching fails. The
 * `source_records` observation is already committed, the listing is already
 * written, and a dead-lettered queue row leaves both untouched and visible. That
 * is why the enqueue is a separate statement from the catalogue write rather
 * than a step inside the pipeline: the durable record is never gated on the
 * matcher's health.
 *
 * ## No `expires_at`, and therefore no `expiryTargets.ts` entry
 *
 * One row per subject, CASCADEing with the native variant that owns it, so the
 * table is bounded by the catalogue itself. A retention sweep here would delete
 * pending matching work on a clock — the `offer_outboxes` reasoning verbatim.
 */
export const matchQueue = pgTable(
  'match_queue',
  {
    id: generatedId(),
    subjectKind: text({ enum: asEnumValues(MATCH_SUBJECT_KINDS) }).notNull(),
    /** The stable subject identity, and the convergence key. */
    subjectKey: text().notNull(),
    /** RESTRICT (D19) — an observation outlives the job that reads it. */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** CASCADE (D20) — a seller deleting a listing must not be blocked by a queue. */
    productVariantId: text().references(() => productVariants.id, { onDelete: 'cascade' }),
    trigger: text({ enum: asEnumValues(MATCH_QUEUE_TRIGGERS) }).notNull(),

    requestedRevision: bigint({ mode: 'number' }).notNull().default(1),
    claimedRevision: bigint({ mode: 'number' }),
    status: text({ enum: asEnumValues(MATCH_QUEUE_STATUSES) }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('match_queue_subject_kind_check', t.subjectKind, MATCH_SUBJECT_KINDS),
    checkOneOf('match_queue_status_check', t.status, MATCH_QUEUE_STATUSES),
    checkOneOf('match_queue_trigger_check', t.trigger, MATCH_QUEUE_TRIGGERS),
    check('match_queue_subject_key_check', sql`btrim(${t.subjectKey}) <> ''`),
    check(
      'match_queue_subject_shape_check',
      sql`case ${t.subjectKind}
            when 'source_record' then ${t.sourceRecordId} is not null and ${t.productVariantId} is null
            when 'native_variant' then ${t.productVariantId} is not null and ${t.sourceRecordId} is null
            else false
          end`,
    ),
    check('match_queue_attempts_check', sql`${t.attempts} >= 0`),
    check('match_queue_requested_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'match_queue_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    check(
      'match_queue_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MATCH_MAX_TEXT_LENGTH))}`,
    ),
    /** The convergence key: one outstanding job per subject, ever. */
    uniqueIndex('match_queue_subject_key_unique').on(t.subjectKey),
    // Two partial indexes, one per branch of the claim's `or`, so neither scans
    // the other's rows. The `offer_outboxes` shape.
    index('match_queue_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('match_queue_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    /** Queue AGE (operations 5): the oldest pending row, served by a backward scan. */
    index('match_queue_age_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * `match_sweep_cursors` — the resumable, bounded bulk enqueuers (#58 operations
 * 3).
 *
 * One singleton row per job, keyed by the job name, with a lease and a keyset
 * cursor: the `reconciliation_cursors` shape, and for the same reasons — a pass
 * is many bounded PAGES, the cursor is made durable BEFORE the lease is given
 * up, and a crash mid-pass resumes where it stopped rather than starting over.
 *
 * A sweep ENQUEUES and never matches. That is deliberate: the queue's dispatcher
 * is the only thing that runs the pipeline, so a bulk re-evaluation after a
 * policy change and a single catalogue write take exactly the same code path,
 * and there is no second matching implementation to keep in step with the first.
 */
export const matchSweepCursors = pgTable(
  'match_sweep_cursors',
  {
    /** The job name, caller-supplied — hence no default (CONVENTIONS.md). */
    id: text().primaryKey(),
    /** Where the NEXT page starts. NULL = the beginning of a pass. */
    cursor: text(),
    /** The policy version this pass is enqueueing for; NULL before the first run. */
    policyVersionId: text().references(() => matchPolicyVersions.id, { onDelete: 'restrict' }),
    lastRunAt: timestamptz(),
    lastCompletedAt: timestamptz(),
    /** Rows enqueued by the pass in progress. Reset when a pass completes. */
    enqueuedInPass: integer().notNull().default(0),
    lastError: text(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('match_sweep_cursors_id_check', t.id, MATCH_SWEEP_JOBS),
    check('match_sweep_cursors_enqueued_check', sql`${t.enqueuedInPass} >= 0`),
    check(
      'match_sweep_cursors_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MATCH_MAX_TEXT_LENGTH))}`,
    ),
    /** Half a lease is unrepresentable — the `reconciliation_cursors` CHECK. */
    check(
      'match_sweep_cursors_lease_complete_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
  ],
);
