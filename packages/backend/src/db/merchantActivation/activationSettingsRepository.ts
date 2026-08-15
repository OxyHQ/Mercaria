/**
 * `merchant_activation_settings` — the merchant's own switches, its public
 * support contact, and an operator's safety hold (#85).
 *
 * ## Two writers with two SIGNATURES, and that is the security property
 *
 * #85 permissions rule 11 is "a merchant cannot bypass a platform safety pause
 * from the dashboard". {@link updateMerchantCheckoutIntents} has no hold
 * parameter, so the merchant controller cannot clear a hold however it is
 * called or whatever body it is handed — the refusal arrives before any check,
 * the way `addressBookOwnerForActor` (#105) refuses a guest a saved address.
 * {@link applyPlatformHold} and {@link releasePlatformHold} take a mandatory
 * operator id and reach only the three hold columns.
 *
 * ## An absent row is a fact, not a gap
 *
 * {@link readMerchantActivationSettings} answers for a store that has never been
 * written to, with the defaults the column definitions carry. It does NOT
 * create one: a checkout reads this, and a read that writes is how "how many
 * stores have started activation" stops being answerable.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { MerchantCheckoutIntent } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { getDb } from '../postgres.js';
import { merchantActivationSettings } from '../schema/merchantActivation.js';

export type MerchantActivationSettingsRow = typeof merchantActivationSettings.$inferSelect;

/**
 * The settings as the derivation reads them.
 *
 * `platformHeld` is a BOOLEAN here and the reason is disclosure: the derivation
 * feeds a merchant-facing projection, and a hold's stated reason is an
 * operator's note about a moderation or risk finding. The row keeps all three
 * columns; only the operator trace reads them.
 */
export interface MerchantActivationSettingsFacts {
  readonly exists: boolean;
  readonly nativeCheckoutIntent: MerchantCheckoutIntent;
  readonly guestCheckoutIntent: MerchantCheckoutIntent;
  readonly supportEmail: string | null;
  readonly supportUrl: string | null;
  readonly platformHeld: boolean;
}

/** What a store with no row has decided: nothing. */
const UNWRITTEN: MerchantActivationSettingsFacts = {
  exists: false,
  nativeCheckoutIntent: 'enabled',
  guestCheckoutIntent: 'enabled',
  supportEmail: null,
  supportUrl: null,
  platformHeld: false,
};

/** Project a row into the derivation's view. */
function toFacts(row: MerchantActivationSettingsRow): MerchantActivationSettingsFacts {
  return {
    exists: true,
    nativeCheckoutIntent: row.nativeCheckoutIntent,
    guestCheckoutIntent: row.guestCheckoutIntent,
    supportEmail: row.supportEmail,
    supportUrl: row.supportUrl,
    platformHeld: row.platformHeldAt !== null,
  };
}

/** One store's settings, or the unwritten defaults. Creates nothing. */
export async function readMerchantActivationSettings(
  storeId: string,
): Promise<MerchantActivationSettingsFacts> {
  const row = await findMerchantActivationSettings(getDb(), storeId);
  return row ? toFacts(row) : UNWRITTEN;
}

/** The raw row, for the operator trace and the writers. */
export async function findMerchantActivationSettings(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<MerchantActivationSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantActivationSettings)
    .where(eq(merchantActivationSettings.storeId, storeId))
    .limit(1);
  return row;
}

/**
 * Create the row if it is missing, and return it locked `FOR UPDATE`.
 *
 * The lock is what serializes capability OBSERVATION per store — two sweeps
 * would otherwise both read the same previous state and both write a transition
 * — and it is taken on a row that must exist for any observation to be recorded,
 * so this domain needs no lease table of its own.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read rather than a read-then-insert: two
 * concurrent first writes are ordinary (a merchant with two dashboard tabs), and
 * the unique index is what makes them converge instead of one of them raising.
 */
export async function lockMerchantActivationSettings(
  tx: DatabaseOrTransaction,
  storeId: string,
): Promise<MerchantActivationSettingsRow> {
  await tx
    .insert(merchantActivationSettings)
    .values({ storeId })
    .onConflictDoNothing({ target: merchantActivationSettings.storeId });
  const [row] = await tx
    .select()
    .from(merchantActivationSettings)
    .where(eq(merchantActivationSettings.storeId, storeId))
    .for('update')
    .limit(1);
  if (!row) {
    throw new Error(`Activation settings for store ${storeId} could not be created or read back.`);
  }
  return row;
}

/**
 * What a MERCHANT may change.
 *
 * There is no hold parameter and no support-contact parameter that could carry
 * one: pausing and un-pausing are what a merchant decides, and the operator's
 * hold is a different act with a different signature. A merchant whose store is
 * held may still pause and resume its own switch — the derivation refuses on the
 * hold regardless, so allowing it costs nothing and refusing it would tell the
 * merchant their own control is broken.
 */
export async function updateMerchantCheckoutIntents(
  tx: DatabaseOrTransaction,
  input: {
    storeId: string;
    nativeCheckoutIntent?: MerchantCheckoutIntent;
    guestCheckoutIntent?: MerchantCheckoutIntent;
    supportEmail?: string | null;
    supportUrl?: string | null;
  },
): Promise<MerchantActivationSettingsRow> {
  const patch: Partial<typeof merchantActivationSettings.$inferInsert> = {};
  if (input.nativeCheckoutIntent !== undefined) patch.nativeCheckoutIntent = input.nativeCheckoutIntent;
  if (input.guestCheckoutIntent !== undefined) patch.guestCheckoutIntent = input.guestCheckoutIntent;
  if (input.supportEmail !== undefined) patch.supportEmail = input.supportEmail;
  if (input.supportUrl !== undefined) patch.supportUrl = input.supportUrl;

  if (Object.keys(patch).length === 0) return lockMerchantActivationSettings(tx, input.storeId);

  await lockMerchantActivationSettings(tx, input.storeId);
  const [row] = await tx
    .update(merchantActivationSettings)
    .set(patch)
    .where(eq(merchantActivationSettings.storeId, input.storeId))
    .returning();
  if (!row) {
    throw new Error(`Activation settings for store ${input.storeId} vanished mid-update.`);
  }
  return row;
}

/**
 * An operator holds a store's checkout.
 *
 * The predicate is `platform_held_at is null`, so a second hold over a live one
 * is a NO-OP rather than a silent overwrite of the first operator's reason — the
 * incumbent's record is what an incident review reads, and replacing it loses
 * who acted first. The empty `RETURNING` set IS the "already held" answer.
 */
export async function applyPlatformHold(
  tx: DatabaseOrTransaction,
  input: { storeId: string; reason: string; operatorOxyUserId: string },
): Promise<MerchantActivationSettingsRow | undefined> {
  await lockMerchantActivationSettings(tx, input.storeId);
  const [row] = await tx
    .update(merchantActivationSettings)
    .set({
      platformHoldReason: input.reason,
      platformHeldByOxyUserId: input.operatorOxyUserId,
      platformHeldAt: sql`now()`,
    })
    .where(
      and(
        eq(merchantActivationSettings.storeId, input.storeId),
        isNull(merchantActivationSettings.platformHeldAt),
      ),
    )
    .returning();
  return row;
}

/**
 * An operator releases a hold.
 *
 * All three columns are cleared together, which the row's `num_nonnulls` CHECK
 * requires — a release that left the reason behind would leave a store reading
 * as held-with-no-instant, a shape the CHECK refuses outright rather than
 * letting a service produce it. The release is AUDITED by the capability event
 * the caller records, not by keeping a dead reason on the row.
 */
export async function releasePlatformHold(
  tx: DatabaseOrTransaction,
  storeId: string,
): Promise<MerchantActivationSettingsRow | undefined> {
  await lockMerchantActivationSettings(tx, storeId);
  const [row] = await tx
    .update(merchantActivationSettings)
    .set({ platformHoldReason: null, platformHeldByOxyUserId: null, platformHeldAt: null })
    .where(
      and(
        eq(merchantActivationSettings.storeId, storeId),
        isNotNull(merchantActivationSettings.platformHeldAt),
      ),
    )
    .returning();
  return row;
}

/**
 * A page of store ids for the observation sweep, ordered by id.
 *
 * It pages over the SETTINGS rows rather than over `stores`: a store nobody has
 * ever written a setting for has also never had a capability observed, so there
 * is no previous state to transition FROM and nothing to audit. The first
 * observation is written when the merchant first touches its own switches or an
 * operator first looks — which is the first moment the trail means anything.
 */
export async function listActivationSettingsStoreIdsAfter(
  cursor: string | null,
  limit: number,
): Promise<readonly string[]> {
  const rows = await getDb()
    .select({ storeId: merchantActivationSettings.storeId })
    .from(merchantActivationSettings)
    .where(cursor === null ? undefined : sql`${merchantActivationSettings.storeId} > ${cursor}`)
    .orderBy(merchantActivationSettings.storeId)
    .limit(limit);
  return rows.map((row) => row.storeId);
}
