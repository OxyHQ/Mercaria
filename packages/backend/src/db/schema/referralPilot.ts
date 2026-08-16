/**
 * The BOUNDED REFERRAL PILOTS (#149): `referral_pilot_cohorts`,
 * `referral_pilot_partners`, `referral_pilot_stop_thresholds`,
 * `referral_pilot_stops`.
 *
 * Four tables answering one question none of #142–#148 asks: **how much of this
 * is Mercaria willing to do at all, today, and what would make it stop.** #143
 * decides who a touch attributes to, #144 what a conversion is worth, #145
 * where the money sits and #146 how it leaves — and a deployment where all four
 * answer "yes" is exactly the state #149 exists to bound.
 *
 * ## Why a versioned cohort rather than environment variables
 *
 * Every bound here could have been a `REFERRAL_PILOT_*` variable, and that is
 * the design this schema rejects. Three reasons, in the order they bite —
 * #125's, restated because they are the same three:
 *
 *  1. **A bound has to be attributable.** "Why was the per-partner entry cap
 *     fifty" is a question with an answer — a person, a date, a written
 *     rationale — and an environment variable has none of those.
 *     `published_by_oxy_user_id` is NOT NULL on an active row, by CHECK.
 *  2. **A bound has to survive a deploy.** A variable changes when somebody
 *     edits a task definition, which is not an event anybody reviews; a cohort
 *     version is frozen once active (a trigger), and a change is a NEW version
 *     — so the bounds a pilot RAN UNDER stay readable after it is widened, and
 *     partners were recruited under terms a reader can still find.
 *  3. **A partner allow-list is a table.** Twenty partner ids in a
 *     comma-separated variable is a list nobody can review, nobody can
 *     attribute a line of, and which silently admits everything on a typo.
 *
 * `referral_programs.cohort_keys` is deliberately NOT reused for this. It is a
 * rollout SCOPING array on a program version — it carries no author, no dates,
 * no caps and no thresholds, and widening it is an edit to the program rather
 * than a new decision with a name on it.
 *
 * ## What a stop pauses, and what it deliberately does not
 *
 * A breach halts ENTRY and nothing else. `assertReferralPilotAdmits` is called
 * from `attributeTouch` and from nowhere else, so a live stop refuses NEW
 * attribution while every standing attribution keeps converting, every reward
 * keeps accruing and vesting, every vested balance keeps being paid and every
 * appeal keeps being heard. That is the whole content of #149 acceptance 5
 * ("stop new attribution without stranding valid earnings, payouts or
 * appeals"), and it is a property of the CALL GRAPH rather than a rule in a
 * handler: there is no scope value that could pause settlement, because
 * settlement never asks.
 *
 * ## The expansion review is a COLUMN GROUP, not an afterthought
 *
 * #149 acceptance 7: "Expansion requires a dated review rather than automatic
 * rollout." A cohort version therefore carries its own review — a decision, a
 * date, an author and a rationale, all four or none (a `num_nonnulls` CHECK) —
 * and a version above 1 must NAME the version it supersedes. Publishing refuses
 * a successor whose predecessor has not been reviewed, so "expanded by default"
 * is a state the surface cannot produce.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  REFERRAL_PILOT_COHORT_STATUSES,
  REFERRAL_PILOT_REVIEW_DECISIONS,
  REFERRAL_PILOT_STOP_METRICS,
  REFERRAL_PILOT_STOP_ORIGINS,
  REFERRAL_PILOT_STOP_SCOPES,
  REFERRAL_PILOT_SUBJECTS,
  REFERRAL_PILOT_THRESHOLD_UNITS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, CURRENCY_CODE_VALUES, currencyChecks, money } from './columns';
import { referralPartners, referralPrograms } from './referrals';

/**
 * `referral_pilot_cohorts` — one immutable statement of what the pilot may do.
 *
 * One ACTIVE version per PROGRAMME (a partial unique), frozen once active (a
 * trigger) — the `fee_schedules` mechanism, chosen because it is the shape this
 * codebase already uses for "a policy somebody published and money moved
 * under". A widening is a new version with its own author, its own date and its
 * own rationale, which is what makes #149 acceptance 7 something a reader can
 * find rather than something a process promises.
 *
 * ONE programme, ONE programme version, ONE payout currency and ONE legal
 * entity, all NOT NULL, because #149's pilot cohort items 1, 3 and 6 are
 * singular and a nullable column would make "unrestricted" representable.
 */
export const referralPilotCohorts = pgTable(
  'referral_pilot_cohorts',
  {
    id: generatedId(),
    /**
     * The operator's own label for this pilot, and the identity its VERSION
     * chain shares. It is NOT what the admission gate looks a cohort up by —
     * that is `program_id`, below — so there is no configured string a
     * deployment could point at bounds nobody published.
     */
    cohortKey: text().notNull(),
    version: integer().notNull(),
    status: text({ enum: asEnumValues(REFERRAL_PILOT_COHORT_STATUSES) })
      .notNull()
      .default('draft'),
    /**
     * Which of #149's pilots this is. `creator_commerce_link` is not a member —
     * see `REFERRAL_PILOT_EXCLUDED_SUBJECTS`, which names the four excluded
     * shapes as values rather than leaving them as omissions.
     */
    subject: text({ enum: asEnumValues(REFERRAL_PILOT_SUBJECTS) }).notNull(),

    /** #149 pilot cohort 1: one legal entity and one program owner. */
    legalEntity: text().notNull(),
    programOwnerOxyUserId: text().notNull(),

    /**
     * The ONE programme and the ONE programme VERSION (#149 pilot cohort 6/7).
     * `programId` is the stable identity the admission gate matches a touch on;
     * `programVersionId` is the exact attribution rule the pilot published, so
     * a later publish cannot change the terms underneath it.
     *
     * There is deliberately NO `reward_rule_version_id` beside them, and #149
     * item 7's "one immutable commission rule" is satisfied without one: ADR
     * 0005 D19 pins the rule VERSION on each ATTRIBUTION, resolved from the
     * programme version's own `commission_rule_ref` at the moment it is created.
     * A second pointer here would be a second answer to which rule governs, and
     * the two could disagree — on exactly the rows a partner was paid under.
     */
    programId: text().notNull(),
    programVersionId: text()
      .notNull()
      .references(() => referralPrograms.id, { onDelete: 'restrict' }),

    /**
     * The supported markets (#149 pilot cohort 2). ISO-3166-1 alpha-2, and
     * NON-EMPTY on an active row: an empty array here would mean the pilot
     * publishes no market bound at all, which is exactly the unbounded state
     * this table exists to make unrepresentable.
     *
     * The bound is enforced at PUBLISH against the program version's own
     * `markets`, not per touch: a touch carries no market (#142's
     * `referral_touches` has no such column, deliberately — a market is a
     * property of an order and not of a click), so checking one per attribution
     * would mean inventing a fact.
     */
    markets: text().array().notNull().default([]),

    /** #149 pilot cohort 3: one payout currency where practical. */
    payoutCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),

    /** #149 pilot cohort 10: explicit start and end dates, both NOT NULL. */
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),

    /**
     * #149 pilot cohort 9: low per-partner and program-wide caps, counted in
     * ADMITTED ATTRIBUTIONS.
     *
     * These are ENTRY bounds and are deliberately not the money caps: ADR 0005
     * D16's per-conversion, per-partner-period and campaign-budget caps are
     * #144's and are claimed ATOMICALLY at accrual. The count here is taken in
     * the attribution's own transaction, so two concurrent attributions can both
     * observe `n < cap` and both insert — the cap is exceeded by at most the
     * concurrency. That is stated rather than hidden: a bound that serialised
     * every attribution on one cohort row would make the pilot's own gate the
     * throughput limit, and the money it actually bounds is claimed atomically
     * one layer down.
     */
    maxAttributionsPerPartner: integer().notNull(),
    maxAttributionsTotal: integer().notNull(),

    /**
     * The program-wide reward budget the pilot runs under — the DENOMINATOR of
     * `budget_utilization` and the number `program_budget_exhaustion` is read
     * against. It is a bound on the PILOT and is not the same as #144's
     * `referral_campaign_budgets`, which is drawn down atomically per accrual;
     * this one is a published ceiling a review compares spend against.
     */
    ...money('rewardBudget'),

    /**
     * #149 pilot cohort 11: enhanced manual review. Stored because it is a
     * commitment the pilot was published under, and a later version that turned
     * it off would then be visibly a different commitment.
     */
    manualReviewRequired: boolean().notNull().default(true),

    /**
     * The version this one supersedes. NULL exactly at version 1 (a CHECK), so
     * the chain is total and a reviewer can walk it backwards.
     */
    supersedesCohortId: text().references((): AnyPgColumn => referralPilotCohorts.id, {
      onDelete: 'restrict',
    }),

    publishedAt: timestamptz(),
    /** NOT NULL on a published row (a CHECK). A bound with no author is not a decision. */
    publishedByOxyUserId: text(),
    supersededAt: timestamptz(),

    /**
     * The expansion review (#149 "Expansion review", acceptance 7).
     *
     * All four or none — `num_nonnulls(...) in (0, 4)` — because a decision
     * with no author, no date or no rationale is not the dated review the
     * acceptance asks for. Publishing a SUCCESSOR refuses while the predecessor
     * carries none, which is how "expansion requires a review" becomes a
     * property of the surface rather than a step somebody remembers.
     */
    reviewDecision: text({ enum: asEnumValues(REFERRAL_PILOT_REVIEW_DECISIONS) }),
    reviewedAt: timestamptz(),
    reviewedByOxyUserId: text(),
    reviewRationale: text(),

    /** Why these bounds. Free text, read by a person, never matched on. */
    rationale: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_pilot_cohorts_status_check', t.status, REFERRAL_PILOT_COHORT_STATUSES),
    checkOneOf('referral_pilot_cohorts_subject_check', t.subject, REFERRAL_PILOT_SUBJECTS),
    checkOneOf(
      'referral_pilot_cohorts_review_decision_check',
      t.reviewDecision,
      REFERRAL_PILOT_REVIEW_DECISIONS,
    ),
    ...currencyChecks('referral_pilot_cohorts', [t.payoutCurrency, t.rewardBudgetCurrency]),
    check('referral_pilot_cohorts_version_check', sql`${t.version} >= 1`),
    // The successor chain is TOTAL: version 1 supersedes nothing and every
    // later version names its predecessor, so a review can be walked backwards
    // from any row.
    check(
      'referral_pilot_cohorts_supersedes_check',
      sql`(${t.version} = 1) = (${t.supersedesCohortId} is null)`,
    ),
    check(
      'referral_pilot_cohorts_window_check',
      sql`${t.endsAt} > ${t.startsAt}`,
    ),
    check(
      'referral_pilot_cohorts_caps_check',
      sql`${t.maxAttributionsPerPartner} >= 1
          and ${t.maxAttributionsTotal} >= ${t.maxAttributionsPerPartner}
          and ${t.rewardBudgetAmount} > 0`,
    ),
    // Two halves that INDEPENDENTLY refuse `{}` today, which is measured rather
    // than assumed: `array_to_string('{}', ',')` is the empty string and the
    // ANCHORED regex does not match it, so substituting `array_length(...) >= 1`
    // for the `cardinality` half changes nothing here — a mutation test proved
    // exactly that, and it is worth writing down, because it means the empty
    // case is NOT what pins the cardinality spelling.
    //
    // What pins it is the other direction: `array_length` is NULL on `{}` and a
    // CHECK reads NULL as SATISFIED, so the day somebody relaxes the regex — a
    // three-letter market code, a lower-case one — the `array_length` spelling
    // would silently start admitting the empty list. `cardinality` is the
    // spelling that survives that change. The regex half is separately
    // mutation-tested by the alpha-2 case.
    //
    // The alpha-2 shape uses `array_to_string` and ONE anchored regex rather
    // than `not exists (select … from unnest(…))`, which is a SUBQUERY and
    // Postgres refuses subqueries in a CHECK outright — the obvious spelling
    // does not fail at review, it fails at APPLY.
    check(
      'referral_pilot_cohorts_markets_check',
      sql`${t.status} = 'draft'
          or (coalesce(cardinality(${t.markets}), 0) >= 1
              and array_to_string(${t.markets}, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$')`,
    ),
    // A PUBLISHED cohort has a publisher and a date. A draft may have neither;
    // a superseded or closed one keeps both.
    check(
      'referral_pilot_cohorts_publication_check',
      sql`(${t.status} = 'draft')
          or (${t.publishedAt} is not null and ${t.publishedByOxyUserId} is not null)`,
    ),
    check(
      'referral_pilot_cohorts_superseded_check',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    // The review is all four columns or none.
    check(
      'referral_pilot_cohorts_review_check',
      sql`num_nonnulls(${t.reviewDecision}, ${t.reviewedAt}, ${t.reviewedByOxyUserId},
                       ${t.reviewRationale}) in (0, 4)`,
    ),
    // A CLOSED cohort is one whose review said so. `closed` is the only status
    // that requires a review, because superseding already requires the
    // predecessor to carry one and the publish path enforces that.
    check(
      'referral_pilot_cohorts_closed_check',
      sql`${t.status} <> 'closed' or ${t.reviewedAt} is not null`,
    ),
    uniqueIndex('referral_pilot_cohorts_key_version_key').on(t.cohortKey, t.version),
    // ONE active version per PROGRAMME — the `fee_schedules` partial unique,
    // keyed on the programme rather than on `cohort_key`.
    //
    // Keyed there deliberately. A pilot is bounds for ONE programme (#149 pilot
    // cohort 1), and a single global slot would additionally make this table a
    // shared resource between parallel realdb test files — the
    // `match_policy_versions_active_key` hazard, which this repository has
    // already paid for once. The admission gate then reads the cohort by the
    // programme the TOUCH names, so there is no configured string a deployment
    // could point somewhere else.
    uniqueIndex('referral_pilot_cohorts_active_program_key')
      .on(t.programId)
      .where(sql`${t.status} = 'active'`),
    index('referral_pilot_cohorts_key_idx').on(t.cohortKey, t.status),
  ],
);

/**
 * `referral_pilot_partners` — the explicit allow-list (#149 pilot cohort 4).
 *
 * Per COHORT VERSION and cascading from it, so widening the partner set is the
 * same act as publishing a new cohort: there is no way to add a partner to a
 * pilot that is already running, which is "do not silently expand" at the grain
 * it actually gets violated. A trigger refuses an INSERT against a published
 * cohort; DELETE is permitted, because removing narrows.
 *
 * `partner_id` is a REAL foreign key with `restrict`. A partner named by a live
 * pilot cannot be deleted out from under it, and unlike an Oxy account id this
 * one is Mercaria's own primary key.
 */
export const referralPilotPartners = pgTable(
  'referral_pilot_partners',
  {
    id: generatedId(),
    cohortId: text()
      .notNull()
      .references(() => referralPilotCohorts.id, { onDelete: 'cascade' }),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    /** Who put this partner in the pilot. Mandatory: an allow-list entry is a decision. */
    addedByOxyUserId: text().notNull(),
    /** Why this partner. The evidence, in words — read by a person, never matched on. */
    note: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('referral_pilot_partners_note_check', sql`length(${t.note}) > 0`),
    uniqueIndex('referral_pilot_partners_cohort_partner_key').on(t.cohortId, t.partnerId),
    index('referral_pilot_partners_partner_idx').on(t.partnerId),
  ],
);

/**
 * `referral_pilot_stop_thresholds` — the twelve #149 names, per cohort version.
 *
 * `UNIQUE(cohort_id, metric)` is what makes a threshold a single fact: two rows
 * for one metric would let a lenient one hide a strict one depending on which
 * the evaluator read first.
 *
 * The UNIT is stored beside the value because the twelve do not share one —
 * "> 2% of conversions", "> €500 net negative" and "one privacy incident" are
 * three different kinds of number, and comparing them as if they were one is
 * how a rate gets read as a count and never fires.
 */
export const referralPilotStopThresholds = pgTable(
  'referral_pilot_stop_thresholds',
  {
    id: generatedId(),
    cohortId: text()
      .notNull()
      .references(() => referralPilotCohorts.id, { onDelete: 'cascade' }),
    metric: text({ enum: asEnumValues(REFERRAL_PILOT_STOP_METRICS) }).notNull(),
    unit: text({ enum: asEnumValues(REFERRAL_PILOT_THRESHOLD_UNITS) }).notNull(),
    /**
     * A breach is `observed > threshold`, STRICTLY. So a one-occurrence stop —
     * a privacy incident, a critical security finding — is written with a
     * threshold of ZERO and fires on the first. One comparator, one reading, no
     * per-metric exception.
     */
    thresholdValue: bigint({ mode: 'number' }).notNull(),
    /** The trailing window a rate is measured over. `0` means "ever". */
    windowHours: integer().notNull(),
    /** What a breach PAUSES. Per threshold, because the twelve are not equally broad. */
    scope: text({ enum: asEnumValues(REFERRAL_PILOT_STOP_SCOPES) }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'referral_pilot_stop_thresholds_metric_check',
      t.metric,
      REFERRAL_PILOT_STOP_METRICS,
    ),
    checkOneOf(
      'referral_pilot_stop_thresholds_unit_check',
      t.unit,
      REFERRAL_PILOT_THRESHOLD_UNITS,
    ),
    checkOneOf('referral_pilot_stop_thresholds_scope_check', t.scope, REFERRAL_PILOT_STOP_SCOPES),
    check(
      'referral_pilot_stop_thresholds_value_check',
      sql`${t.thresholdValue} >= 0 and ${t.windowHours} >= 0
          and (${t.unit} <> 'rate_bps' or ${t.thresholdValue} <= 10000)`,
    ),
    uniqueIndex('referral_pilot_stop_thresholds_cohort_metric_key').on(t.cohortId, t.metric),
  ],
);

/**
 * `referral_pilot_stops` — a threshold that was crossed, and the entry it paused.
 *
 * ONE live stop per (cohort, metric, scope, subject) by a partial unique, so two
 * evaluations of one breach converge on one row rather than paging twice — the
 * `retail_suppressions` device (#121).
 *
 * A LIFT keeps the row. Nothing here deletes: a pilot that stopped and was
 * restarted is the most important thing in its own history, and the review
 * #149 acceptance 7 asks for is unreadable without it.
 */
export const referralPilotStops = pgTable(
  'referral_pilot_stops',
  {
    id: generatedId(),
    cohortId: text()
      .notNull()
      .references(() => referralPilotCohorts.id, { onDelete: 'restrict' }),
    metric: text({ enum: asEnumValues(REFERRAL_PILOT_STOP_METRICS) }).notNull(),
    scope: text({ enum: asEnumValues(REFERRAL_PILOT_STOP_SCOPES) }).notNull(),
    /**
     * WHICH partner or market this stop covers — empty for a `pilot`-scoped one,
     * which covers everything. A plain text handle rather than a foreign key,
     * because the two non-pilot scopes name two different kinds of thing and a
     * polymorphic pair would be two nullable columns nobody can index.
     */
    scopeRef: text().notNull(),
    origin: text({ enum: asEnumValues(REFERRAL_PILOT_STOP_ORIGINS) }).notNull(),
    observedValue: bigint({ mode: 'number' }).notNull(),
    thresholdValue: bigint({ mode: 'number' }).notNull(),
    raisedAt: timestamptz().notNull(),
    /**
     * NULL for an `automatic` stop and NOT NULL for an `operator` one — a CHECK.
     * Attributing a threshold evaluation to a person makes the audit trail say
     * something false; leaving an operator's decision unattributed makes it say
     * nothing.
     */
    raisedByOxyUserId: text(),
    detail: text().notNull(),
    liftedAt: timestamptz(),
    liftedByOxyUserId: text(),
    liftReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_pilot_stops_metric_check', t.metric, REFERRAL_PILOT_STOP_METRICS),
    checkOneOf('referral_pilot_stops_scope_check', t.scope, REFERRAL_PILOT_STOP_SCOPES),
    checkOneOf('referral_pilot_stops_origin_check', t.origin, REFERRAL_PILOT_STOP_ORIGINS),
    check(
      'referral_pilot_stops_origin_raiser_check',
      sql`(${t.origin} = 'operator') = (${t.raisedByOxyUserId} is not null)`,
    ),
    // A lift is attributable, dated and explained, all three or none.
    check(
      'referral_pilot_stops_lift_check',
      sql`num_nonnulls(${t.liftedAt}, ${t.liftedByOxyUserId}, ${t.liftReason}) in (0, 3)`,
    ),
    check(
      'referral_pilot_stops_scope_ref_check',
      sql`(${t.scope} = 'pilot') = (${t.scopeRef} = '')`,
    ),
    uniqueIndex('referral_pilot_stops_live_key')
      .on(t.cohortId, t.metric, t.scope, t.scopeRef)
      .where(sql`${t.liftedAt} is null`),
    index('referral_pilot_stops_cohort_idx').on(t.cohortId, t.raisedAt),
  ],
);
