/**
 * Reusable embedded `Money` sub-schema.
 *
 * `Money` amounts are integer minor units (cents) with an ISO-4217 currency.
 * This sub-document is embedded (no own `_id`) wherever a model stores a price
 * (listing price range, variant price/compareAt, …) so the persisted shape
 * matches the `Money` DTO exactly.
 */

import { Schema } from 'mongoose';
import { ALL_CURRENCY_CODES, MAX_MONEY_MINOR_UNITS } from '@mercaria/shared-types';

/**
 * The set of supported currency codes — the SINGLE runtime source from
 * `@mercaria/shared-types` (`ALL_CURRENCY_CODES`), derived from the exhaustive
 * `CURRENCY_PRECISION` map. Re-exported here so schemas stay in lockstep with the
 * DTO set as currencies are added; never re-declare a literal list.
 */
export const CURRENCY_CODES = ALL_CURRENCY_CODES;

/**
 * Embedded `{ amount, currency }` sub-schema (no own `_id`).
 *
 * `amount` is validated as a finite INTEGER count of minor units within
 * `MAX_MONEY_MINOR_UNITS`. This is the LAST line of the amount-safety chain, not
 * the first — the request schemas reject an out-of-range amount with a 400 long
 * before it reaches here, and the pricing/FX/refund paths assert their own
 * outputs. It exists because persistence is the one boundary EVERY write passes
 * through, so a path that skips the others still cannot store an amount whose
 * arithmetic would silently lose minor units. The magnitude bound is
 * sign-agnostic: a stored amount may legitimately be negative.
 */
export const MoneySchema = new Schema(
  {
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (value: number): boolean =>
          Number.isInteger(value) && Math.abs(value) <= MAX_MONEY_MINOR_UNITS,
        message: (props: { value: number }): string =>
          `Money amount ${props.value} must be an integer count of minor units ` +
          `within ±${MAX_MONEY_MINOR_UNITS}`,
      },
    },
    currency: { type: String, enum: CURRENCY_CODES as string[], required: true },
  },
  { _id: false },
);

/**
 * Embedded `{ shop, presentment }` dual-currency sub-schema (no own `_id`). A
 * transacted amount carried in BOTH the seller's accounting currency (`shop`) and
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
