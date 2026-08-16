/**
 * Notification Service — the DELIVERY side.
 *
 * Persists one notification and fans it out:
 * - `in_app`: a Socket.IO event on the user's room
 * - `push`: Expo push (mobile) and Web Push (browser), in parallel
 * - `telegram`/`discord`/`whatsapp`/`slack`: reserved for the channel outbound
 *   system; nothing dispatches them here yet, so an explicit request for one is
 *   recorded as `failed` rather than silently reported delivered.
 *
 * The READ + management side (feed, unread count, read/dismiss, registrations)
 * is `services/notification-read.service.ts`, and it now talks to
 * `db/notifications/*` directly. The four read-state helpers this module used to
 * re-export for it are gone: they were a hop through a delivery module to reach a
 * repository, and the repository is the source of truth this port gives them.
 *
 * ## Ported to Postgres
 *
 * Three things changed beyond the query language:
 *
 *  - **`triggerId` is gone.** It was declared `ref: 'Trigger'` against a model
 *    that does not exist in this repo, no caller ever passed one, and no read
 *    path returned it. The parameter, the forward and the write are all removed.
 *  - **Delivery status is composed locally and written ONCE.** The Mongo path
 *    mutated `notification.deliveryStatus` in place and called `save()`, which
 *    rewrote the whole document — including any read-state change that landed
 *    while the channels were in flight. One `UPDATE … SET delivery_status` cannot.
 *  - **The two channel PROBES no longer swallow their errors.** `resolveChannels`
 *    used `.catch(() => null)`, which loses the reason a probe failed. A failing
 *    probe still costs only the push channel, but it is now logged.
 */

import Expo, { type ExpoPushMessage, type ExpoPushReceiptId } from 'expo-server-sdk';
import { WebPushError } from 'web-push';
import {
  insertNotification,
  updateNotificationDeliveryStatus,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationRecord,
} from '../db/notifications/notificationRepository.js';
import type { NotificationType } from '../db/schema/notifications.js';
import {
  deactivatePushTokenById,
  deactivatePushTokensByToken,
  findPushTokensForDelivery,
  hasActivePushToken,
  touchPushTokensLastUsed,
} from '../db/notifications/pushTokenRepository.js';
import {
  deactivateWebPushSubscriptionById,
  findWebPushSubscriptionsForDelivery,
  hasActiveWebPushSubscription,
} from '../db/notifications/webPushSubscriptionRepository.js';
import { webPush, VAPID_PUBLIC_KEY } from './web-push.js';
import { getIO } from '../socket.js';
import { log } from './logger.js';

// ── Expo push singleton ──────────────────────────────────────────────
const expo = new Expo();

/**
 * Push-endpoint HTTP statuses that mean a web-push subscription is permanently
 * dead (expired or unknown) and should be deactivated rather than retried.
 */
const HTTP_GONE = 410;
const HTTP_NOT_FOUND = 404;

/**
 * Cap on the persisted/pushed body.
 *
 * Under Mongo this doubled as a document-size guard; `text` has no such limit, so
 * it now exists only for the transports — an Expo message and a Web Push payload
 * are both size-limited and a body past this is not readable on a lock screen
 * anyway.
 */
const MAX_BODY_LENGTH = 4000;

/** Delay before asking Expo for receipts — the interval Expo itself recommends. */
const RECEIPT_CHECK_DELAY_MS = 15_000;

// ── Types ──────────────────────────────────────────────────────────

export interface SendNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
  data?: Record<string, unknown>;
  conversationId?: string;
  expiresAt?: Date;
}

// ── Resolve delivery channels ──────────────────────────────────────

/**
 * Run a channel-registration probe, answering `false` rather than aborting the
 * send when the database refuses it.
 *
 * The Mongo path wrote `.catch(() => null)` here, which is the same tolerance with
 * the reason thrown away. A probe that fails costs the push CHANNEL for this one
 * notification; a probe that fails SILENTLY costs every push notification until
 * somebody notices push stopped working.
 */
async function probeChannel(
  probe: () => Promise<boolean>,
  channel: string,
  userId: string,
): Promise<boolean> {
  try {
    return await probe();
  } catch (error: unknown) {
    log.general.warn({ err: error, userId, channel }, 'Notification channel probe failed');
    return false;
  }
}

/**
 * Determine which channels to deliver a notification to.
 * If explicit channels are provided, use those. Otherwise, default to in_app
 * plus `push` when the user has any device or browser registered.
 */
async function resolveChannels(
  userId: string,
  explicit?: NotificationChannel[],
): Promise<NotificationChannel[]> {
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  // Default: always in_app
  const channels: NotificationChannel[] = ['in_app'];

  const [hasPushTokens, hasWebPushSubs] = await Promise.all([
    probeChannel(() => hasActivePushToken(userId), 'expo_push', userId),
    // Only worth asking when VAPID is configured — without it `deliverWebPush`
    // returns immediately and a registered browser is unreachable anyway.
    VAPID_PUBLIC_KEY
      ? probeChannel(() => hasActiveWebPushSubscription(userId), 'web_push', userId)
      : Promise.resolve(false),
  ]);

  if (hasPushTokens || hasWebPushSubs) {
    channels.push('push');
  }

  return channels;
}

// ── Channel delivery implementations ───────────────────────────────

/**
 * Emit the notification to the recipient's room and report whether a socket
 * existed to receive it.
 *
 * `sent` has to mean "a connected client was there", not "a Server object was
 * there to emit at". Reporting the second is what made #364 invisible for as
 * long as it lasted: the Redis adapter never attached, so an emit on one ECS
 * task reached nobody on the other, and `deliveryStatus.in_app` recorded `sent`
 * for every one of them. The telemetry could not distinguish a delivery from a
 * drop, which is the same answer it would give if the transport were absent
 * entirely — so it measured nothing.
 *
 * `fetchSockets()` is the honest instrument precisely because it is
 * ADAPTER-AWARE: with the Redis adapter attached it counts this user's sockets
 * on every task, and without it only this task's. So the figure moves when the
 * transport does, which is what makes the fix checkable from production data
 * rather than from a log line.
 *
 * It is an occupancy check and not a delivery receipt — Socket.IO offers no
 * acknowledgement without one per client — so a socket that drops between the
 * emit and the count is still counted. What it rules out is the case that was
 * being mis-reported: nobody connected anywhere. `false` lands on `failed`,
 * matching what `deliverPush` already does when a user has no registered token.
 */
async function deliverInApp(notification: NotificationRecord): Promise<boolean> {
  const io = getIO();
  if (!io) return false;

  const room = `user:${notification.oxyUserId}`;

  io.to(room).emit('notification', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority,
    data: notification.data,
    createdAt: notification.createdAt,
  });

  // Counted AFTER the emit: the emit is the delivery attempt and this is the
  // observation of it. Counting first would miss a client that connected in
  // between and under-report a delivery that did happen.
  const recipients = await io.in(room).fetchSockets();
  return recipients.length > 0;
}

// ── Expo Push Notifications ─────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered Expo push tokens.
 * Handles chunked sending (Expo limit) and async receipt checking.
 */
async function deliverPush(userId: string, notification: NotificationRecord): Promise<boolean> {
  const tokens = await findPushTokensForDelivery(userId);

  if (tokens.length === 0) return false;

  // Build messages — one per device token
  const messages: ExpoPushMessage[] = [];
  for (const target of tokens) {
    if (!Expo.isExpoPushToken(target.token)) {
      log.general.warn({ pushTokenId: target.id, userId }, 'Invalid Expo push token, deactivating');
      await deactivatePushTokenById(target.id);
      continue;
    }

    messages.push({
      to: target.token,
      title: notification.title,
      body: notification.body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        conversationId: notification.conversationId,
        ...notification.data,
      },
      sound: 'default',
      priority:
        notification.priority === 'urgent' || notification.priority === 'high' ? 'high' : 'normal',
      channelId: 'default',
    });
  }

  if (messages.length === 0) return false;

  // Send in chunks (Expo recommends batches of ~100)
  const chunks = expo.chunkPushNotifications(messages);
  const receiptIds: ExpoPushReceiptId[] = [];
  let anySucceeded = false;

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
          anySucceeded = true;
          if (ticket.id) {
            receiptIds.push(ticket.id);
          }
        } else {
          // ticket.status === 'error' — `chunk[i]` is the matching ExpoPushMessage.
          // Each message was built with a single-token `to`, so normalize the
          // `ExpoPushToken | ExpoPushToken[]` union back to one token string.
          const messageTo = chunk[i]?.to;
          const failedToken = Array.isArray(messageTo) ? messageTo[0] : messageTo;
          log.general.warn(
            { userId, error: ticket.message, errorCode: ticket.details?.error },
            'Expo push ticket error',
          );

          // Deactivate tokens that are permanently invalid. Expo names the TOKEN
          // and nothing else, which is what `push_tokens_token_idx` serves.
          if (ticket.details?.error === 'DeviceNotRegistered' && failedToken) {
            await deactivatePushTokensByToken(failedToken);
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error, userId }, 'Expo push chunk send failed');
    }
  }

  // Fire-and-forget receipt checking (delayed). A receipt-check failure is
  // non-fatal (best-effort cleanup of bad tokens), but it must be logged, never
  // swallowed silently.
  if (receiptIds.length > 0) {
    setTimeout(() => {
      checkPushReceipts(receiptIds).catch((err: unknown) => {
        log.general.warn({ err }, 'Expo push receipt check failed');
      });
    }, RECEIPT_CHECK_DELAY_MS);
  }

  // Update lastUsedAt for the tokens a send was actually attempted against.
  if (anySucceeded) {
    await touchPushTokensLastUsed(
      tokens.filter((target) => Expo.isExpoPushToken(target.token)).map((target) => target.id),
    );
  }

  return anySucceeded;
}

/**
 * Check push notification receipts after a delay.
 * Expo recommends checking ~15 seconds after sending.
 */
async function checkPushReceipts(receiptIds: ExpoPushReceiptId[]): Promise<void> {
  const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of chunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const { message, details } = receipt;
          log.general.warn({ receiptId, message, error: details?.error }, 'Expo push receipt error');

          // Deactivate invalid device tokens
          if (details?.error === 'DeviceNotRegistered') {
            // We can't directly map receiptId -> token, but Expo will stop delivering
            // to unregistered devices. The token gets deactivated on the next send attempt.
            log.general.info({ receiptId }, 'Device not registered — token will be deactivated on next send');
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error }, 'Failed to check Expo push receipts');
    }
  }
}

// ── Web Push Notifications ───────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered web push subscriptions.
 * Handles 410 Gone (expired subscription) by deactivating.
 */
async function deliverWebPush(userId: string, notification: NotificationRecord): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) return false;

  const subscriptions = await findWebPushSubscriptionsForDelivery(userId);

  if (subscriptions.length === 0) return false;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    type: notification.type,
    conversationId: notification.conversationId,
    ...notification.data,
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth } },
          payload,
        );
      } catch (error: unknown) {
        const isGone =
          error instanceof WebPushError &&
          (error.statusCode === HTTP_GONE || error.statusCode === HTTP_NOT_FOUND);
        if (isGone) {
          // Subscription expired or invalid — deactivate
          await deactivateWebPushSubscriptionById(sub.id);
          log.general.info({ userId, subscriptionId: sub.id }, 'Web push subscription expired, deactivated');
        } else {
          log.general.warn({ err: error, userId, subscriptionId: sub.id }, 'Web push delivery failed');
        }
        throw error; // Re-throw so Promise.allSettled marks as rejected
      }
    }),
  );

  return results.some(r => r.status === 'fulfilled');
}

// ── Main send function ─────────────────────────────────────────────

/**
 * Create and deliver a notification to a user across their preferred channels.
 *
 * The row is committed BEFORE any channel is attempted, deliberately: a
 * notification that reached nobody is still in the feed the next time the user
 * opens the app, and that is the whole point of persisting it.
 */
export async function sendNotification(
  options: SendNotificationOptions,
): Promise<NotificationRecord> {
  const { userId, type, title, body, priority = 'normal', data, conversationId, expiresAt } =
    options;

  const channels = await resolveChannels(userId, options.channels);

  // The map every channel reports into. Composed here and written ONCE at the
  // end — `Record<channel, 'pending' | 'sent' | 'failed'>`, whose `failed` is NOT
  // a `notifications.status` value and must never be flattened into that column.
  const deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'> = Object.fromEntries(
    channels.map((channel) => [channel, 'pending']),
  );

  const notification = await insertNotification({
    oxyUserId: userId,
    type,
    title,
    body: body.slice(0, MAX_BODY_LENGTH),
    data,
    channels,
    deliveryStatus,
    status: 'sent',
    priority,
    conversationId,
    expiresAt,
  });

  // Deliver to each channel in parallel
  const deliveries = channels.map(async (channel) => {
    try {
      let success = false;

      switch (channel) {
        case 'in_app':
          success = await deliverInApp(notification);
          break;
        case 'push': {
          // Deliver to both Expo (mobile) and web push in parallel
          const [expoPushOk, webPushOk] = await Promise.all([
            deliverPush(userId, notification),
            deliverWebPush(userId, notification),
          ]);
          success = expoPushOk || webPushOk;
          break;
        }
      }

      deliveryStatus[channel] = success ? 'sent' : 'failed';
    } catch (error: unknown) {
      log.general.error({ err: error, channel, userId }, 'Notification delivery failed');
      deliveryStatus[channel] = 'failed';
    }
  });

  await Promise.allSettled(deliveries);

  const persisted = await updateNotificationDeliveryStatus(notification.id, deliveryStatus);

  log.general.info(
    { type, userId, channels, title: title.slice(0, 50) },
    'Notification sent',
  );

  // `persisted` is null only if the row was deleted while the channels were in
  // flight. The caller asked for what was sent, so answer with the composed row
  // rather than inventing a failure out of a race nothing here can lose.
  return persisted ?? { ...notification, deliveryStatus };
}
