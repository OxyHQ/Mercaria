/**
 * `web_push_subscriptions` — a browser Web Push endpoint and its encryption keys.
 *
 * ## `keys_p256dh` and `keys_auth` are PROTECTED, and the pair IS the capability
 *
 * Both are registered in `db/protectedColumns.ts`: handing them to a client hands
 * it the ability to push to that browser, and half of the pair is no safer than
 * both. {@link WEB_PUSH_DELIVERY_COLUMNS} is the single explicit opt-in — one
 * function reads it, the dispatch path that has to encrypt a payload for the
 * endpoint. As in `pushTokenRepository`, there is no `publicColumns(...)`
 * constant beside it because nothing reads a subscription ROW: registration
 * answers with an id, deactivation with whether a row matched, and the channel
 * probe with a boolean.
 *
 * ## The keys ARE refreshed on re-registration, and the endpoint identifies the row
 *
 * `web_push_subscriptions_oxy_user_id_endpoint_key` is
 * `UNIQUE(oxy_user_id, endpoint)`. A browser re-subscribing to the same endpoint
 * can legitimately present NEW key material (a fresh `PushSubscription` for an
 * unchanged endpoint), so {@link upsertWebPushSubscription} overwrites both keys
 * and reactivates the row — unconditionally, unlike the push-token upsert, since
 * the client always sends both and a subscription with stale keys can no longer
 * be decrypted by the browser it points at.
 */

import { and, eq } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { webPushSubscriptions } from '../schema/notifications.js';

/**
 * The columns the DISPATCH path needs — the explicit opt-in to both protected
 * key columns, named once so a grep finds exactly one site.
 */
const WEB_PUSH_DELIVERY_COLUMNS = {
  id: webPushSubscriptions.id,
  endpoint: webPushSubscriptions.endpoint,
  keysP256dh: webPushSubscriptions.keysP256dh,
  keysAuth: webPushSubscriptions.keysAuth,
} as const;

/** One row of what the dispatch path selects: an endpoint and its key pair. */
export type WebPushDeliveryTarget = SelectedRow<typeof WEB_PUSH_DELIVERY_COLUMNS>;

/** What a browser sends when subscribing. */
export interface WebPushRegistration {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Register or reactivate a browser subscription, refreshing its key material.
 *
 * @returns The id of the row, whether it was created or reactivated.
 */
export async function upsertWebPushSubscription(
  oxyUserId: string,
  registration: WebPushRegistration,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string }> {
  const [row] = await db
    .insert(webPushSubscriptions)
    .values({
      oxyUserId,
      endpoint: registration.endpoint,
      keysP256dh: registration.keys.p256dh,
      keysAuth: registration.keys.auth,
      active: true,
    })
    .onConflictDoUpdate({
      target: [webPushSubscriptions.oxyUserId, webPushSubscriptions.endpoint],
      set: {
        active: true,
        keysP256dh: registration.keys.p256dh,
        keysAuth: registration.keys.auth,
        updatedAt: new Date(),
      },
    })
    .returning({ id: webPushSubscriptions.id });
  return row;
}

/**
 * Deactivate one of the user's subscriptions.
 *
 * @returns `false` when the user has no such endpoint — the caller turns that into
 *   a NOT_FOUND. An already-inactive subscription still returns `true`, matching
 *   the `matchedCount` the Mongo path checked.
 */
export async function deactivateWebPushSubscription(
  oxyUserId: string,
  endpoint: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(webPushSubscriptions)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({ id: webPushSubscriptions.id });
  return rows.length > 0;
}

/**
 * Deactivate a subscription by id — the dispatch path's 410/404 branch, which
 * already holds the row the push endpoint just declared dead.
 */
export async function deactivateWebPushSubscriptionById(
  subscriptionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(webPushSubscriptions)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(webPushSubscriptions.id, subscriptionId));
}

/** Whether the user has any browser subscribed — the push-channel probe. */
export async function hasActiveWebPushSubscription(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: webPushSubscriptions.id })
    .from(webPushSubscriptions)
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.active, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Every active subscription of the user's, WITH its key material. The one path
 * that reads the protected columns — see the module docblock.
 */
export async function findWebPushSubscriptionsForDelivery(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WebPushDeliveryTarget[]> {
  return db
    .select(WEB_PUSH_DELIVERY_COLUMNS)
    .from(webPushSubscriptions)
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.active, true),
      ),
    );
}
