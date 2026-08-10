/**
 * Request schemas for the price-signal surfaces (#82).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a schema cannot accept a value the database CHECK
 * then refuses.
 *
 * `.strict()` is doing specific work here, and it is the same work
 * `PRICE_SIGNAL_FORBIDDEN_INPUTS` does one layer up. There is no field on any of
 * these for a commission, a plan, a fee or a sponsored placement — statistical
 * policy 10 — and there is no field for a PRICE. A request shape able to carry a
 * price is the first step towards a surface that sets one, which
 * §"Recommendations" forbids outright.
 *
 * There is also no schema for writing a signal, a label or an evaluation. A
 * signal is DERIVED from immutable observations under a published policy; an HTTP
 * surface able to submit one would be a way to publish a claim about a price
 * nobody measured.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  ANALYTICS_METRIC_KEYS,
  CONDITION_GROUPS,
  PRICE_SIGNAL_FEEDBACK_REASONS,
  PRICE_SIGNAL_KINDS,
  PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR,
  PRICE_SIGNAL_RUN_MODES,
  type ConditionGroup,
  type CurrencyCode,
  type PriceSignalFeedbackReason,
  type PriceSignalKind,
  type PriceSignalRunMode,
} from '@mercaria/shared-types';

const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const SEGMENT_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const SIGNAL_KIND_VALUES = PRICE_SIGNAL_KINDS as readonly [PriceSignalKind, ...PriceSignalKind[]];
const FEEDBACK_REASON_VALUES = PRICE_SIGNAL_FEEDBACK_REASONS as readonly [
  PriceSignalFeedbackReason,
  ...PriceSignalFeedbackReason[],
];
const RUN_MODE_VALUES = PRICE_SIGNAL_RUN_MODES as readonly [PriceSignalRunMode, ...PriceSignalRunMode[]];
/**
 * `ANALYTICS_METRIC_KEYS` is `ANALYTICS_METRICS.map(...)`, so its non-emptiness
 * is a fact about the data rather than something the type records — the same
 * situation `asEnumValues` handles in the schema layer. It is narrowed here the
 * way that helper does it: by CHECKING at module load, where an empty list is a
 * build-time failure, rather than by asserting through `unknown`.
 */
const METRIC_KEY_VALUES: readonly [string, ...string[]] = (() => {
  const [first, ...rest] = ANALYTICS_METRIC_KEYS;
  if (first === undefined) {
    throw new Error('ANALYTICS_METRIC_KEYS is empty; a policy could name no metric at all.');
  }
  return [first, ...rest];
})();

const entityId = z.string().trim().min(1).max(64);
/** ISO 3166-1 alpha-2, matching the CHECK rather than approximating it. */
const market = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);

/**
 * `GET /price-signals` — one subject's signals.
 *
 * The SEGMENT and the CURRENCY are required, for #78's reason and acceptance 1's:
 * an optional segment means answering "all conditions" for a caller who omitted
 * one, which is precisely the blend "different variants, conditions and
 * currencies never share one unlabeled signal" forbids, and a defaulted currency
 * would put ONE currency into the contract.
 */
export const priceSignalsQuerySchema = z
  .object({
    canonicalProductId: entityId.optional(),
    canonicalVariantId: entityId.optional(),
    segment: z.enum(SEGMENT_VALUES),
    currency: z.enum(CURRENCY_VALUES),
    market: market.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.canonicalProductId) !== Boolean(value.canonicalVariantId), {
    message: 'Provide exactly one of canonicalProductId or canonicalVariantId.',
  });

/**
 * `GET /merchant-competitiveness/:merchantId` — one page of a merchant's own
 * subjects.
 *
 * Keyset-paged on the merchant's OWN offer id and bounded at fifty, because each
 * subject costs a comparison read. `format=csv` is issue UI 4's export, and it is
 * a rendering of exactly the rows the JSON carries rather than a second query
 * with its own idea of what a merchant may see.
 */
export const merchantCompetitivenessQuerySchema = z
  .object({
    segment: z.enum(SEGMENT_VALUES),
    currency: z.enum(CURRENCY_VALUES),
    market: market.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    afterOfferId: entityId.optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

/**
 * `POST /merchant-competitiveness/:merchantId/feedback` — a correction report.
 *
 * The reason is a CLOSED set because monitoring 4 asks for these as a MEASURE of
 * the policy, and free text cannot be counted. The note is optional and bounded;
 * there is no field for a price, a competitor or an offer the merchant does not
 * own.
 */
export const priceSignalFeedbackSchema = z
  .object({
    canonicalProductId: entityId.optional(),
    canonicalVariantId: entityId.optional(),
    segment: z.enum(SEGMENT_VALUES),
    currency: z.enum(CURRENCY_VALUES),
    market: market.optional(),
    signalKind: z.enum(SIGNAL_KIND_VALUES),
    reason: z.enum(FEEDBACK_REASON_VALUES),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.canonicalProductId) !== Boolean(value.canonicalVariantId), {
    message: 'Provide exactly one of canonicalProductId or canonicalVariantId.',
  });

/**
 * `POST /internal/price-signals/policies` — publish a DRAFT.
 *
 * Every threshold is required and none is defaulted here: a policy version is
 * what a claim MEANS, and a default silently supplied by a request schema is a
 * meaning nobody chose. `minDistinctSellers` is floored at the same constant the
 * CHECK reads, so the refusal happens before the round trip and says the same
 * thing the database would.
 */
export const priceSignalPolicyCreateSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(500),
    minObservations: z.number().int().min(1).max(10_000),
    minDistinctSellers: z.number().int().min(PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR).max(1_000),
    minDistinctOffers: z.number().int().min(1).max(10_000),
    minCoverageDays: z.number().int().min(1).max(400),
    recentWindowDays: z.number().int().min(1).max(400),
    outlierModifiedZThreshold: z.number().gt(0).max(100),
    outlierMinDeviationBps: z.number().int().min(1).max(1_000_000),
    materialDropBps: z.number().int().min(1).max(10_000),
    typicalBandBps: z.number().int().min(1).max(10_000),
    goodPriceBelowMedianBps: z.number().int().min(1).max(10_000),
    strongSampleMultiplier: z.number().min(1).max(100),
    objectiveMetricKeys: z.array(z.enum(METRIC_KEY_VALUES)).max(20).default([]),
    /**
     * "Evaluate click and conversion outcomes alongside trust guardrails, not as
     * the only objective" (monitoring 5) — a non-empty list here and a
     * `cardinality(...) >= 1` CHECK on the row, never `array_length`, which is
     * NULL on `{}` and which a CHECK reads as satisfied.
     */
    guardrailMetricKeys: z.array(z.enum(METRIC_KEY_VALUES)).min(1).max(20),
  })
  .strict()
  .refine((value) => value.goodPriceBelowMedianBps >= value.typicalBandBps, {
    message: '`goodPriceBelowMedianBps` must be at least `typicalBandBps`.',
  });

/** `POST /internal/price-signals/policies/:id/{activate,archive}`. */
export const priceSignalPolicyActionSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

/**
 * `POST /internal/price-signals/runs` — queue one measurement sweep.
 *
 * A run names its cohort and its POLICY VERSION explicitly. That is monitoring
 * 6's "policy-version comparison": a `candidate_comparison` run measures a draft
 * over the same cohort as the live one and shows nobody the result, which is why
 * this domain needs no canary and has none.
 */
export const priceSignalRunCreateSchema = z
  .object({
    policyVersion: z.string().trim().min(1).max(64),
    mode: z.enum(RUN_MODE_VALUES).default('monitor'),
    currency: z.enum(CURRENCY_VALUES),
    market: market.optional(),
  })
  .strict();

/** `POST /internal/price-signals/feedback/:id/close`. */
export const priceSignalFeedbackCloseSchema = z
  .object({
    status: z.enum(['resolved', 'rejected']),
    resolutionNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** `GET /internal/price-signals/*` list bounds. */
export const priceSignalListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
