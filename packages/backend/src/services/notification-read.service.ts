/**
 * Notification read/management service.
 *
 * This is the READ + management side of notifications (listing, unread count,
 * read/dismiss state, and push-token / web-push-subscription registration). The
 * DELIVERY side (creating + fanning a notification out across channels) lives in
 * `lib/notification-service.ts`.
 *
 * All operations are scoped to `oxyUserId`. Logic lives here; the controller is
 * thin.
 *
 * ## Ported to Postgres
 *
 * The read-state mutations used to hop through `lib/notification-service.ts` for
 * "one source of truth". That source of truth is now `db/notifications/*`, so the
 * hop is gone and this module calls the repositories directly. Three behaviour
 * notes the port carries:
 *
 *  - **Dismissing writes `dismissed_at` as well as `status`**, because
 *    `notifications_dismissed_at_check` refuses either one alone — and that
 *    column, not `created_at`, is now what the 90-day retention sweep measures
 *    from. See `db/notifications/notificationRepository.ts`.
 *  - **An unrecognised `status`/`type` filter answers with an EMPTY page**, which
 *    is what Mongo did with a filter value no document carried. It is spelled out
 *    here because the tempting narrowing — drop the filter you cannot type — turns
 *    that empty page into the user's ENTIRE feed. The route's zod schema already
 *    rejects a bad `status`, so this is the guard for every non-HTTP caller.
 *  - **A NULL column is omitted from the DTO**, exactly as an absent Mongo field
 *    was. The wire shape does not change; `null` simply took `undefined`'s place
 *    as the "not set" representation one layer down.
 *
 * `trim`/`lowercase` re-application, which this port owes every ported service:
 * none of the three Mongoose models carried either setter, so there is nothing to
 * re-apply. The route's zod schemas already `.trim()` every string this service
 * stores (`token`, `deviceId`, `endpoint`, both web-push keys).
 */

import Expo from 'expo-server-sdk';
import {
  countUnreadNotifications,
  findNotificationsPage,
  isNotificationStatus,
  isNotificationType,
  markAllNotificationsRead,
  markNotificationDismissed,
  markNotificationRead,
  type NotificationFilter,
  type NotificationPriority,
  type NotificationRecord,
  type NotificationStatus,
} from '../db/notifications/notificationRepository.js';
import {
  deactivatePushToken,
  upsertPushToken,
  type PushTokenPlatform,
} from '../db/notifications/pushTokenRepository.js';
import {
  deactivateWebPushSubscription,
  upsertWebPushSubscription,
} from '../db/notifications/webPushSubscriptionRepository.js';
import type { NotificationType } from '../db/schema/notifications.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';

/** A single notification as returned on the wire. */
export interface NotificationDTO {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: NotificationStatus;
  priority: NotificationPriority;
  conversationId?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Serialize a `notifications` row to the wire `NotificationDTO`. */
function toDTO(row: NotificationRecord): NotificationDTO {
  const dto: NotificationDTO = {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.data !== null) dto.data = row.data;
  if (row.conversationId !== null) dto.conversationId = row.conversationId;
  if (row.readAt !== null) dto.readAt = row.readAt.toISOString();
  return dto;
}

/**
 * List the user's notifications (newest first, offset-paginated) together with
 * the matched `total` and the live `unreadCount`. Optional `status`/`type`
 * filters narrow the list (and the total).
 */
export async function listNotifications(
  oxyUserId: string,
  opts: { page: number; limit: number; status?: string; type?: string },
): Promise<{ data: NotificationDTO[]; total: number; unreadCount: number }> {
  const { page, limit, status, type } = opts;

  // A filter value no column can hold matches no row. Returning the count alone
  // — rather than narrowing the filter away — is what keeps `?type=nonsense` from
  // answering with everything the user has ever been sent.
  const filter: NotificationFilter = {};
  if (status !== undefined) {
    if (!isNotificationStatus(status)) {
      return { data: [], total: 0, unreadCount: await countUnreadNotifications(oxyUserId) };
    }
    filter.status = status;
  }
  if (type !== undefined) {
    if (!isNotificationType(type)) {
      return { data: [], total: 0, unreadCount: await countUnreadNotifications(oxyUserId) };
    }
    filter.type = type;
  }

  const [{ rows, total }, unreadCount] = await Promise.all([
    findNotificationsPage(oxyUserId, filter, page, limit),
    countUnreadNotifications(oxyUserId),
  ]);

  return { data: rows.map(toDTO), total, unreadCount };
}

/** The user's live unread-notification count. */
export async function getUnread(oxyUserId: string): Promise<number> {
  return countUnreadNotifications(oxyUserId);
}

/** Mark a single notification read, or throw NOT_FOUND if it is not the user's. */
export async function markRead(oxyUserId: string, notificationId: string): Promise<void> {
  if (!(await markNotificationRead(oxyUserId, notificationId))) {
    throw notFound('Notification not found');
  }
}

/** Mark all of the user's unread notifications read; returns the affected count. */
export async function markAllRead(oxyUserId: string): Promise<number> {
  return (await markAllNotificationsRead(oxyUserId)).length;
}

/** Dismiss a single notification, or throw NOT_FOUND if it is not the user's. */
export async function dismiss(oxyUserId: string, notificationId: string): Promise<void> {
  if (!(await markNotificationDismissed(oxyUserId, notificationId))) {
    throw notFound('Notification not found');
  }
}

/**
 * Register (or reactivate) an Expo push token for the user. The token format is
 * validated as a domain rule; an upsert keyed on `(oxyUserId, token)` reactivates
 * an already-known token rather than duplicating it.
 */
export async function registerPushToken(
  oxyUserId: string,
  input: { token: string; deviceId?: string; platform?: PushTokenPlatform },
): Promise<{ id: string }> {
  if (!Expo.isExpoPushToken(input.token)) {
    throw validationError('Invalid Expo push token format');
  }

  return upsertPushToken(oxyUserId, input);
}

/** Deactivate an Expo push token (logout / uninstall), or throw NOT_FOUND. */
export async function removePushToken(oxyUserId: string, token: string): Promise<void> {
  if (!(await deactivatePushToken(oxyUserId, token))) {
    throw notFound('Push token not found');
  }
}

/**
 * Register (or reactivate) a browser web-push subscription for the user. Upsert
 * keyed on `(oxyUserId, endpoint)` refreshes the stored keys for a known endpoint.
 */
export async function registerWebPushSubscription(
  oxyUserId: string,
  input: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<{ id: string }> {
  return upsertWebPushSubscription(oxyUserId, input);
}

/** Deactivate a browser web-push subscription, or throw NOT_FOUND. */
export async function removeWebPushSubscription(
  oxyUserId: string,
  endpoint: string,
): Promise<void> {
  if (!(await deactivateWebPushSubscription(oxyUserId, endpoint))) {
    throw notFound('Subscription not found');
  }
}
