/**
 * UserPreference model — a consumer's marketplace-scoped preferences, keyed by
 * their Oxy user id.
 *
 * Currently holds the dual-currency DISPLAY preference: a `secondaryCurrency`
 * shown alongside the canonical FAIR amount and whether dual display is enabled.
 * These are presentation-only — they NEVER affect the amounts Mercaria stores
 * (every price is persisted in FAIR).
 *
 * `secondaryCurrency` is nullable: `null` means the consumer has not chosen one
 * and the client picks a locale default. The `enum` lists the supported codes;
 * mongoose skips enum validation for a `null`/`undefined` value on a
 * non-required field, so `default: null` is valid.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { CurrencyCode } from '@mercaria/shared-types';

const CURRENCY_CODES: readonly CurrencyCode[] = ['FAIR', 'USD', 'EUR', 'GBP'];

export interface IUserPreference {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  secondaryCurrency: CurrencyCode | null;
  dualDisplayEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserPreferenceSchema = new Schema<IUserPreference>(
  {
    oxyUserId: { type: String, required: true, unique: true, index: true },
    secondaryCurrency: { type: String, enum: CURRENCY_CODES as string[], default: null },
    dualDisplayEnabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const UserPreference: Model<IUserPreference> =
  mongoose.models.UserPreference ||
  mongoose.model<IUserPreference>('UserPreference', UserPreferenceSchema);
