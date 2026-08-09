/**
 * User-preference service — the consumer's dual-currency display preference.
 *
 * Owns the lazy lifecycle + edits of a shopper's currency preference, keyed by
 * Oxy user id. These are presentation-only (`secondaryCurrency`,
 * `dualDisplayEnabled`) and NEVER affect the amounts Mercaria stores — every
 * price stays in its own native currency.
 *
 * ## Ported to Postgres — `UNIQUE(oxy_user_id)` is what makes the lazy row safe
 *
 * Both entry points are `INSERT … ON CONFLICT (oxy_user_id) DO UPDATE`, the port
 * of Mongoose's `findOneAndUpdate({upsert: true, setDefaultsOnInsert: true})`.
 * The conflict target is named explicitly rather than inferred: this is the index
 * the whole lazy lifecycle rests on, and an inferred target would silently pick a
 * different one if another were ever added.
 *
 * `setDefaultsOnInsert` has no counterpart and needs none — the two currency
 * columns are nullable with no default and `dual_display_enabled` defaults to
 * `true` in the DDL, so an insert that names neither gets exactly the values
 * Mongoose was substituting. NULL genuinely means "not chosen", and it is written
 * NULL and never `''`: an empty string is a real value that satisfies neither the
 * column's CHECK nor any consumer.
 */

import type {
  CurrencyCode,
  CurrencyPreference,
  UpdateCurrencyPreferenceInput,
} from '@mercaria/shared-types';
import type { CartOwner } from '../db/buyers/cartRepository.js';
import {
  findPreferredCurrency,
  upsertUserPreference,
  type UserPreferenceRecord,
} from '../db/buyers/userPreferenceRepository.js';

/**
 * The presentment-currency fallback when a buyer has chosen no preferred
 * currency. This is Mercaria's PRODUCT policy — FAIR is the currency Oxy prefers
 * to transact in, so it is what an undecided buyer is quoted — and it is the one
 * place that policy is expressed. Nothing downstream requires it: a buyer with a
 * preference is charged in theirs, and the order settles per its payment
 * provider either way.
 */
const DEFAULT_PRESENTMENT_CURRENCY: CurrencyCode = 'FAIR';

/** Project a preference row down to the wire DTO (display fields only). */
function toCurrencyPreference(row: UserPreferenceRecord): CurrencyPreference {
  return {
    preferredCurrency: row.preferredCurrency,
    secondaryCurrency: row.secondaryCurrency,
    dualDisplayEnabled: row.dualDisplayEnabled,
  };
}

/**
 * Resolve the buyer's PRESENTMENT currency — the currency their cart/checkout is
 * displayed and charged in. It is their chosen `preferredCurrency`, falling back
 * to FAIR when they have not set one (or have no preference row yet). A pure
 * read (no lazy create), so it never mutates on a checkout/cart hydration.
 */
export async function resolvePresentmentCurrency(oxyUserId: string): Promise<CurrencyCode> {
  return (await findPreferredCurrency(oxyUserId)) ?? DEFAULT_PRESENTMENT_CURRENCY;
}

/**
 * The presentment currency for either kind of cart owner (#104, ADR 0003 D8).
 *
 * The two branches differ because the two owners differ in what they can
 * STORE, not because guests get special treatment:
 *
 *  - An **Oxy** owner has a `user_preferences` row, so their stored choice is
 *    the authority and {@link resolvePresentmentCurrency} answers exactly as it
 *    always has. `requested` is deliberately IGNORED for them: a query
 *    parameter able to override a stored preference would be a second authority
 *    over one fact, and "keep Oxy behaviour unchanged" is an explicit #104
 *    requirement.
 *  - A **guest** owner has no preferences row and the ADR says not to give them
 *    one (D8: "the client sends it per request, falling back to FAIR"). Their
 *    display currency therefore rides the request. It is DISPLAY only — the
 *    catalogue still stores native prices and checkout still reprices — so a
 *    client choosing it decides nothing a buyer could not decide anyway.
 *
 * `requested` reaches here already validated against `ALL_CURRENCY_CODES` by
 * the route schema; an unrecognized code never becomes a currency.
 */
export async function resolvePresentmentCurrencyForOwner(
  owner: CartOwner,
  requested?: CurrencyCode,
): Promise<CurrencyCode> {
  switch (owner.kind) {
    case 'oxy_user':
      return resolvePresentmentCurrency(owner.oxyUserId);
    case 'guest_session':
      return requested ?? DEFAULT_PRESENTMENT_CURRENCY;
  }
}

/**
 * Get the consumer's currency preference, creating the column defaults on first
 * use (`dualDisplayEnabled: true`, both currencies NULL). Idempotent under
 * concurrent first-writes via the upsert.
 */
export async function getOrCreate(oxyUserId: string): Promise<CurrencyPreference> {
  return toCurrencyPreference(await upsertUserPreference(oxyUserId, {}));
}

/**
 * Patch the consumer's currency preference, setting only the fields present in
 * `input`. Either currency may be explicitly `null` to clear it. Lazily creates
 * the preference if absent.
 */
export async function update(
  oxyUserId: string,
  input: UpdateCurrencyPreferenceInput,
): Promise<CurrencyPreference> {
  return toCurrencyPreference(await upsertUserPreference(oxyUserId, input));
}
