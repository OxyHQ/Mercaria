/**
 * Request schemas for the offer-comparison surfaces (#74).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a request cannot propose a value a CHECK then
 * refuses.
 *
 * `.strict()` is doing specific work here. No schema in this file carries a
 * `score`, a `rank`, a `label`, a `weight`, a `commission`, a `plan` or a
 * `boost` field, so no HTTP caller can propose any of them — every one is
 * DERIVED from a policy version and the offers in front of it, and a request
 * shape able to carry one would be the second authority this domain exists
 * without. The PUBLIC schema additionally carries no `policyVersion` and no
 * `diagnostic`: a shopper who could name a policy version could shop for
 * whichever ordering suited them, and the comparison they are shown must be the
 * one the rollout decided.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  ANALYTICS_METRIC_KEYS,
  CONDITION_GROUPS,
  ITEM_CONDITION_KEYS,
  OFFER_COMPARISON_EXPERIENCES,
  OFFER_COMPARISON_INTENTS,
  OFFER_CUSTOMER_ELIGIBILITIES,
  type ConditionGroup,
  type CurrencyCode,
  type ItemConditionKey,
  type OfferComparisonExperience,
  type OfferComparisonIntent,
  type OfferCustomerEligibility,
} from '@mercaria/shared-types';

function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('An empty enum accepts nothing and types every value never');
  return [first, ...rest];
}

const CURRENCY_VALUES = tuple(ALL_CURRENCY_CODES as readonly CurrencyCode[]);
const INTENT_VALUES = tuple(OFFER_COMPARISON_INTENTS as readonly OfferComparisonIntent[]);
const EXPERIENCE_VALUES = tuple(
  OFFER_COMPARISON_EXPERIENCES as readonly OfferComparisonExperience[],
);
const CONDITION_KEY_VALUES = tuple(ITEM_CONDITION_KEYS as readonly ItemConditionKey[]);
const CONDITION_GROUP_VALUES = tuple(CONDITION_GROUPS as readonly ConditionGroup[]);
const CUSTOMER_CLASS_VALUES = tuple(
  OFFER_CUSTOMER_ELIGIBILITIES as readonly OfferCustomerEligibility[],
);
const METRIC_KEY_VALUES = tuple(ANALYTICS_METRIC_KEYS);

const entityId = z.string().trim().min(1).max(64);
const country = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);

/** A comma-separated query value, as a browser and a fetch client both send it. */
function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
}

/**
 * `GET /offer-comparison` — the ranked read.
 *
 * The viewer's coordinates are accepted at ONE decimal place of precision and
 * no more (`multipleOf`), which is roughly 11 km: a pickup-distance ranking
 * needs a neighbourhood and a comparison surface has no business holding a
 * position accurate enough to identify a home. They are used and discarded —
 * nothing in this domain stores a coordinate, and no column exists that could.
 */
export const offerComparisonQuerySchema = z
  .object({
    canonicalVariantId: entityId.optional(),
    canonicalProductId: entityId.optional(),
    currency: z.enum(CURRENCY_VALUES).optional(),
    intent: z.enum(INTENT_VALUES).optional(),
    experience: z.enum(EXPERIENCE_VALUES).optional(),
    market: country.optional(),
    customerClasses: commaList(CUSTOMER_CLASS_VALUES).optional(),
    conditions: commaList(CONDITION_KEY_VALUES).optional(),
    conditionGroups: commaList(CONDITION_GROUP_VALUES).optional(),
    viewerLatitude: z.coerce.number().min(-90).max(90).multipleOf(0.1).optional(),
    viewerLongitude: z.coerce.number().min(-180).max(180).multipleOf(0.1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (query) => (query.canonicalVariantId ? 1 : 0) + (query.canonicalProductId ? 1 : 0) === 1,
    { message: 'Provide exactly one of canonicalVariantId or canonicalProductId' },
  )
  .refine(
    (query) =>
      (query.viewerLatitude === undefined) === (query.viewerLongitude === undefined),
    { message: 'Provide both viewerLatitude and viewerLongitude, or neither' },
  );

/**
 * `POST /internal/ranking/policies` — publish a DRAFT.
 *
 * Every weight is required and none has a default. A defaulted weight is a
 * policy term nobody chose, and the whole point of a version is that somebody
 * chose every number in it.
 *
 * The two metric lists are `.min(1)` here as well as CHECKed on the row, for the
 * reason the CHECK exists: "evaluate click and conversion outcomes ALONGSIDE
 * trust guardrails, not as the only objective" has to be true of every version
 * that ever exists, and a schema that accepted an empty guardrail list would
 * turn a policy decision into a database error somebody reads as a bug.
 */
const weight = z.number().min(0).max(100);

export const rankingPolicyCreateSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    description: z.string().trim().min(10).max(2_000),
    weights: z
      .object({
        item_price: weight,
        delivery_cost: weight,
        tax_inclusion: weight,
        delivery_speed: weight,
        condition: weight,
        merchant_rating: weight,
        return_policy: weight,
        availability_confidence: weight,
        observation_freshness: weight,
        verified_relationship: weight,
        pickup_proximity: weight,
      })
      .strict(),
    minReviewCount: z.number().int().min(0).max(10_000),
    dominanceWindow: z.number().int().min(1).max(100),
    dominanceShare: z.number().gt(0).max(1),
    objectiveMetricKeys: z.array(z.enum(METRIC_KEY_VALUES)).min(1).max(METRIC_KEY_VALUES.length),
    guardrailMetricKeys: z.array(z.enum(METRIC_KEY_VALUES)).min(1).max(METRIC_KEY_VALUES.length),
  })
  .strict()
  .refine(
    (body) => Object.values(body.weights).some((value) => value > 0),
    { message: 'At least one weight must be positive' },
  );

/** `POST /internal/ranking/policies/:id/canary` — start or ramp one. */
export const rankingPolicyCanarySchema = z
  .object({
    /** Basis points of comparison SUBJECTS, never of people. */
    shareBps: z.number().int().min(1).max(10_000),
  })
  .strict();

/** `POST /internal/ranking/policies/:id/activate` — promote it. */
export const rankingPolicyActivateSchema = z.object({}).strict();

/**
 * `GET /internal/ranking/compare` — two policy versions over ONE input.
 *
 * Both versions are named explicitly. Defaulting the baseline to "whatever is
 * active right now" would make the same request answer differently after an
 * activation, which is exactly the property a canary review needs not to have.
 */
export const rankingComparisonQuerySchema = z
  .object({
    canonicalVariantId: entityId.optional(),
    canonicalProductId: entityId.optional(),
    baselineVersion: z.string().trim().min(1).max(64),
    candidateVersion: z.string().trim().min(1).max(64),
    currency: z.enum(CURRENCY_VALUES),
    intent: z.enum(INTENT_VALUES).optional(),
    market: country.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (query) => (query.canonicalVariantId ? 1 : 0) + (query.canonicalProductId ? 1 : 0) === 1,
    { message: 'Provide exactly one of canonicalVariantId or canonicalProductId' },
  );

/** `GET /internal/ranking/trace` — one comparison, exclusions included. */
export const rankingTraceQuerySchema = z
  .object({
    canonicalVariantId: entityId.optional(),
    canonicalProductId: entityId.optional(),
    currency: z.enum(CURRENCY_VALUES),
    intent: z.enum(INTENT_VALUES).optional(),
    market: country.optional(),
    policyVersion: z.string().trim().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (query) => (query.canonicalVariantId ? 1 : 0) + (query.canonicalProductId ? 1 : 0) === 1,
    { message: 'Provide exactly one of canonicalVariantId or canonicalProductId' },
  );
