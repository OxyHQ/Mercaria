/**
 * `user_preferences` — a buyer's currency DISPLAY preference.
 *
 * Presentation only: nothing here changes an amount Mercaria stores. Every price
 * stays in its own native currency and every order carries its own
 * `DualMoney`; this table decides what the client RENDERS.
 *
 * ## The row is lazily created, so every write is an upsert
 *
 * A buyer has no row until they first open the currency picker — or until
 * something reads their preference and creates the defaults on the way past.
 * `ON CONFLICT (oxy_user_id) DO UPDATE` is the port of Mongoose's
 * `findOneAndUpdate({upsert: true, setDefaultsOnInsert: true})` and makes both
 * paths idempotent under a concurrent first write. `DO UPDATE` and not
 * `DO NOTHING`: a conflicting `DO NOTHING` returns no row at all, which would
 * make the get-or-create path return `undefined` for exactly the case it exists
 * to serve.
 *
 * The conflict target is named explicitly (`user_preferences_oxy_user_id_key`'s
 * column). An inferred target would silently pick a different index if one were
 * ever added, and this is the index whose uniqueness the whole lazy lifecycle
 * rests on.
 *
 * ## NULL is a value here, and `''` is a different one
 *
 * Both currency columns are nullable with no default, and NULL means "the buyer
 * has not chosen one" — `resolvePresentmentCurrency` reads that as FAIR and the
 * client falls back to a locale default. An empty string is a real value that
 * would satisfy neither the CHECK constraint nor any consumer, so a clear is
 * written NULL and never `''`.
 */

import { eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { userPreferences } from '../schema/buyers.js';

/** One row of `user_preferences`. */
export type UserPreferenceRecord = InferSelectModel<typeof userPreferences>;

/**
 * The fields a caller may set. `undefined` means "leave alone"; an explicit
 * `null` clears the column.
 */
export interface UserPreferencePatch {
  preferredCurrency?: CurrencyCode | null;
  secondaryCurrency?: CurrencyCode | null;
  dualDisplayEnabled?: boolean;
}

/**
 * The buyer's chosen primary display currency, or `null` when they have not
 * chosen one (or have no row yet).
 *
 * A pure read with NO lazy create, deliberately: this runs on every cart and
 * checkout hydration, and a read that writes turns a page view into a row.
 */
export async function findPreferredCurrency(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CurrencyCode | null> {
  const [row] = await db
    .select({ preferredCurrency: userPreferences.preferredCurrency })
    .from(userPreferences)
    .where(eq(userPreferences.oxyUserId, oxyUserId))
    .limit(1);
  return row?.preferredCurrency ?? null;
}

/**
 * The buyer's preference row, created with the column defaults on first use and
 * patched with whatever `patch` names.
 *
 * An empty `patch` is the get-or-create: the conflicting branch then touches only
 * `updated_at`, which keeps the statement returning a row and is the honest
 * record that something asked for the preference. Mongoose's `findOneAndUpdate`
 * bumped `updatedAt` on that same path, so this is not a new write.
 */
export async function upsertUserPreference(
  oxyUserId: string,
  patch: UserPreferencePatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<UserPreferenceRecord> {
  const columns = {
    ...(patch.preferredCurrency !== undefined
      ? { preferredCurrency: patch.preferredCurrency }
      : {}),
    ...(patch.secondaryCurrency !== undefined
      ? { secondaryCurrency: patch.secondaryCurrency }
      : {}),
    ...(patch.dualDisplayEnabled !== undefined
      ? { dualDisplayEnabled: patch.dualDisplayEnabled }
      : {}),
  };

  const [row] = await db
    .insert(userPreferences)
    .values({ oxyUserId, ...columns })
    .onConflictDoUpdate({
      target: userPreferences.oxyUserId,
      set: { ...columns, updatedAt: new Date() },
    })
    .returning();
  return row;
}
