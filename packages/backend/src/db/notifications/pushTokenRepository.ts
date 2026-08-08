/**
 * `push_tokens` — an Expo push token for one device of one person.
 *
 * ## `token` is PROTECTED, and this module is the only path that may read it
 *
 * Possession of an Expo push token is permission to push to that device, which is
 * why `db/protectedColumns.ts` registers it. The registry's rule is that an
 * ordinary read goes through `publicColumns` and a path that genuinely needs the
 * column NAMES it — so {@link PUSH_TOKEN_DELIVERY_COLUMNS} is the greppable
 * opt-in, and it is used by exactly one function, the dispatch path that has to
 * hand the token to Expo.
 *
 * There is deliberately no `publicColumns(...)` constant beside it: no caller
 * reads a push-token ROW. Registration answers with an id, deactivation with
 * whether anything matched, and `resolveChannels` with a boolean — none of them
 * selects a row at all, so a public projection would be an unused export that
 * reads as an available shortcut. Add one when a surface actually lists a user's
 * devices, and give it the `publicColumns` treatment then.
 *
 * ## Re-registering a token is an UPSERT, not a duplicate
 *
 * `push_tokens_oxy_user_id_token_key` is `UNIQUE(oxy_user_id, token)`.
 * {@link upsertPushToken} targets that index explicitly: the same device
 * reinstalling, or an app resuming after a logout, REACTIVATES the stored row
 * (`active = true`) and refreshes whichever of `device_id` / `platform` the client
 * actually sent. A field the client omitted is left alone rather than nulled —
 * omission at the client means "not reported", not "erase what we know", and that
 * is the same conditional-`$set` semantics the Mongo upsert had.
 *
 * ## An absent `device_id` is NULL, never `''`
 *
 * The Mongoose path spread the field in only when truthy, so an unsent value was
 * ABSENT. The Postgres equivalent of absent is NULL; writing `''` would store a
 * real value that compares equal to another device that also sent nothing.
 * `push_tokens` has no unique index on `device_id` today, so this costs no
 * collisions yet — it would the moment one is added, which is exactly when nobody
 * would think to look here.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { pushTokens, type PUSH_TOKEN_PLATFORMS } from '../schema/notifications.js';

/** `PushToken.platform`, narrowed from the schema's tuple. */
export type PushTokenPlatform = (typeof PUSH_TOKEN_PLATFORMS)[number];

/**
 * The columns the DISPATCH path needs — the explicit opt-in to the protected
 * `token`. Named here once so every reader of this file sees the disclosure, and
 * so a grep for `pushTokens.token` finds exactly one site.
 */
const PUSH_TOKEN_DELIVERY_COLUMNS = {
  id: pushTokens.id,
  token: pushTokens.token,
} as const;

/** One row of what the dispatch path selects: an id and the token itself. */
export type PushTokenDeliveryTarget = SelectedRow<typeof PUSH_TOKEN_DELIVERY_COLUMNS>;

/** What a client sends when registering a device. */
export interface PushTokenRegistration {
  token: string;
  deviceId?: string;
  platform?: PushTokenPlatform;
}

/**
 * Register or reactivate a device's push token.
 *
 * @returns The id of the row, whether it was created or reactivated.
 */
export async function upsertPushToken(
  oxyUserId: string,
  registration: PushTokenRegistration,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string }> {
  const [row] = await db
    .insert(pushTokens)
    .values({
      oxyUserId,
      token: registration.token,
      deviceId: registration.deviceId,
      platform: registration.platform,
      active: true,
    })
    .onConflictDoUpdate({
      target: [pushTokens.oxyUserId, pushTokens.token],
      set: {
        active: true,
        // Only what the client actually reported overwrites what is stored.
        ...(registration.deviceId !== undefined ? { deviceId: registration.deviceId } : {}),
        ...(registration.platform !== undefined ? { platform: registration.platform } : {}),
        updatedAt: new Date(),
      },
    })
    .returning({ id: pushTokens.id });
  return row;
}

/**
 * Deactivate one of the user's tokens (logout, uninstall).
 *
 * @returns `false` when the user has no such token — the caller turns that into a
 *   NOT_FOUND. A token that was ALREADY inactive still returns `true`: the row
 *   matched, which is the `matchedCount` the Mongo path checked, and re-reporting
 *   a logged-out device as missing would be a new error the client never saw.
 */
export async function deactivatePushToken(
  oxyUserId: string,
  token: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(pushTokens)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.token, token)))
    .returning({ id: pushTokens.id });
  return rows.length > 0;
}

/**
 * Deactivate a token by id — the malformed-token branch of the dispatch path,
 * which already holds the row it is rejecting.
 */
export async function deactivatePushTokenById(
  pushTokenId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(pushTokens)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(pushTokens.id, pushTokenId));
}

/**
 * Deactivate every row carrying `token`, across users.
 *
 * Expo's `DeviceNotRegistered` ticket names the TOKEN and nothing else, and the
 * device really is gone — so this is deliberately not user-scoped, exactly as the
 * Mongo path was. `push_tokens_token_idx` exists for this lookup.
 */
export async function deactivatePushTokensByToken(
  token: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(pushTokens)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(pushTokens.token, token));
}

/** Whether the user has any device registered — the push-channel probe. */
export async function hasActivePushToken(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Every active token of the user's, WITH the token value. The one path that reads
 * the protected column — see the module docblock.
 */
export async function findPushTokensForDelivery(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PushTokenDeliveryTarget[]> {
  return db
    .select(PUSH_TOKEN_DELIVERY_COLUMNS)
    .from(pushTokens)
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true)));
}

/**
 * Stamp `last_used_at` on the tokens a send actually reached.
 *
 * `inArray`, not `= any(${ids})`: an array interpolated into `sql` binds as a
 * TUPLE and Postgres answers `op ANY/ALL (array) requires array on right side`.
 */
export async function touchPushTokensLastUsed(
  pushTokenIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (pushTokenIds.length === 0) return;
  const now = new Date();
  await db
    .update(pushTokens)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(inArray(pushTokens.id, [...pushTokenIds]));
}
