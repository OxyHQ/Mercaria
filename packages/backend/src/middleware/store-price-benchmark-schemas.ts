/**
 * Request schemas for a store's competitive price analytics
 * (`/admin/stores/:storeId/price-analytics/*`).
 *
 * `.strict()`, and there is no field for a price, a target, a rule or a
 * schedule: this surface READS a comparison and never writes one, so a request
 * shape able to carry a price would be the first step towards a tool that sets
 * one — #82's §"Recommendations" prohibition, kept for the paid tool too.
 */

import { z } from 'zod';
import {
  STORE_PRICE_TREND_GRANULARITIES,
  STORE_PRICE_TREND_WINDOWS_DAYS,
  type StorePriceTrendGranularity,
} from '@mercaria/shared-types';

const GRANULARITY_VALUES = STORE_PRICE_TREND_GRANULARITIES as readonly [
  StorePriceTrendGranularity,
  ...StorePriceTrendGranularity[],
];

/** An ISO 3166-1 alpha-2 market, upper-cased. */
const market = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'market must be a two-letter country code')
  .transform((value) => value.toUpperCase())
  .optional();

/** GET …/price-analytics/listings — the overview, as JSON or CSV. */
export const storePriceAnalyticsQuerySchema = z
  .object({
    market,
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

/** GET …/price-analytics/listings/:productVariantId/trend */
export const storePriceTrendQuerySchema = z
  .object({
    market,
    windowDays: z.coerce
      .number()
      .int()
      .refine(
        (value) => (STORE_PRICE_TREND_WINDOWS_DAYS as readonly number[]).includes(value),
        `windowDays must be one of ${STORE_PRICE_TREND_WINDOWS_DAYS.join(', ')}`,
      )
      .default(30),
    granularity: z.enum(GRANULARITY_VALUES).default('day'),
  })
  .strict();
