/**
 * The ranking policy in force, and how a comparison is routed to it (#74
 * §"Policy and evaluation" 1, acceptance 7).
 *
 * PURE. It reads no database, no configuration and no clock — a policy row
 * arrives as an argument and a built-in one is a constant — so "which policy
 * would this subject get" is answerable from a table of inputs instead of from
 * a seeded deployment.
 *
 * ## There is a BUILT-IN policy, and it is a real version
 *
 * #58 and #121 answer `unknown` when no policy version is active, because a
 * compliance verdict with no policy behind it is evidence of nothing. This
 * domain deliberately does the opposite, and the asymmetry is the reason: a
 * missing compliance policy means Mercaria has not established that it may sell
 * something, while a missing ranking policy means only that nobody has published
 * weights yet. Refusing there withholds a sale; refusing here would withhold the
 * comparison surface itself on every fresh deployment, including the one that
 * ships it.
 *
 * So {@link BUILTIN_RANKING_POLICY} is a named, versioned, immutable value in
 * code, every ranked result says which policy produced it, and an impression
 * logged under `builtin-2026-08-v1` is exactly as traceable as one logged under
 * a published version. Changing it is a code change with a NEW version string —
 * never an edit to the existing one, for the same reason a published row is
 * frozen once it has served traffic.
 *
 * ## The canary bucket is keyed on the SUBJECT, not on a person
 *
 * A comparison is routed by hashing the canonical variant or product being
 * compared. That is deterministic (the same product always gets the same arm,
 * so a shopper does not see the order flip between refreshes), reproducible from
 * the operator surface with no session in hand, and carries no identity at all —
 * there is no actor, session or device in the preimage, so a rollout cannot
 * become a per-person experiment by accident. #77 owns experiments on people;
 * this owns a rollout over the catalogue.
 */

import { createHash } from 'node:crypto';
import type {
  RankingPolicy,
  RankingPolicyArm,
  RankingWeights,
} from '@mercaria/shared-types';

/**
 * The one policy key this surface uses.
 *
 * A code CONSTANT, following the house rule every other versioned policy
 * follows: the key names a procedure the deployed code implements, and a
 * configurable one would let a deployment publish a version under a key nothing
 * reads.
 */
export const OFFER_COMPARISON_POLICY_KEY = 'offer-comparison';

/**
 * The weights the built-in policy scores with.
 *
 * A `Record` over the signal union, so a signal added to
 * `OFFER_RANKING_SIGNALS` without a weight fails `tsc` here rather than
 * defaulting to zero somewhere in a loop.
 *
 * The shape of the numbers is a product judgement and is stated so it can be
 * argued with: price dominates because this is a price comparison; delivery cost
 * follows it because a cheap item with expensive postage is not cheap; merchant
 * rating and a verified relationship sit next because they are the two trust
 * facts a shopper cannot check themselves; freshness and tax inclusion are small
 * because both are frequently unknown and an unknown signal contributes nothing
 * either way.
 */
export const BUILTIN_RANKING_WEIGHTS: RankingWeights = Object.freeze({
  item_price: 3,
  delivery_cost: 1.5,
  tax_inclusion: 0.5,
  delivery_speed: 1,
  condition: 1,
  merchant_rating: 1.5,
  return_policy: 0.5,
  availability_confidence: 1,
  observation_freshness: 0.5,
  verified_relationship: 1,
  pickup_proximity: 0.5,
});

/**
 * The policy a deployment that has published none uses.
 *
 * Its `version` is a real string an impression records and an operator quotes.
 * Bumping the weights means bumping the version in the SAME change — a built-in
 * policy whose weights moved under an unchanged name would make every logged
 * impression before the deploy and after it claim to be the same policy.
 */
export const BUILTIN_RANKING_POLICY: RankingPolicy = Object.freeze({
  policyKey: OFFER_COMPARISON_POLICY_KEY,
  version: 'builtin-2026-08-v1',
  source: 'builtin',
  arm: 'active',
  weights: BUILTIN_RANKING_WEIGHTS,
  minReviewCount: 3,
  dominanceWindow: 5,
  dominanceShare: 0.6,
  evaluation: Object.freeze({
    /** What a change is trying to improve. */
    objectiveMetricKeys: Object.freeze([
      'product_to_offer_selection_rate',
      'native_checkout_conversion',
    ]),
    /**
     * What may not get worse while it does (issue policy rule 5).
     *
     * Coverage and freshness, deliberately: the two ways a ranking change makes
     * the numbers look better by making the comparison worse — concentrating on
     * one source that happens to convert, and favouring whatever was crawled
     * most recently.
     */
    guardrailMetricKeys: Object.freeze(['source_coverage_gap', 'query_latency_and_freshness']),
  }),
});

/**
 * Decide which arm a comparison subject is routed to.
 *
 * Monotone in the share by construction: the bucket is a property of the
 * SUBJECT alone, so raising a canary from 5% to 25% only ADDS subjects and never
 * moves one back onto the active arm mid-ramp. That is why the share is the one
 * column the immutability trigger lets an operator move.
 *
 * `canaryShareBps` of zero — which is every non-canary row, by CHECK — always
 * yields `active`, so a deployment with no canary needs no branch anywhere else.
 */
export function resolveRankingArm(input: {
  policyKey: string;
  subjectKey: string;
  canaryShareBps: number;
}): RankingPolicyArm {
  if (input.canaryShareBps <= 0) return 'active';
  const digest = createHash('sha256')
    .update(`${input.policyKey}:${input.subjectKey}`)
    .digest();
  // Four bytes is plenty of spread for a 0–9999 bucket and costs nothing to
  // read; `readUInt32BE` is exact where a float division of a hex string is not.
  const bucket = digest.readUInt32BE(0) % 10_000;
  return bucket < input.canaryShareBps ? 'canary' : 'active';
}

/** The stored columns a policy version's weights come out of. */
export interface RankingPolicyWeightColumns {
  readonly weightItemPrice: number;
  readonly weightDeliveryCost: number;
  readonly weightTaxInclusion: number;
  readonly weightDeliverySpeed: number;
  readonly weightCondition: number;
  readonly weightMerchantRating: number;
  readonly weightReturnPolicy: number;
  readonly weightAvailabilityConfidence: number;
  readonly weightObservationFreshness: number;
  readonly weightVerifiedRelationship: number;
  readonly weightPickupProximity: number;
}

/**
 * Project a stored version into the {@link RankingPolicy} the scorer reads.
 *
 * Written out column by column rather than by a name transform, the
 * `provider_accounts` projection discipline: a `weight_` prefix stripped
 * programmatically would silently pick up any future column that happened to
 * start with it, and the whole point of one column per signal is that the set is
 * enumerated.
 */
export function rankingPolicyFromRow(
  row: RankingPolicyWeightColumns & {
    readonly policyKey: string;
    readonly version: string;
    readonly minReviewCount: number;
    readonly dominanceWindow: number;
    readonly dominanceShare: number;
    readonly objectiveMetricKeys: readonly string[];
    readonly guardrailMetricKeys: readonly string[];
  },
  arm: RankingPolicyArm,
): RankingPolicy {
  return {
    policyKey: row.policyKey,
    version: row.version,
    source: 'published',
    arm,
    weights: {
      item_price: row.weightItemPrice,
      delivery_cost: row.weightDeliveryCost,
      tax_inclusion: row.weightTaxInclusion,
      delivery_speed: row.weightDeliverySpeed,
      condition: row.weightCondition,
      merchant_rating: row.weightMerchantRating,
      return_policy: row.weightReturnPolicy,
      availability_confidence: row.weightAvailabilityConfidence,
      observation_freshness: row.weightObservationFreshness,
      verified_relationship: row.weightVerifiedRelationship,
      pickup_proximity: row.weightPickupProximity,
    },
    minReviewCount: row.minReviewCount,
    dominanceWindow: row.dominanceWindow,
    dominanceShare: row.dominanceShare,
    evaluation: {
      objectiveMetricKeys: row.objectiveMetricKeys,
      guardrailMetricKeys: row.guardrailMetricKeys,
    },
  };
}
