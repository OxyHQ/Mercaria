/**
 * UserPreference model — a consumer's marketplace-scoped preferences, keyed by
 * their Oxy user id.
 *
 * Currently holds the currency DISPLAY preference: a `preferredCurrency` (the
 * primary currency to show prices in), a `secondaryCurrency` shown alongside the
 * canonical FAIR amount, and whether dual display is enabled. These are
 * presentation-only — they NEVER affect the amounts Mercaria stores (every price
 * is persisted in FAIR).
 *
 * `preferredCurrency`/`secondaryCurrency` are nullable: `null` means the consumer
 * has not chosen one and the client falls back to FAIR/a locale default. The
 * `enum` lists the supported codes; mongoose skips enum validation for a
 * `null`/`undefined` value on a non-required field, so `default: null` is valid.
 */

import mongoose, { Schema, Model } from 'mongoose';
import { ALL_CURRENCY_CODES, type CurrencyCode } from '@mercaria/shared-types';

export interface IUserPreference {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  preferredCurrency: CurrencyCode | null;
  secondaryCurrency: CurrencyCode | null;
  dualDisplayEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserPreferenceSchema = new Schema<IUserPreference>(
  {
    oxyUserId: { type: String, required: true, unique: true, index: true },
    preferredCurrency: { type: String, enum: ALL_CURRENCY_CODES as string[], default: null },
    secondaryCurrency: { type: String, enum: ALL_CURRENCY_CODES as string[], default: null },
    dualDisplayEnabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const UserPreference: Model<IUserPreference> =
  mongoose.models.UserPreference ||
  mongoose.model<IUserPreference>('UserPreference', UserPreferenceSchema);
