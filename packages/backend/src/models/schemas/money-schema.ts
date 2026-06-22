/**
 * Reusable embedded `Money` sub-schema.
 *
 * `Money` amounts are integer minor units (cents) with an ISO-4217 currency.
 * This sub-document is embedded (no own `_id`) wherever a model stores a price
 * (listing price range, variant price/compareAt, …) so the persisted shape
 * matches the `Money` DTO exactly.
 */

import { Schema } from 'mongoose';
import type { CurrencyCode } from '@mercaria/shared-types';

/** The set of supported currency codes, mirrored from the `CurrencyCode` DTO. */
export const CURRENCY_CODES: readonly CurrencyCode[] = ['FAIR', 'USD', 'EUR', 'GBP'];

/** Embedded `{ amount, currency }` sub-schema (no own `_id`). */
export const MoneySchema = new Schema(
  {
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCY_CODES as string[], required: true },
  },
  { _id: false },
);
