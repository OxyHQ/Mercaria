/**
 * Request schemas for the price-history surfaces (#78).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a schema cannot accept a value the database
 * CHECK then refuses.
 *
 * `.strict()` is doing specific work here. There is no field on any of these
 * for a referral partner, a referred customer, a commission, a campaign or an
 * attribution — #78 §"Referral boundary" — and no field for an alert threshold
 * or a subscription, which belong to #79. A request shape able to carry one is
 * the first step towards a response that answers it.
 *
 * There is also no schema for WRITING a price observation. Observations are
 * produced by the offer write path from a source Mercaria actually read; an
 * HTTP surface able to submit one would be a way to publish a price nobody
 * observed, which is the one thing an auditable price history cannot survive.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  PRICE_SERIES_GRANULARITIES,
  PRICE_SERIES_MEASURES,
  type ConditionGroup,
  type CurrencyCode,
  type PriceSeriesGranularity,
  type PriceSeriesMeasure,
} from '@mercaria/shared-types';

const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const SEGMENT_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const MEASURE_VALUES = PRICE_SERIES_MEASURES as readonly [PriceSeriesMeasure, ...PriceSeriesMeasure[]];
const GRANULARITY_VALUES = PRICE_SERIES_GRANULARITIES as readonly [
  PriceSeriesGranularity,
  ...PriceSeriesGranularity[],
];

const entityId = z.string().trim().min(1).max(64);
/** ISO 3166-1 alpha-2, matching `offer_price_series_market_check` rather than approximating it. */
const market = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);
const isoInstant = z.string().trim().datetime();

/**
 * `GET /price-history` — one series, in one currency, over one range.
 *
 * ### Exactly one scope, and the currency is REQUIRED
 *
 * A chart with no named display currency is the shape issue currency rule 2
 * refuses ("product history queries name one display currency"), and defaulting
 * it here would put ONE currency into the contract — which is exactly what
 * currency rules 8 and 9 keep out: a currency being representable does not make
 * it a rail, and no particular one may be assumed until a real integration
 * defines it.
 *
 * ### The SEGMENT is required too
 *
 * Acceptance 2 keeps new, refurbished and used history separate. An optional
 * segment would mean answering "all conditions" for a caller who omitted it,
 * which is precisely the blend the acceptance forbids — so the caller states
 * which question they are asking.
 */
export const priceHistoryQuerySchema = z
  .object({
    canonicalProductId: entityId.optional(),
    canonicalVariantId: entityId.optional(),
    market: market.optional(),
    currency: z.enum(CURRENCY_VALUES),
    segment: z.enum(SEGMENT_VALUES),
    measure: z.enum(MEASURE_VALUES),
    granularity: z.enum(GRANULARITY_VALUES).default('day'),
    from: isoInstant,
    to: isoInstant,
    merchantId: entityId.optional(),
    storefrontId: entityId.optional(),
    /**
     * Opt IN to seeing old amounts reinterpreted at today's rate (currency rule
     * 5). Off by default: the honest answer to "I cannot price that in your
     * currency" is silence, not a number with a footnote.
     */
    allowCurrentRateReinterpretation: z.enum(['true', 'false']).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.canonicalProductId) !== Boolean(value.canonicalVariantId),
    { message: 'Provide exactly one of canonicalProductId or canonicalVariantId.' },
  )
  .refine((value) => !(value.merchantId && value.storefrontId), {
    message: 'Provide at most one of merchantId or storefrontId.',
  })
  .refine((value) => new Date(value.from) < new Date(value.to), {
    message: '`from` must be before `to`.',
  });

/** `GET /internal/price-history/metrics` — the operational window. */
export const priceHistoryMetricsQuerySchema = z
  .object({ windowDays: z.coerce.number().int().min(1).max(90).default(7) })
  .strict();

/**
 * `POST /internal/price-history/series/rebuild` — run one series now.
 *
 * It DRIVES the existing idempotent path rather than adding a new way to write
 * a point: the body names a series and the dispatcher rebuilds it with the same
 * function it always uses. There is deliberately no "set this point", no "hide
 * this observation" and no delete — every one of those would be a way to make a
 * price history say something nobody observed.
 */
export const priceHistoryRebuildSchema = z
  .object({
    canonicalProductId: entityId.optional(),
    canonicalVariantId: entityId.optional(),
    market: market.optional(),
    currency: z.enum(CURRENCY_VALUES),
    granularity: z.enum(GRANULARITY_VALUES).default('day'),
  })
  .strict()
  .refine(
    (value) => Boolean(value.canonicalProductId) !== Boolean(value.canonicalVariantId),
    { message: 'Provide exactly one of canonicalProductId or canonicalVariantId.' },
  );
