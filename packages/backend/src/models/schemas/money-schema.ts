/**
 * Reusable embedded `Money` sub-schema.
 *
 * `Money` amounts are integer minor units (cents) with an ISO-4217 currency.
 * This sub-document is embedded (no own `_id`) wherever a model stores a price
 * (listing price range, variant price/compareAt, …) so the persisted shape
 * matches the `Money` DTO exactly.
 */

import { Schema } from 'mongoose';
import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';

/**
 * The set of supported currency codes — the SINGLE runtime source from
 * `@mercaria/shared-types` (`ALL_CURRENCY_CODES`), derived from the exhaustive
 * `CURRENCY_PRECISION` map. Re-exported here so schemas stay in lockstep with the
 * DTO set as currencies are added; never re-declare a literal list.
 */
export const CURRENCY_CODES = ALL_CURRENCY_CODES;

/** Embedded `{ amount, currency }` sub-schema (no own `_id`). */
export const MoneySchema = new Schema(
  {
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCY_CODES as string[], required: true },
  },
  { _id: false },
);

/**
 * Embedded `{ shop, presentment }` dual-currency sub-schema (no own `_id`). A
 * transacted amount carried in BOTH the store's settlement currency (`shop`) and
 * the buyer's presentment currency (`presentment`) — the persisted shape of the
 * `DualMoney` DTO. Used by orders/refunds for every line/total money field.
 */
export const DualMoneySchema = new Schema(
  {
    shop: { type: MoneySchema, required: true },
    presentment: { type: MoneySchema, required: true },
  },
  { _id: false },
);
