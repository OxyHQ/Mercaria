/**
 * User-preference service — the consumer's dual-currency display preference.
 *
 * Owns the lazy lifecycle + edits of a shopper's `UserPreference`, keyed by Oxy
 * user id. These are presentation-only (`secondaryCurrency`, `dualDisplayEnabled`)
 * and NEVER affect the amounts Mercaria stores — every price stays canonical FAIR.
 */

import type {
  CurrencyCode,
  CurrencyPreference,
  UpdateCurrencyPreferenceInput,
} from '@mercaria/shared-types';
import { UserPreference, type IUserPreference } from '../models/user-preference.js';

/** The presentment-currency fallback when a buyer has chosen no preferred currency. */
const DEFAULT_PRESENTMENT_CURRENCY: CurrencyCode = 'FAIR';

/** Project a preference document down to the wire DTO (display fields only). */
function toCurrencyPreference(
  doc: Pick<IUserPreference, 'preferredCurrency' | 'secondaryCurrency' | 'dualDisplayEnabled'>,
): CurrencyPreference {
  return {
    preferredCurrency: doc.preferredCurrency,
    secondaryCurrency: doc.secondaryCurrency,
    dualDisplayEnabled: doc.dualDisplayEnabled,
  };
}

/**
 * Resolve the buyer's PRESENTMENT currency — the currency their cart/checkout is
 * displayed and charged in. It is their chosen `preferredCurrency`, falling back
 * to FAIR when they have not set one (or have no preference document yet). A pure
 * read (no lazy create), so it never mutates on a checkout/cart hydration.
 */
export async function resolvePresentmentCurrency(oxyUserId: string): Promise<CurrencyCode> {
  const doc = await UserPreference.findOne({ oxyUserId })
    .select('preferredCurrency')
    .lean<Pick<IUserPreference, 'preferredCurrency'> | null>();
  return doc?.preferredCurrency ?? DEFAULT_PRESENTMENT_CURRENCY;
}

/**
 * Get the consumer's currency preference, creating defaults on first use
 * (`dualDisplayEnabled: true`, `secondaryCurrency: null`). Idempotent under
 * concurrent first-writes via an upsert.
 */
export async function getOrCreate(oxyUserId: string): Promise<CurrencyPreference> {
  const doc = await UserPreference.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  ).lean<IUserPreference>();
  return toCurrencyPreference(doc);
}

/**
 * Patch the consumer's currency preference, setting only the fields present in
 * `input`. `secondaryCurrency` may be explicitly `null` to clear it. Lazily
 * creates the preference if absent.
 */
export async function update(
  oxyUserId: string,
  input: UpdateCurrencyPreferenceInput,
): Promise<CurrencyPreference> {
  const set: Record<string, unknown> = {};
  if (input.preferredCurrency !== undefined) {
    set.preferredCurrency = input.preferredCurrency;
  }
  if (input.secondaryCurrency !== undefined) {
    set.secondaryCurrency = input.secondaryCurrency;
  }
  if (input.dualDisplayEnabled !== undefined) {
    set.dualDisplayEnabled = input.dualDisplayEnabled;
  }

  const doc = await UserPreference.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId }, ...(Object.keys(set).length > 0 ? { $set: set } : {}) },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  ).lean<IUserPreference>();
  return toCurrencyPreference(doc);
}
