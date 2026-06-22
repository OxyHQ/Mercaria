/**
 * Notification read/management service.
 *
 * This is the READ + management side of notifications (listing, unread count,
 * read/dismiss state, and push-token / web-push-subscription registration). The
 * DELIVERY side (creating + fanning a notification out across channels) lives in
 * `lib/notification-service.ts`; the read-state mutations here delegate to that
 * module's `getUnreadCount` / `markAsRead` / `markAllAsRead` / `dismissNotification`
 * helpers so there is one source of truth for those transitions.
 *
 * All operations are scoped to `oxyUserId`. Logic lives here; the controller is
 * thin.
 */

import Expo from 'expo-server-sdk';
import { Notification, type INotification } from '../models/notification.js';
import { PushToken } from '../models/push-token.js';
import { WebPushSubscription } from '../models/web-push-subscription.js';
import {
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  dismissNotification,
} from '../lib/notification-service.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';

/** A single notification as returned on the wire. */
export interface NotificationDTO {
  id: string;
  type: INotification['type'];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: INotification['status'];
  priority: INotification['priority'];
  conversationId?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Serialize an `INotification` document to the wire `NotificationDTO`. */
function toDTO(doc: INotification): NotificationDTO {
  const dto: NotificationDTO = {
    id: String(doc._id),
    type: doc.type,
    title: doc.title,
    body: doc.body,
    status: doc.status,
    priority: doc.priority,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  if (doc.data !== undefined) dto.data = doc.data;
  if (doc.conversationId !== undefined) dto.conversationId = doc.conversationId;
  if (doc.readAt !== undefined) dto.readAt = doc.readAt.toISOString();
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
  const filter: Record<string, unknown> = { oxyUserId };
  if (status) filter.status = status;
  if (type) filter.type = type;

  const [docs, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<INotification[]>(),
    Notification.countDocuments(filter),
    getUnreadCount(oxyUserId),
  ]);

  return { data: docs.map(toDTO), total, unreadCount };
}

/** The user's live unread-notification count. */
export async function getUnread(oxyUserId: string): Promise<number> {
  return getUnreadCount(oxyUserId);
}

/** Mark a single notification read, or throw NOT_FOUND if it is not the user's. */
export async function markRead(oxyUserId: string, notificationId: string): Promise<void> {
  const ok = await markAsRead(notificationId, oxyUserId);
  if (!ok) {
    throw notFound('Notification not found');
  }
}

/** Mark all of the user's unread notifications read; returns the affected count. */
export async function markAllRead(oxyUserId: string): Promise<number> {
  return markAllAsRead(oxyUserId);
}

/** Dismiss a single notification, or throw NOT_FOUND if it is not the user's. */
export async function dismiss(oxyUserId: string, notificationId: string): Promise<void> {
  const ok = await dismissNotification(notificationId, oxyUserId);
  if (!ok) {
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
  input: { token: string; deviceId?: string; platform?: 'ios' | 'android' | 'web' },
): Promise<{ id: string }> {
  if (!Expo.isExpoPushToken(input.token)) {
    throw validationError('Invalid Expo push token format');
  }

  const pushToken = await PushToken.findOneAndUpdate(
    { oxyUserId, token: input.token },
    {
      $set: {
        active: true,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
      },
      $setOnInsert: { oxyUserId, token: input.token },
    },
    { upsert: true, new: true },
  );

  return { id: String(pushToken._id) };
}

/** Deactivate an Expo push token (logout / uninstall), or throw NOT_FOUND. */
export async function removePushToken(oxyUserId: string, token: string): Promise<void> {
  const result = await PushToken.updateOne({ oxyUserId, token }, { $set: { active: false } });
  if (result.matchedCount === 0) {
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
  const subscription = await WebPushSubscription.findOneAndUpdate(
    { oxyUserId, endpoint: input.endpoint },
    {
      $set: {
        active: true,
        keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      },
      $setOnInsert: { oxyUserId, endpoint: input.endpoint },
    },
    { upsert: true, new: true },
  );

  return { id: String(subscription._id) };
}

/** Deactivate a browser web-push subscription, or throw NOT_FOUND. */
export async function removeWebPushSubscription(
  oxyUserId: string,
  endpoint: string,
): Promise<void> {
  const result = await WebPushSubscription.updateOne(
    { oxyUserId, endpoint },
    { $set: { active: false } },
  );
  if (result.matchedCount === 0) {
    throw notFound('Subscription not found');
  }
}
