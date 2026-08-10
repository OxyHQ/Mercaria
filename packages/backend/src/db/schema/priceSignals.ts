/**
 * Trustworthy price signals and merchant competitiveness (#82).
 *
 * FOUR tables: the versioned policy that defines what a claim MEANS, the leased
 * sweep that measures how often one can be made, the append-only recording of
 * what each sweep found, and the correction reports merchants file against it.
 *
 * ## What is deliberately NOT here: a signal
 *
 * A signal is DERIVED at read time and never stored as a serving answer. Its
 * inputs live on `offer_price_snapshots` (#78), `offers` (#57), `listings`,
 * `merchants` and `commerce_relationships` (#55) — five tables in four domains
 * this one does not own — so the `deriveNativeCheckoutEligibility` divergence
 * from the one-stored-verdict rule applies with more force than anywhere it has
 * applied before: a cached "good price" survives the moderation restriction, the
 * rights withdrawal and the retirement that should have withdrawn it.
 *
 * `price_signal_evaluations` is therefore a RECORDING and not a cache — the
 * `payment_discrepancies` and `retail_eligibility_decisions` relationship — and
 * `price-signal-isolation.test.ts` fails the build if any read path selects from
 * it. What it exists for is the four things a live derivation cannot answer:
 * coverage over time, the insufficient-data rate, the distribution of labels,
 * and whether a policy or feed change moved a great many signals at once.
 *
 * ## Why the money columns carry no currency of their own
 *
 * Every figure on an evaluation is expressed in that evaluation's
 * `display_currency`, which is a property of the SUBJECT. A per-figure currency
 * column would be a second representation of one fact, and the failure it
 * enables is the one this whole domain exists to prevent — a row whose headline
 * amount and whose subject disagree about what currency the number is in. So the
 * amounts are bare `bigint` minor units and the currency is the subject's, which
 * is the one place it can be.
 *
 * This is a stated divergence from the `money()` four-column shape
 * `CONVENTIONS.md` otherwise requires, and it is narrow: it applies only where a
 * row already carries the currency as part of its identity.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
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
  ANALYTICS_METRIC_KEYS,
  CONDITION_GROUPS,
  PRICE_QUALITY_CONFIDENCES,
  PRICE_QUALITY_LABELS,
  PRICE_MARKET_POSITIONS,
  PRICE_SERIES_SCOPE_KINDS,
  PRICE_SIGNAL_FEEDBACK_REASONS,
  PRICE_SIGNAL_FEEDBACK_STATUSES,
  PRICE_SIGNAL_KINDS,
  PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR,
  PRICE_SIGNAL_POLICY_STATUSES,
  PRICE_SIGNAL_RUN_MODES,
  PRICE_SIGNAL_RUN_STATUSES,
  PRICE_SIGNAL_UNMEASURED_REASONS,
} from '@mercaria/shared-types';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { merchants } from './merchants';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
} from './columns';

/** The longest note a merchant may attach to a correction report. */
export const PRICE_SIGNAL_FEEDBACK_NOTE_MAX_LENGTH = 500;

/** The most evidence ids one evaluation row records. */
export const PRICE_SIGNAL_EVIDENCE_MAX_IDS = 200;

/**
 * `price_signal_policy_versions` — what a claim about a price MEANS.
 *
 * The `fee_schedules` / `match_policy_versions` / `ranking_policy_versions`
 * device, with one deliberate simplification: there is no `canary` status and no
 * share column. A ranking canary shows two shoppers two ORDERS of the same
 * offers; a signal canary would show two shoppers two contradictory CLAIMS about
 * one price, with nothing on either page saying so. Version comparison is a
 * `candidate_comparison` RUN instead — every number, no shopper.
 *
 * Every threshold is a COLUMN, and the absence of a jsonb bag is the same
 * argument `ranking_policy_versions` makes: a bag would let somebody publish a
 * parameter nobody shipped a derivation for, and acceptance 4's "reproducible
 * from immutable observations and a policy version" would stop being true the
 * first time it happened.
 */
export const priceSignalPolicyVersions = pgTable(
  'price_signal_policy_versions',
  {
    id: generatedId(),
    /** `PRICE_SIGNAL_POLICY_KEY`, a code constant — a column for the same reason #74's is. */
    policyKey: text().notNull(),
    /** The version an evaluation records forever. Unique per key, superseded rows included. */
    version: text().notNull(),
    status: text({ enum: asEnumValues(PRICE_SIGNAL_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    /** What changed and why — read by whoever is deciding whether to roll back. */
    description: text().notNull(),

    // ── The sample floors (issue statistical policy 4) ───────────────────────
    minObservations: integer().notNull().default(8),
    /**
     * How many distinct SELLERS a claim needs behind it.
     *
     * CHECK-floored at `PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR`, and the floor
     * is about what the word "market" may be applied to rather than about
     * disclosure: every offer this domain reads is one a shopper already sees on
     * `/offer-comparison`, but a "market median" over two sellers is one rival's
     * price wearing a statistical name.
     */
    minDistinctSellers: integer().notNull().default(3),
    minDistinctOffers: integer().notNull().default(3),
    minCoverageDays: integer().notNull().default(7),

    /** How far back "recent" reaches. */
    recentWindowDays: integer().notNull().default(30),

    /**
     * The Iglewicz–Hoaglin modified z-score above which an observation is an
     * OUTLIER (issue statistical policy 5).
     *
     * A named, citable robust method with a conventional constant, rather than a
     * percentile trim chosen because it removed a number somebody disliked. The
     * derivation's MAD-of-zero rule — nothing is an outlier when more than half
     * the sample is identical — lives in `statistics.ts`, because a CHECK cannot
     * express it and a column defaulting it would read as a knob.
     */
    outlierModifiedZThreshold: doublePrecision().notNull().default(3.5),
    /**
     * The relative floor the z-score is CONJOINED with, in basis points.
     *
     * 7_500 by default — a 75% move. A half-price sale is 5_000 and survives; a
     * minor/major units error is 90_000 and does not. It is a POLICY column and
     * not a constant precisely because it is where "a deep discount" ends and "a
     * data error" begins, which is a judgement somebody has to publish, version
     * and be able to roll back.
     */
    outlierMinDeviationBps: integer().notNull().default(7_500),

    /** How far a price must FALL against a prior valid observation to be material. */
    materialDropBps: integer().notNull().default(500),
    /** The symmetric band around a reference that reads as `near` / `typical_price`. */
    typicalBandBps: integer().notNull().default(300),
    /** How far BELOW a reference a price must sit to read as `good_price`. */
    goodPriceBelowMedianBps: integer().notNull().default(800),
    /** The multiple of every floor a sample clears before a label is `strong`. */
    strongSampleMultiplier: doublePrecision().notNull().default(2),

    /**
     * What this version is judged on, and what may not get worse while it serves
     * (issue monitoring 5).
     *
     * #77 metric keys, CHECK-contained against the same tuple
     * `analytics_rollups.metric_key` reads, so a policy cannot be evaluated
     * against a number nobody has defined. Naming them is ALL this domain does
     * with one — it reads no measurement, which the isolation gate enforces in
     * both directions, because "click and conversion outcomes" is one join from
     * "merchants who convert get the good badge".
     */
    objectiveMetricKeys: text().array().notNull().default(sql`'{}'::text[]`),
    guardrailMetricKeys: text().array().notNull().default(sql`'{}'::text[]`),

    activatedAt: timestamptz(),
    supersededAt: timestamptz(),
    archivedAt: timestamptz(),

    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who let it serve. The audit half of publishing. */
    approvedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('price_signal_policy_versions_status_check', t.status, PRICE_SIGNAL_POLICY_STATUSES),
    check('price_signal_policy_versions_version_check', sql`btrim(${t.version}) <> ''`),
    check('price_signal_policy_versions_description_check', sql`btrim(${t.description}) <> ''`),
    check('price_signal_policy_versions_actor_check', sql`btrim(${t.createdByOxyUserId}) <> ''`),

    /**
     * The seller floor, rendered with `sql.raw` from the SAME constant the
     * derivation reads.
     *
     * Interpolating the constant normally would write the literal bound-parameter
     * placeholder `$1` into the generated migration, which drizzle-kit emits
     * happily and Postgres refuses at APPLY time — the trap `CONVENTIONS.md`
     * records and the reason `sql.raw` is not a style choice here.
     */
    check(
      'price_signal_policy_versions_sample_floor_check',
      sql`${t.minObservations} >= 1
          and ${t.minDistinctSellers} >= ${sql.raw(String(PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR))}
          and ${t.minDistinctOffers} >= 1
          and ${t.minCoverageDays} >= 1
          and ${t.recentWindowDays} >= 1`,
    ),
    check(
      'price_signal_policy_versions_outlier_threshold_check',
      sql`${t.outlierModifiedZThreshold} > 0 and ${t.outlierMinDeviationBps} > 0`,
    ),
    /**
     * `good_price` must require a strictly larger discount than the `near` band.
     *
     * Without this the two verdicts OVERLAP, one price satisfies both, and which
     * one a shopper sees is decided by the order of the comparisons in
     * `priceQualityLabelFor` — a policy whose meaning depends on the
     * implementation rather than on the row.
     */
    check(
      'price_signal_policy_versions_thresholds_check',
      sql`${t.materialDropBps} > 0 and ${t.typicalBandBps} > 0
          and ${t.goodPriceBelowMedianBps} >= ${t.typicalBandBps}
          and ${t.strongSampleMultiplier} >= 1`,
    ),

    /** Anything that has served names who let it — the `fee_schedules` discipline. */
    check(
      'price_signal_policy_versions_activation_audit_check',
      sql`${t.status} in ('draft', 'archived')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    check(
      'price_signal_policy_versions_superseded_check',
      sql`${t.status} <> 'superseded' or ${t.supersededAt} is not null`,
    ),
    check(
      'price_signal_policy_versions_archived_check',
      sql`(${t.status} = 'archived') = (${t.archivedAt} is not null)`,
    ),

    checkEveryElementOf(
      'price_signal_policy_versions_objective_metrics_check',
      t.objectiveMetricKeys,
      ANALYTICS_METRIC_KEYS,
    ),
    checkEveryElementOf(
      'price_signal_policy_versions_guardrail_metrics_check',
      t.guardrailMetricKeys,
      ANALYTICS_METRIC_KEYS,
    ),
    /**
     * `cardinality`, never `array_length`.
     *
     * `array_length('{}', 1)` is NULL, a CHECK rejects only FALSE, and the
     * obvious spelling therefore ADMITS exactly the empty guardrail list it
     * exists to refuse. Measured three times in this schema before this table
     * was written; the realdb suite pins it with an empty-array fixture, which is
     * the only fixture that can tell the two spellings apart.
     */
    check(
      'price_signal_policy_versions_evaluation_plan_check',
      sql`cardinality(${t.guardrailMetricKeys}) >= 1`,
    ),

    uniqueIndex('price_signal_policy_versions_key_version_key').on(t.policyKey, t.version),
    /** ONE active version per key. A signal has one meaning at a time or none. */
    uniqueIndex('price_signal_policy_versions_one_active_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
    index('price_signal_policy_versions_key_created_at_idx').on(t.policyKey, t.createdAt.desc()),
  ],
);

/**
 * `price_signal_runs` — one leased, bounded, resumable measurement sweep.
 *
 * A run is the COMPARISON UNIT monitoring 3 needs: "sudden mass signal changes
 * after policy or feed updates" is a statement about two runs, and without a row
 * naming each of them there is nothing to diff.
 *
 * `mode` keeps the live measurement and a candidate version's dry run apart, the
 * `catalog_backfill_runs` `dry_run | apply` device: a candidate's numbers read
 * exactly like the live distribution, and mistaking one for the other is how a
 * policy gets rolled out on the strength of its own rehearsal.
 */
export const priceSignalRuns = pgTable(
  'price_signal_runs',
  {
    id: generatedId(),
    /** RESTRICT: a policy version cannot vanish from under the evidence it produced. */
    policyVersionId: text()
      .notNull()
      .references(() => priceSignalPolicyVersions.id, { onDelete: 'restrict' }),
    mode: text({ enum: asEnumValues(PRICE_SIGNAL_RUN_MODES) }).notNull(),
    status: text({ enum: asEnumValues(PRICE_SIGNAL_RUN_STATUSES) }).notNull().default('pending'),

    // ── The cohort ───────────────────────────────────────────────────────────
    /** The currency every subject in this run was measured in. */
    displayCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** ISO 3166-1 alpha-2, or NULL for "every market". */
    market: text(),
    /** The last canonical product id examined — a keyset cursor, so a run resumes. */
    cursorCanonicalProductId: text(),

    // ── The counters, and the CHECK that makes them a VACUITY FLOOR ──────────
    /**
     * Subjects the run examined, and the three ways one can end.
     *
     * `catalog_backfill_runs_counters_total_check`'s device: the three sum to
     * `subjects_scanned` by EQUALITY, never `<=`, so a page that swallowed a
     * subject cannot write a row at all. A sweep that measured nothing and a
     * sweep that went perfectly produce identical-looking output, and this is the
     * only thing between them.
     */
    subjectsScanned: integer().notNull().default(0),
    subjectsMeasured: integer().notNull().default(0),
    subjectsUnmeasured: integer().notNull().default(0),
    subjectsFailed: integer().notNull().default(0),

    signalsEvaluated: integer().notNull().default(0),
    signalsMeasured: integer().notNull().default(0),
    signalsNotPresent: integer().notNull().default(0),
    signalsUnmeasured: integer().notNull().default(0),

    attempts: integer().notNull().default(0),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('price_signal_runs_mode_check', t.mode, PRICE_SIGNAL_RUN_MODES),
    checkOneOf('price_signal_runs_status_check', t.status, PRICE_SIGNAL_RUN_STATUSES),
    ...currencyChecks('price_signal_runs', [t.displayCurrency]),
    check('price_signal_runs_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check(
      'price_signal_runs_subject_counters_check',
      sql`${t.subjectsScanned} >= 0 and ${t.subjectsMeasured} >= 0
          and ${t.subjectsUnmeasured} >= 0 and ${t.subjectsFailed} >= 0
          and ${t.subjectsMeasured} + ${t.subjectsUnmeasured} + ${t.subjectsFailed}
              = ${t.subjectsScanned}`,
    ),
    check(
      'price_signal_runs_signal_counters_check',
      sql`${t.signalsEvaluated} >= 0 and ${t.signalsMeasured} >= 0
          and ${t.signalsNotPresent} >= 0 and ${t.signalsUnmeasured} >= 0
          and ${t.signalsMeasured} + ${t.signalsNotPresent} + ${t.signalsUnmeasured}
              = ${t.signalsEvaluated}`,
    ),
    check('price_signal_runs_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'price_signal_runs_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= 500`,
    ),
    /**
     * The composite identity an evaluation cites.
     *
     * A `unique()` CONSTRAINT and not a `uniqueIndex()`: drizzle-kit emits every
     * `ADD CONSTRAINT … FOREIGN KEY` before every `CREATE UNIQUE INDEX`,
     * whatever the source order, so a foreign key targeting an INDEX fails at
     * apply time with `42830` — invisible to `tsc` and to the generator, and
     * caught only by a real server.
     */
    unique('price_signal_runs_identity_key').on(t.id, t.policyVersionId),
    index('price_signal_runs_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('price_signal_runs_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'processing'`),
    index('price_signal_runs_policy_created_at_idx').on(t.policyVersionId, t.createdAt.desc()),
  ],
);

/**
 * `price_signal_evaluations` — one signal, as one sweep measured it.
 *
 * Append-only against UPDATE and DELETE-permitted, matching `analytics_events`
 * and #78's snapshots rather than the ledger: a measurement is evidence and must
 * never be rewritten, but retention on a schedule is an operator decision and a
 * trigger refusing DELETE would make it fail silently.
 *
 * It cites its policy version by a NOT NULL COMPOSITE foreign key onto the run —
 * the `match_category_gates` device — so an evaluation naming a different policy
 * from the run that produced it is UNREPRESENTABLE rather than merely wrong.
 * That is acceptance 4's other half: the observations are immutable and the
 * policy is frozen, so the pair fully determines the claim.
 */
export const priceSignalEvaluations = pgTable(
  'price_signal_evaluations',
  {
    id: generatedId(),
    runId: text()
      .notNull()
      .references(() => priceSignalRuns.id, { onDelete: 'restrict' }),
    policyVersionId: text()
      .notNull()
      .references(() => priceSignalPolicyVersions.id, { onDelete: 'restrict' }),

    // ── The subject (issue acceptance 1) ─────────────────────────────────────
    scopeKind: text({ enum: asEnumValues(PRICE_SERIES_SCOPE_KINDS) }).notNull(),
    /**
     * RESTRICT rather than CASCADE, and `retained_by_tombstone` in the merge
     * plan: an evaluation describes what an identity WAS at a point in time, and
     * moving it to a merge winner would attribute measurements of one product to
     * another.
     */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    segment: text({ enum: asEnumValues(CONDITION_GROUPS) }).notNull(),
    market: text(),
    displayCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),

    signalKind: text({ enum: asEnumValues(PRICE_SIGNAL_KINDS) }).notNull(),
    state: text({ enum: ['measured', 'not_present', 'unmeasured'] as const }).notNull(),
    unmeasuredReason: text({ enum: asEnumValues(PRICE_SIGNAL_UNMEASURED_REASONS) }),

    // ── The value, in `display_currency` (see the module docblock) ───────────
    valueAmount: bigint({ mode: 'number' }),
    valueLowAmount: bigint({ mode: 'number' }),
    valueHighAmount: bigint({ mode: 'number' }),
    deltaBps: integer(),
    label: text({ enum: asEnumValues(PRICE_QUALITY_LABELS) }),
    position: text({ enum: asEnumValues(PRICE_MARKET_POSITIONS) }),
    confidence: text({ enum: asEnumValues(PRICE_QUALITY_CONFIDENCES) }),

    // ── The sample (issue statistical policy 4, competitiveness 8) ───────────
    sampleObservations: integer().notNull(),
    sampleDistinctSellers: integer().notNull(),
    sampleDistinctOffers: integer().notNull(),
    sampleCoverageDays: integer().notNull(),
    sampleOutliersExcluded: integer().notNull(),
    sampleDeduplicated: integer().notNull(),

    /**
     * The immutable observations behind a measured claim (issue statistical
     * policy 9).
     *
     * Ids and never a copy of the amounts: an observation cannot change, so a
     * second copy could only ever be a way for the two to disagree. Bounded, so
     * one pathological subject cannot make a row unreadable — and the count that
     * matters is `sample_observations`, which is exact whether or not the id list
     * was truncated.
     */
    evidenceObservationIds: text().array().notNull().default(sql`'{}'::text[]`),
    evidenceOfferIds: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * What the robust method set aside, NAMED.
     *
     * This is what makes "handle outliers with a documented robust method rather
     * than deleting inconvenient data manually" checkable rather than claimed:
     * the excluded observations are recorded here and remain in
     * `offer_price_snapshots` untouched.
     */
    excludedOutlierObservationIds: text().array().notNull().default(sql`'{}'::text[]`),

    evaluatedAt: timestamptz().notNull(),
    createdAt: createdAt(),

    /**
     * The subject's convergence key, GENERATED for the reason #78's `series_key`
     * is: Postgres treats NULLs as distinct, and `canonical_product_id`,
     * `canonical_variant_id` and `market` are each legitimately NULL, so a plain
     * multi-column unique would let a resumed run write a subject twice.
     */
    subjectKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("canonical_product_id", '') || '|' || coalesce("canonical_variant_id", '') || '|' ||
            "segment" || '|' || coalesce("market", '') || '|' || "display_currency"`,
      ),
  },
  (t) => [
    checkOneOf('price_signal_evaluations_scope_kind_check', t.scopeKind, PRICE_SERIES_SCOPE_KINDS),
    checkOneOf('price_signal_evaluations_segment_check', t.segment, CONDITION_GROUPS),
    checkOneOf('price_signal_evaluations_signal_kind_check', t.signalKind, PRICE_SIGNAL_KINDS),
    checkOneOf('price_signal_evaluations_state_check', t.state, [
      'measured',
      'not_present',
      'unmeasured',
    ]),
    checkOneOf(
      'price_signal_evaluations_unmeasured_reason_check',
      t.unmeasuredReason,
      PRICE_SIGNAL_UNMEASURED_REASONS,
    ),
    checkOneOf('price_signal_evaluations_label_check', t.label, PRICE_QUALITY_LABELS),
    checkOneOf('price_signal_evaluations_position_check', t.position, PRICE_MARKET_POSITIONS),
    checkOneOf(
      'price_signal_evaluations_confidence_check',
      t.confidence,
      PRICE_QUALITY_CONFIDENCES,
    ),
    ...currencyChecks('price_signal_evaluations', [t.displayCurrency]),
    check('price_signal_evaluations_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check(
      'price_signal_evaluations_scope_shape_check',
      sql`case ${t.scopeKind}
        when 'canonical_product' then ${t.canonicalProductId} is not null and ${t.canonicalVariantId} is null
        when 'canonical_variant' then ${t.canonicalVariantId} is not null and ${t.canonicalProductId} is null
        else false
      end`,
    ),
    /**
     * A reason is present EXACTLY when the state is `unmeasured` — a
     * biconditional, not two implications.
     *
     * The permissive spelling would admit a `measured` row carrying an
     * insufficiency reason, which is a row that says both that it knows and that
     * it does not.
     */
    check(
      'price_signal_evaluations_unmeasured_shape_check',
      sql`(${t.state} = 'unmeasured') = (${t.unmeasuredReason} is not null)`,
    ),
    /**
     * Only a MEASURED row may carry a figure — the type's unknown-branch rule,
     * restated where a service bug can actually reach it.
     *
     * Written as two separate implications rather than one over their
     * conjunction, which is the #126 finding: the conjunction form is SATISFIED
     * by a row where both halves are false, admitting exactly the shape it
     * exists to forbid.
     */
    check(
      'price_signal_evaluations_value_shape_check',
      sql`(${t.state} = 'measured'
             or (${t.valueAmount} is null and ${t.valueLowAmount} is null
                 and ${t.valueHighAmount} is null and ${t.deltaBps} is null
                 and ${t.label} is null and ${t.position} is null and ${t.confidence} is null))
          and (${t.state} <> 'measured'
             or ${t.valueAmount} is not null or ${t.valueLowAmount} is not null
             or ${t.label} is not null or ${t.position} is not null)`,
    ),
    /** A range is two ends or neither, and the low end is not above the high one. */
    check(
      'price_signal_evaluations_range_shape_check',
      sql`(${t.valueLowAmount} is null) = (${t.valueHighAmount} is null)
          and (${t.valueLowAmount} is null or ${t.valueLowAmount} <= ${t.valueHighAmount})`,
    ),
    /**
     * A confidence belongs to a LABEL and to nothing else.
     *
     * The two are one fact in two columns — issue item 8's "backed by a
     * documented policy and confidence" — and a confidence beside no label is a
     * strength rating for a claim nobody made.
     */
    check(
      'price_signal_evaluations_confidence_shape_check',
      sql`(${t.confidence} is not null) = (${t.label} is not null)`,
    ),
    check(
      'price_signal_evaluations_sample_check',
      sql`${t.sampleObservations} >= 0 and ${t.sampleDistinctSellers} >= 0
          and ${t.sampleDistinctOffers} >= 0 and ${t.sampleCoverageDays} >= 0
          and ${t.sampleOutliersExcluded} >= 0 and ${t.sampleDeduplicated} >= 0`,
    ),
    /** Every money figure is a non-negative minor-unit amount. */
    check(
      'price_signal_evaluations_amounts_check',
      sql`(${t.valueAmount} is null or ${t.valueAmount} >= 0)
          and (${t.valueLowAmount} is null or ${t.valueLowAmount} >= 0)
          and (${t.valueHighAmount} is null or ${t.valueHighAmount} >= 0)`,
    ),
    check(
      'price_signal_evaluations_evidence_bound_check',
      sql`cardinality(${t.evidenceObservationIds}) <= ${sql.raw(String(PRICE_SIGNAL_EVIDENCE_MAX_IDS))}
          and cardinality(${t.evidenceOfferIds}) <= ${sql.raw(String(PRICE_SIGNAL_EVIDENCE_MAX_IDS))}
          and cardinality(${t.excludedOutlierObservationIds}) <= ${sql.raw(String(PRICE_SIGNAL_EVIDENCE_MAX_IDS))}`,
    ),
    foreignKey({
      name: 'price_signal_evaluations_run_policy_fk',
      columns: [t.runId, t.policyVersionId],
      foreignColumns: [priceSignalRuns.id, priceSignalRuns.policyVersionId],
    }).onDelete('restrict'),
    /** A resumed run re-examining a subject converges rather than duplicating. */
    uniqueIndex('price_signal_evaluations_run_subject_key').on(t.runId, t.subjectKey, t.signalKind),
    index('price_signal_evaluations_run_kind_idx').on(t.runId, t.signalKind, t.state),
    index('price_signal_evaluations_subject_idx').on(t.subjectKey, t.signalKind, t.evaluatedAt.desc()),
  ],
);

/**
 * `price_signal_feedback` — a merchant saying a signal about their own offer is
 * wrong (issue monitoring 4).
 *
 * The reason is a CLOSED SET because monitoring 4 asks for correction reports as
 * a MEASURE of the policy, and free text cannot be counted. The note beside it is
 * for a person to read; the code is what a distribution is built from.
 *
 * `resolved` and `rejected` are both closed and are kept apart deliberately: "we
 * changed something" and "we did not" are the two answers a merchant is owed, and
 * one `closed` state would make the correction rate — the number the whole table
 * exists to produce — unreadable.
 */
export const priceSignalFeedback = pgTable(
  'price_signal_feedback',
  {
    id: generatedId(),
    /**
     * The merchant the report is about, and whose verified claimant filed it.
     *
     * RESTRICT and `retained_by_tombstone`: a correction report is a statement
     * about a claim Mercaria published concerning THAT identity, and a merge
     * moving it would attribute a complaint to a merchant nobody complained
     * about.
     */
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    /** The Oxy account that filed it — the merchant's verified claimant. No FK. */
    reportedByOxyUserId: text().notNull(),

    scopeKind: text({ enum: asEnumValues(PRICE_SERIES_SCOPE_KINDS) }).notNull(),
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    segment: text({ enum: asEnumValues(CONDITION_GROUPS) }).notNull(),
    market: text(),
    displayCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    signalKind: text({ enum: asEnumValues(PRICE_SIGNAL_KINDS) }).notNull(),

    reason: text({ enum: asEnumValues(PRICE_SIGNAL_FEEDBACK_REASONS) }).notNull(),
    note: text(),
    status: text({ enum: asEnumValues(PRICE_SIGNAL_FEEDBACK_STATUSES) })
      .notNull()
      .default('open'),
    /** The operator who closed it. Set with `resolved_at`, never separately. */
    resolvedByOxyUserId: text(),
    resolvedAt: timestamptz(),
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    subjectKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("canonical_product_id", '') || '|' || coalesce("canonical_variant_id", '') || '|' ||
            "segment" || '|' || coalesce("market", '') || '|' || "display_currency"`,
      ),
  },
  (t) => [
    checkOneOf('price_signal_feedback_scope_kind_check', t.scopeKind, PRICE_SERIES_SCOPE_KINDS),
    checkOneOf('price_signal_feedback_segment_check', t.segment, CONDITION_GROUPS),
    checkOneOf('price_signal_feedback_signal_kind_check', t.signalKind, PRICE_SIGNAL_KINDS),
    checkOneOf('price_signal_feedback_reason_check', t.reason, PRICE_SIGNAL_FEEDBACK_REASONS),
    checkOneOf('price_signal_feedback_status_check', t.status, PRICE_SIGNAL_FEEDBACK_STATUSES),
    ...currencyChecks('price_signal_feedback', [t.displayCurrency]),
    check('price_signal_feedback_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check('price_signal_feedback_reporter_check', sql`btrim(${t.reportedByOxyUserId}) <> ''`),
    check(
      'price_signal_feedback_scope_shape_check',
      sql`case ${t.scopeKind}
        when 'canonical_product' then ${t.canonicalProductId} is not null and ${t.canonicalVariantId} is null
        when 'canonical_variant' then ${t.canonicalVariantId} is not null and ${t.canonicalProductId} is null
        else false
      end`,
    ),
    check(
      'price_signal_feedback_note_length_check',
      sql`(${t.note} is null or length(${t.note}) <= ${sql.raw(String(PRICE_SIGNAL_FEEDBACK_NOTE_MAX_LENGTH))})
          and (${t.resolutionNote} is null
               or length(${t.resolutionNote}) <= ${sql.raw(String(PRICE_SIGNAL_FEEDBACK_NOTE_MAX_LENGTH))})`,
    ),
    /**
     * Closed is `resolved_at` plus an actor plus a non-`open` status, all three
     * or none of the three.
     *
     * Two separate biconditionals rather than one over their conjunction, for
     * the reason the value shape above states: the conjunction form is satisfied
     * by a row where both halves are false, which is a closed report nobody
     * closed.
     */
    check(
      'price_signal_feedback_resolution_shape_check',
      sql`((${t.status} = 'open') = (${t.resolvedAt} is null))
          and ((${t.resolvedAt} is null) = (${t.resolvedByOxyUserId} is null))`,
    ),
    /**
     * ONE open report per (merchant, subject, signal).
     *
     * Predicated on `resolved_at IS NULL` rather than on `status = 'open'` —
     * they are the same set by the CHECK above, and a NULL predicate is the one
     * a partial index expresses without a second copy of the status vocabulary.
     * Two taps and a retry converge on one row; a resolved report leaves the
     * index, so the same complaint can legitimately be filed again later.
     */
    uniqueIndex('price_signal_feedback_open_key')
      .on(t.merchantId, t.subjectKey, t.signalKind)
      .where(sql`${t.resolvedAt} is null`),
    index('price_signal_feedback_merchant_created_at_idx').on(t.merchantId, t.createdAt.desc()),
    index('price_signal_feedback_open_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.resolvedAt} is null`),
  ],
);
