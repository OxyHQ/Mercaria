/**
 * Delivery to a person: `notifications`, `push_tokens`,
 * `web_push_subscriptions`.
 *
 * This is where the schema's one genuinely OPEN-shaped payload lives, and where
 * the only Mongo TTL index that is not a plain deadline had to be re-expressed
 * rather than copied.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
} from './columns';

/** `Notification.type`. */
export const NOTIFICATION_TYPES = [
  'trigger_result',
  'proactive_insight',
  'daily_briefing',
  'price_alert',
  'integration_event',
  'reminder',
  'agent_task_complete',
  'chat_response_ready',
  'oxy_service',
  // Marketplace (order lifecycle + reviews + store).
  'order_placed',
  'order_paid',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'listing_sold',
  'review_received',
  'store_member_invited',
  'low_inventory',
  // Moderation: a decision asked the seller to change a listing before it can be
  // relisted. The only moderation outcome the seller can act on themselves.
  'listing_changes_requested',
  // Merchant claiming (#83, security control 7): the CURRENT verified operator
  // is told when somebody contests their claim and when their verification is
  // withdrawn. Both are high-impact and neither is discoverable any other way —
  // a merchant losing its operator silently is the failure this prevents.
  'merchant_claim_contested',
  'merchant_claim_revoked',
  // A saved shopping agent (#97) observed something its owner asked to be told
  // about. Deliberately NOT `price_alert`: an alert answers one price question
  // and an agent answers a saved OBJECTIVE, so a client that renders them
  // identically has decided to, rather than been unable to tell them apart.
  'shopping_agent_finding',
] as const;

/**
 * The `type` union, derived from the tuple above so there is ONE list.
 *
 * Declared here rather than beside the Mongoose model it came from: the tuple
 * that types this union is the same tuple `notifications_type_check` is rendered
 * from, and a second copy is a second thing to keep in lockstep.
 */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** `Notification.channels` element. */
export const NOTIFICATION_CHANNELS = [
  'push',
  'telegram',
  'discord',
  'whatsapp',
  'slack',
  'in_app',
] as const;

/** `Notification.status`. */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'read', 'dismissed'] as const;

/** `Notification.priority`. */
export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/** `PushToken.platform`. */
export const PUSH_TOKEN_PLATFORMS = ['ios', 'android', 'web'] as const;

/**
 * `notifications` — one message to one user.
 *
 * ## `data` and `delivery_status` are the schema's legitimate jsonb
 *
 * `data` is `Schema.Types.Mixed`, and genuinely so: each of the twenty
 * notification types carries its own payload, composed at the call site and read
 * back only by the client that renders it. There is no column set that fits all
 * twenty, and projecting the ones that exist today would silently drop whatever
 * a new type adds tomorrow.
 *
 * `delivery_status` is `Record<channel, 'pending' | 'sent' | 'failed'>` — a map
 * keyed by whichever channels this notification was dispatched to. It is jsonb
 * for the same reason and carries one specific trap worth stating: its `failed`
 * value is NOT a `Notification.status` value, so flattening this map into the
 * status column during a later refactor is an immediate CHECK violation.
 *
 * ## `trigger_id` is NOT ported
 *
 * The Mongoose model declared `triggerId: { type: ObjectId, ref: 'Trigger' }`.
 * There is no `Trigger` model anywhere in this repo, no caller passes a
 * `triggerId` to `createNotification`, and no read path returns it — the field
 * appears in exactly three lines of `lib/notification-service.ts` (the parameter,
 * the forward, and the write) and nowhere else in `src/`. It is a dangling
 * reference to a model that does not exist, carried across from another Oxy
 * service. Dropping it is the "no Mongo baggage travels" half of the port.
 *
 * ## The TTL is the one that needed re-expressing, not copying
 *
 * Mongo reaped with `{createdAt: 1}, expireAfterSeconds: 90d,
 * partialFilterExpression: {status: 'dismissed'}` — a CONDITIONAL delete.
 * `@oxyhq/db`'s expiry registry takes `{table, column, retentionSeconds}` and has
 * no filter, so the condition cannot be passed to it.
 *
 * `dismissed_at` is the answer, and it is a better statement of the same rule
 * than the original: the column is set ONLY when a notification is dismissed, so
 * "90 days past `dismissed_at`" reaps exactly the set Mongo's partial filter
 * described, and a row that was never dismissed has NULL and is never swept. It
 * also fixes a real skew in the original — Mongo measured the 90 days from
 * `createdAt`, so a notification dismissed on day 89 vanished the next day while
 * one dismissed on day 1 survived for 89. The retention now measures from the
 * event it is actually about. See `db/expiryTargets.ts`.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    type: text({ enum: asEnumValues(NOTIFICATION_TYPES) }).notNull(),
    title: text().notNull(),
    body: text().notNull(),
    /** Per-type payload — genuinely open-shaped. See the table docblock. */
    data: jsonb().$type<Record<string, unknown>>(),
    channels: text().array().notNull().default(sql`'{}'::text[]`),
    /** channel → `pending` | `sent` | `failed`. See the table docblock. */
    deliveryStatus: jsonb()
      .$type<Record<string, 'pending' | 'sent' | 'failed'>>()
      .notNull()
      .default({}),
    status: text({ enum: asEnumValues(NOTIFICATION_STATUSES) }).notNull().default('pending'),
    priority: text({ enum: asEnumValues(NOTIFICATION_PRIORITIES) }).notNull().default('normal'),
    /** An opaque conversation reference from another Oxy service — no foreign key. */
    conversationId: text(),
    expiresAt: timestamptz(),
    readAt: timestamptz(),
    /**
     * When the user dismissed this. Set ONLY on dismissal, and the column the
     * 90-day retention sweep measures from — see the table docblock.
     */
    dismissedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('notifications_type_check', t.type, NOTIFICATION_TYPES),
    checkOneOf('notifications_status_check', t.status, NOTIFICATION_STATUSES),
    checkOneOf('notifications_priority_check', t.priority, NOTIFICATION_PRIORITIES),
    checkEveryElementOf('notifications_channels_check', t.channels, NOTIFICATION_CHANNELS),
    // The two must agree, or the sweep either misses dismissed rows or reaps
    // live ones. Stated here because the sweep itself cannot check it.
    check(
      'notifications_dismissed_at_check',
      sql`(${t.status} = 'dismissed') = (${t.dismissedAt} is not null)`,
    ),
    index('notifications_oxy_user_id_status_created_at_idx').on(
      t.oxyUserId,
      t.status,
      t.createdAt.desc(),
    ),
    // The unread count and unread feed — a PARTIAL index covering only the unread
    // states, exactly as Mongo's `partialFilterExpression` did.
    index('notifications_oxy_user_id_unread_idx')
      .on(t.oxyUserId, t.createdAt.desc())
      .where(sql`${t.status} in ('pending', 'sent')`),
    // The leading btree the retention sweep needs — without it the sweep's
    // `dismissed_at <= now() - 90d` is a full scan every time it runs, which is
    // the cost Mongo's TTL index hid.
    index('notifications_dismissed_at_idx')
      .on(t.dismissedAt)
      .where(sql`${t.dismissedAt} is not null`),
  ],
);

/** `push_tokens` — an Expo push token for one device of one user. */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /** The Expo push token. A bearer-ish credential — a PROTECTED column. */
    token: text().notNull(),
    /** A client-supplied device identifier — not an Oxy id, no foreign key. */
    deviceId: text(),
    platform: text({ enum: asEnumValues(PUSH_TOKEN_PLATFORMS) }),
    active: boolean().notNull().default(true),
    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('push_tokens_platform_check', t.platform, PUSH_TOKEN_PLATFORMS),
    uniqueIndex('push_tokens_oxy_user_id_token_key').on(t.oxyUserId, t.token),
    // Receipt error handling (`DeviceNotRegistered`) arrives naming the token.
    index('push_tokens_token_idx').on(t.token),
  ],
);

/**
 * `web_push_subscriptions` — a browser Web Push endpoint and its keys.
 *
 * `keys.p256dh` and `keys.auth` are the subscription's encryption material.
 * Flattened into two columns rather than jsonb — the shape is exactly two fields
 * — and both are PROTECTED: handing them to a client hands them the ability to
 * push to that browser.
 */
export const webPushSubscriptions = pgTable(
  'web_push_subscriptions',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    endpoint: text().notNull(),
    keysP256dh: text().notNull(),
    keysAuth: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('web_push_subscriptions_oxy_user_id_endpoint_key').on(t.oxyUserId, t.endpoint)],
);
