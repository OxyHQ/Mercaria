/**
 * The ranking policy register (#74): `ranking_policy_versions`.
 *
 * ONE table, and the shape of it is the whole argument.
 *
 * ## The weights are COLUMNS, one per signal, and that is the prohibition
 *
 * `match_policy_versions` is the precedent — a closed set of features, one
 * column each — and here it does a second job. `OFFER_FORBIDDEN_RANKING_SIGNALS`
 * names eleven things that may never influence organic rank, and the strongest
 * possible statement of that is not a CHECK: it is that **no column exists to
 * hold one**. There is no `weight_affiliate_commission`, no `weight_plan`, no
 * `weight_fair`, no `weight_native`. A jsonb weight bag would have undone all of
 * it in one line, which is why there is not one (`analytics_events`' reasoning,
 * applied to a policy).
 *
 * ## Immutable once it has served traffic
 *
 * From `canary` onward every economic column is frozen by the
 * `ranking_policy_versions_immutable_once_serving` trigger (hand-written in the
 * migration, like the fee schedule's and the ledger's). Changing a weight means
 * publishing a NEW version, which is what makes "the same eligible input
 * produces the same order for one policy version" (acceptance 1) a property of
 * the data rather than a promise.
 *
 * `canary_share_bps` is the ONE exception and it is named in the trigger. A ramp
 * from 5% to 25% is a rollout control, not a policy term: the share decides
 * WHICH comparison subjects are routed to the version and never what order any
 * of them gets, and because the bucket is a hash of the subject compared against
 * the share, raising it only ADDS subjects — a subject already on the canary
 * stays on it. Freezing it would make every ramp step a new version, and a
 * version per ramp step makes the impression log unreadable.
 *
 * ## Two partial uniques, because a rollout has exactly two arms
 *
 * At most one `active` and at most one `canary` per policy key. Activation must
 * therefore SUPERSEDE, and a rollback is activating the previous version — which
 * is acceptance 7's "rolled back without re-ingesting offers", true by
 * construction here because ranking is derived at read time from offers this
 * domain never writes.
 *
 * ## What is deliberately NOT stored
 *
 * No impression rows, no evaluation rows, no ranked-result cache. An impression
 * is an `analytics_events` row carrying `ranking_policy_version` (#77's seam,
 * closed by this issue), a comparison between two versions is computed live from
 * one eligible set, and a ranked page is a projection #61 measured the
 * alternative for and adopted no materialized view.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { ANALYTICS_METRIC_KEYS, RANKING_POLICY_STATUSES } from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';

/**
 * A signal weight. `doublePrecision`, matching `match_policy_versions`' feature
 * weights: a weight is a ratio nothing is stored in minor units of, and the
 * score it produces is a 0–1 mean that is never money.
 */
const signalWeight = () => doublePrecision().notNull();

/**
 * `ranking_policy_versions` — one VERSION of one offer-ranking policy.
 *
 * `(policy_key, version)` is the public name an impression records forever; the
 * uuid primary key addresses the operator surface and never leaves the backend
 * (the `fee_schedules` split, for the same reason).
 */
export const rankingPolicyVersions = pgTable(
  'ranking_policy_versions',
  {
    id: generatedId(),
    /**
     * The stable logical id every version of one policy shares.
     *
     * A code CONSTANT today (`OFFER_COMPARISON_POLICY_KEY`), and a column rather
     * than an implied singleton because a second comparison surface with its own
     * policy is a foreseeable thing and a table keyed on nothing is not.
     */
    policyKey: text().notNull(),
    /**
     * The human-readable version an operator quotes and an impression records —
     * `2026-08-v1`. Unique per key FOREVER, superseded rows included: a version
     * string reused for different weights makes every logged impression
     * ambiguous, which is the one thing versioning exists to prevent.
     */
    version: text().notNull(),
    status: text({ enum: asEnumValues(RANKING_POLICY_STATUSES) }).notNull().default('draft'),
    /** What changed and why — read by whoever is deciding whether to roll back. */
    description: text().notNull(),

    // ── The weights: one column per allowed signal, and no column for any other ──
    weightItemPrice: signalWeight(),
    weightDeliveryCost: signalWeight(),
    weightTaxInclusion: signalWeight(),
    weightDeliverySpeed: signalWeight(),
    weightCondition: signalWeight(),
    weightMerchantRating: signalWeight(),
    weightReturnPolicy: signalWeight(),
    weightAvailabilityConfidence: signalWeight(),
    weightObservationFreshness: signalWeight(),
    weightVerifiedRelationship: signalWeight(),
    weightPickupProximity: signalWeight(),

    /**
     * Below this many VERIFIED reviews (#76) a merchant rating is not confident
     * enough to score, and the signal reports `below_confidence_floor` rather
     * than a number.
     *
     * "Merchant rating AND review confidence" is the issue's own phrasing, and
     * this is the confidence half: a single five-star review is not evidence,
     * and scoring it as one would make a brand-new merchant outrank an
     * established one on a sample of one.
     */
    minReviewCount: integer().notNull().default(3),

    /** How many top positions the dominance detector measures over. */
    dominanceWindow: integer().notNull().default(5),
    /** The share of that window one source, merchant or network may hold. */
    dominanceShare: doublePrecision().notNull().default(0.6),

    /**
     * The share of comparison SUBJECTS routed to this version while it is a
     * canary, in basis points.
     *
     * Zero for every other status, which the CHECK below enforces: a version
     * that is not a canary routes nothing by its own share, and an `active` one
     * gets everything the canary did not.
     */
    canaryShareBps: integer().notNull().default(0),

    /**
     * What this version is being judged on, and what may not get worse while it
     * is (issue policy rule 5).
     *
     * Both are #77 metric keys, CHECKed against the same tuple
     * `analytics_rollups.metric_key` reads — so a policy cannot name a number
     * nobody has defined. Naming them is ALL this domain does with them: it
     * reads no measurement, which `analytics-ranking-isolation.test.ts` enforces
     * in both directions.
     *
     * `guardrail_metric_keys` may not be empty. "Evaluate click and conversion
     * outcomes ALONGSIDE trust guardrails, not as the only objective" is a
     * `cardinality(...) >= 1` on the row rather than a sentence somebody has to
     * remember, and the CHECK spells `cardinality` rather than `array_length`
     * because the latter is NULL on `{}` and a CHECK reads NULL as satisfied —
     * the exact spelling that would admit the empty array it exists to refuse.
     */
    objectiveMetricKeys: text().array().notNull().default(sql`'{}'::text[]`),
    guardrailMetricKeys: text().array().notNull().default(sql`'{}'::text[]`),

    /** When it first served traffic — as a canary or as the active version. */
    activatedAt: timestamptz(),
    supersededAt: timestamptz(),
    archivedAt: timestamptz(),

    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who let it serve traffic. The audit half of publishing. */
    approvedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('ranking_policy_versions_status_check', t.status, RANKING_POLICY_STATUSES),
    check('ranking_policy_versions_version_check', sql`btrim(${t.version}) <> ''`),
    check('ranking_policy_versions_description_check', sql`btrim(${t.description}) <> ''`),
    check('ranking_policy_versions_actor_check', sql`btrim(${t.createdByOxyUserId}) <> ''`),

    // Every weight is non-negative — a NEGATIVE weight is a penalty applied to a
    // signal the policy claims to reward, which is not a thing anybody could
    // explain to a seller.
    check(
      'ranking_policy_versions_weights_check',
      sql`${t.weightItemPrice} >= 0 and ${t.weightDeliveryCost} >= 0
          and ${t.weightTaxInclusion} >= 0 and ${t.weightDeliverySpeed} >= 0
          and ${t.weightCondition} >= 0 and ${t.weightMerchantRating} >= 0
          and ${t.weightReturnPolicy} >= 0 and ${t.weightAvailabilityConfidence} >= 0
          and ${t.weightObservationFreshness} >= 0 and ${t.weightVerifiedRelationship} >= 0
          and ${t.weightPickupProximity} >= 0`,
    ),
    // …and at least one is positive. An all-zero policy scores every offer 0 and
    // leaves the whole ordering to the tie-break digest, which is a random
    // shuffle wearing a policy version's name.
    check(
      'ranking_policy_versions_weight_sum_check',
      sql`${t.weightItemPrice} + ${t.weightDeliveryCost} + ${t.weightTaxInclusion}
          + ${t.weightDeliverySpeed} + ${t.weightCondition} + ${t.weightMerchantRating}
          + ${t.weightReturnPolicy} + ${t.weightAvailabilityConfidence}
          + ${t.weightObservationFreshness} + ${t.weightVerifiedRelationship}
          + ${t.weightPickupProximity} > 0`,
    ),

    check('ranking_policy_versions_min_review_count_check', sql`${t.minReviewCount} >= 0`),
    check(
      'ranking_policy_versions_dominance_check',
      sql`${t.dominanceWindow} between 1 and 100
          and ${t.dominanceShare} > 0 and ${t.dominanceShare} <= 1`,
    ),

    // The canary share is a share, and it belongs to a canary. A non-canary
    // carrying one would be a second answer to "who is on the new policy".
    check(
      'ranking_policy_versions_canary_share_check',
      sql`${t.canaryShareBps} between 0 and 10000
          and (${t.status} = 'canary') = (${t.canaryShareBps} > 0)`,
    ),

    // Anything that has served traffic names who let it. Nothing serving is
    // anonymous — the `fee_schedules_activation_audit_check` discipline.
    check(
      'ranking_policy_versions_activation_audit_check',
      sql`${t.status} in ('draft', 'archived')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    check(
      'ranking_policy_versions_superseded_check',
      sql`${t.status} <> 'superseded' or ${t.supersededAt} is not null`,
    ),
    check(
      'ranking_policy_versions_archived_check',
      sql`(${t.status} = 'archived') = (${t.archivedAt} is not null)`,
    ),

    // Both metric lists name #77 metrics and nothing else, and the guardrail
    // list is never empty. `cardinality`, never `array_length` — see the column
    // comment.
    checkEveryElementOf(
      'ranking_policy_versions_objective_metrics_check',
      t.objectiveMetricKeys,
      ANALYTICS_METRIC_KEYS,
    ),
    checkEveryElementOf(
      'ranking_policy_versions_guardrail_metrics_check',
      t.guardrailMetricKeys,
      ANALYTICS_METRIC_KEYS,
    ),
    check(
      'ranking_policy_versions_evaluation_plan_check',
      sql`cardinality(${t.objectiveMetricKeys}) >= 1 and cardinality(${t.guardrailMetricKeys}) >= 1`,
    ),

    uniqueIndex('ranking_policy_versions_key_version_key').on(t.policyKey, t.version),
    // The structural half of "publish a new version": exactly one arm each.
    uniqueIndex('ranking_policy_versions_one_active_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('ranking_policy_versions_one_canary_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'canary'`),
    // The operator surface lists a key's versions newest first.
    index('ranking_policy_versions_key_created_at_idx').on(t.policyKey, t.createdAt.desc()),
  ],
);
