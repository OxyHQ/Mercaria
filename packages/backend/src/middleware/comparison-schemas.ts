/**
 * Request schemas for the grounded comparison and basket surfaces (#96).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a request cannot propose a value a CHECK, a
 * policy or a solver then refuses.
 *
 * ## What `.strict()` is doing here specifically
 *
 * No schema in this file carries a `price`, a `total`, a `score`, a `rank`, a
 * `commission`, a `plan`, a `boost` or a `merchantWeight` field. Every one of
 * those is DERIVED from #74's ranked offers and this domain's own policy, and a
 * request shape able to carry one would be the second authority the whole issue
 * exists without. `.strict()` is what makes adding one a visible act rather
 * than a field the parser quietly ignores.
 *
 * The constraint language is #94's `productConstraintSchema`, imported rather
 * than restated: two spellings of one grammar is two answers to what a shopper
 * asked for.
 *
 * ## The pickup preference carries no coordinates
 *
 * `pickup: true` and nothing else. Not because #93 publishes no collection
 * points — it has landed — but because a comparison surface has no business
 * holding a position accurate enough to identify a home (#74's rule for the
 * same field, one domain over).
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  BASKET_CHANNEL_POLICIES,
  BASKET_OBJECTIVES,
  CONDITION_GROUPS,
  MAX_CONSTRAINTS_PER_SET,
  type BasketChannelPolicy,
  type BasketObjective,
  type ConditionGroup,
  type CurrencyCode,
} from '@mercaria/shared-types';
import { productConstraintSchema } from './attribute-schemas.js';
import { MAX_BASKET_LINES, MAX_COMPARISON_SUBJECTS } from '../services/comparison/policy.js';

function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

const CURRENCY_VALUES = tuple(ALL_CURRENCY_CODES as readonly CurrencyCode[]);
const CONDITION_GROUP_VALUES = tuple(CONDITION_GROUPS as readonly ConditionGroup[]);
const CHANNEL_POLICY_VALUES = tuple(BASKET_CHANNEL_POLICIES as readonly BasketChannelPolicy[]);
const OBJECTIVE_VALUES = tuple(BASKET_OBJECTIVES as readonly BasketObjective[]);

const handle = z.string().trim().min(1).max(200);
const entityId = z.string().trim().min(1).max(64);
const country = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/u);

/** `POST /comparison` — compare two to eight canonical products. */
export const productComparisonSchema = z
  .object({
    subjects: z
      .array(
        z
          .object({
            handle,
            canonicalVariantId: entityId.optional(),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_COMPARISON_SUBJECTS),
    currency: z.enum(CURRENCY_VALUES).optional(),
    market: country.optional(),
    conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).max(CONDITION_GROUPS.length).optional(),
    /** The category the constraints are scoped to, so #94 can refuse an off-scope one. */
    categoryId: entityId.optional(),
    constraints: z.array(productConstraintSchema).min(1).max(MAX_CONSTRAINTS_PER_SET).optional(),
  })
  .strict();

/** One line of a basket request. Shaped to #81's `WatchlistItem`. */
const basketLineSchema = z
  .object({
    lineId: z.string().trim().min(1).max(64),
    canonicalProductId: entityId,
    canonicalVariantId: entityId.optional(),
    quantity: z.number().int().min(1).max(100),
    conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).min(1).max(CONDITION_GROUPS.length).optional(),
    merchantId: entityId.optional(),
  })
  .strict();

/**
 * `POST /comparison/basket` — solve a basket.
 *
 * Exactly one of `lines` and `watchlistId`, refused as a 400 rather than
 * resolved by a precedence rule nobody would remember — the `addressId`
 * decision in #105, for its reason.
 */
export const basketSolveSchema = z
  .object({
    lines: z.array(basketLineSchema).min(1).max(MAX_BASKET_LINES).optional(),
    /** Solve the caller's own watchlist. Requires #81's source to be registered. */
    watchlistId: entityId.optional(),
    currency: z.enum(CURRENCY_VALUES).optional(),
    market: country.optional(),
    channelPolicy: z.enum(CHANNEL_POLICY_VALUES).optional(),
    /** The DEFAULT every line without its own accepts. #95 produces exactly one. */
    conditionGroups: z
      .array(z.enum(CONDITION_GROUP_VALUES))
      .min(1)
      .max(CONDITION_GROUPS.length)
      .optional(),
    objectives: z.array(z.enum(OBJECTIVE_VALUES)).min(1).max(BASKET_OBJECTIVES.length).optional(),
    maxMerchants: z.number().int().min(1).max(MAX_BASKET_LINES).optional(),
    excludedMerchantIds: z.array(entityId).max(64).optional(),
    /** #93's seam. A bare request; see the module header. */
    pickup: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => (value.lines === undefined) !== (value.watchlistId === undefined),
    { message: 'Provide exactly one of lines or watchlistId' },
  );

/**
 * `POST /comparison/basket/revalidate` — re-check a plan before acting on it.
 *
 * The client hands back the SNAPSHOT and the PLAN it was given, plus the record
 * table that resolves the plan's opaque offer refs. Nothing is looked up from a
 * store, because nothing was stored: a plan served from a table would be the
 * stale plan UX rule 9 forbids.
 *
 * The three parts are validated only for SHAPE here. Their agreement — that the
 * plan's offers are in the snapshot, and that the snapshot's lines cover the
 * plan's — is the service's, and it refuses a mismatched pair rather than
 * answering about a basket nobody has.
 */
export const basketRevalidateSchema = z
  .object({
    snapshot: z
      .object({
        digest: z.string().trim().min(1).max(128),
        policy: z
          .object({
            comparisonPolicyVersion: z.string().trim().min(1).max(64),
            rankingPolicyVersion: z.string().trim().max(64),
            constraintEvaluationVersion: z.string().trim().max(64),
            normalizationRuleVersion: z.string().trim().max(64),
          })
          .strict(),
        evaluatedAt: z.string().trim().min(1).max(40),
        comparisonCurrency: z.enum(CURRENCY_VALUES),
        market: country.optional(),
        request: z
          .object({
            lines: z.array(basketLineSchema).min(1).max(MAX_BASKET_LINES),
            comparisonCurrency: z.enum(CURRENCY_VALUES),
            market: country.optional(),
            channelPolicy: z.enum(CHANNEL_POLICY_VALUES),
            conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).optional(),
            objectives: z.array(z.enum(OBJECTIVE_VALUES)),
            maxMerchants: z.number().int().min(1).max(MAX_BASKET_LINES).optional(),
            excludedMerchantIds: z.array(entityId).max(64).optional(),
            pickupPreference: z.object({ requested: z.literal(true) }).strict().optional(),
          })
          .strict(),
        candidateOfferRefs: z.array(z.string().trim().min(1).max(16)).max(1000),
        rates: z.array(z.record(z.string(), z.unknown())).max(64),
        candidateTerms: z.record(z.string(), z.string().max(128)),
      })
      .strict(),
    plan: z
      .object({
        planDigest: z.string().trim().max(128),
        lines: z
          .array(
            z
              .object({
                lineId: z.string().trim().min(1).max(64),
                offerRef: z.string().trim().min(1).max(16),
              })
              .passthrough(),
          )
          .max(MAX_BASKET_LINES),
      })
      .passthrough(),
    records: z
      .array(
        z
          .object({
            ref: z.string().trim().min(1).max(16),
            kind: z.string().trim().min(1).max(32),
            recordId: z.string().trim().min(1).max(64),
          })
          .passthrough(),
      )
      .max(2000),
  })
  .strict();
