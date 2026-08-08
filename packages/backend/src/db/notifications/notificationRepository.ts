/**
 * `notifications` — one message to one person, and the read-state transitions
 * the feed drives.
 *
 * ## `dismissed_at` is HALF of a CHECK, so it is never written alone
 *
 * `notifications_dismissed_at_check` states
 * `(status = 'dismissed') = (dismissed_at is not null)`. Mongo had no such rule:
 * `dismissNotification` set only `status`, and `markAsRead` moved a document out
 * of `dismissed` without a thought. Both spellings raise SQLSTATE 23514 here, so
 * every transition in this module writes BOTH columns together —
 * {@link markNotificationDismissed} sets the pair, {@link markNotificationRead}
 * clears `dismissed_at` because marking a dismissed notification read UN-dismisses
 * it.
 *
 * That column is also what `db/expiryTargets.ts` measures the 90-day retention
 * from, which is a real behaviour change worth stating: Mongo's TTL index counted
 * 90 days from `created_at` with `partialFilterExpression: {status: 'dismissed'}`,
 * so a notification dismissed on day 89 vanished the next morning while one
 * dismissed on day 1 survived for 89 more. Every row now gets its full 90 days
 * FROM THE DISMISSAL, and a row that was never dismissed has NULL and is never
 * swept at all. Clearing `dismissed_at` on a read therefore also takes the row
 * back out of the sweep's set — correct, since it is no longer dismissed.
 *
 * ## The unread predicate is a LITERAL, and that is not laziness
 *
 * `notifications_oxy_user_id_unread_idx` is a PARTIAL index carrying
 * `where status in ('pending', 'sent')`. Postgres can only use a partial index
 * when it can PROVE the query's predicate is implied by the index's, and that
 * proof runs against the parsed expression: `status in ('pending','sent')` with
 * literal constants parses to the same `ScalarArrayOpExpr` the index stored, so
 * it is proven. Drizzle's `inArray(...)` renders `status in ($1, $2)` instead,
 * and a generic plan has no constants to prove anything about — the index is
 * silently skipped and the unread count becomes a scan of the user's whole
 * history. {@link UNREAD_STATUS_PREDICATE} is spelled to match the index text
 * character for character; changing one without the other costs nothing visible
 * until a heavy account.
 *
 * ## `trigger_id` is gone
 *
 * The Mongoose model carried `triggerId: {type: ObjectId, ref: 'Trigger'}` and
 * there is no `Trigger` model in this repo. No caller passed one and no read path
 * returned it, so it is not ported and {@link NewNotification} has no such field.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  notifications,
  type NotificationType,
} from '../schema/notifications.js';

/** One row of `notifications`. */
export type NotificationRecord = InferSelectModel<typeof notifications>;

/**
 * The three remaining closed value sets, derived from the SAME tuples the
 * schema's CHECK constraints are rendered from. `NotificationType` comes from
 * the schema module directly; these three have no other consumer, so they are
 * declared where they are used rather than pushed back into the schema file.
 *
 * `channels` is a bare `text[]` in the schema — `NOTIFICATION_CHANNELS` reaches
 * the database as `notifications_channels_check` (array CONTAINMENT, since a
 * CHECK cannot `unnest`) and not as a column type, so the row type says
 * `string[]` and only the WRITE side is narrowed here.
 */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/**
 * The unread states, written exactly as `notifications_oxy_user_id_unread_idx`
 * writes them. See the module docblock — the literal is what makes the partial
 * index usable.
 */
const UNREAD_STATUS_PREDICATE: SQL = sql`${notifications.status} in ('pending', 'sent')`;

/** The fields a caller may set when creating a notification. */
export interface NewNotification {
  oxyUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels: NotificationChannel[];
  deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'>;
  status: NotificationStatus;
  priority: NotificationPriority;
  conversationId?: string;
  expiresAt?: Date;
}

/** The filters the feed accepts, already narrowed to values a column can hold. */
export interface NotificationFilter {
  status?: NotificationStatus;
  type?: NotificationType;
}

/**
 * Whether `value` is a real `notifications.status`.
 *
 * The feed's filters arrive as request strings. Narrowing them here rather than
 * widening the column's type is what keeps a caller from filtering on a value the
 * CHECK forbids — and lets the service answer an unknown one with an empty page
 * rather than silently dropping the filter and returning everything.
 */
export function isNotificationStatus(value: string): value is NotificationStatus {
  return (NOTIFICATION_STATUSES as readonly string[]).includes(value);
}

/** Whether `value` is a real `notifications.type`. Same reasoning as above. */
export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** Create a notification. `deliveryStatus` starts as the caller composed it. */
export async function insertNotification(
  values: NewNotification,
  db: DatabaseOrTransaction = getDb(),
): Promise<NotificationRecord> {
  const [row] = await db.insert(notifications).values(values).returning();
  return row;
}

/**
 * Record the per-channel delivery outcome once every channel has answered.
 *
 * ONE update at the end rather than one per channel: the Mongo path mutated the
 * document in place and called `save()` after `Promise.allSettled`, which is the
 * same single write — but `save()` would have raced any concurrent read-state
 * change on the whole document, where this touches one column.
 *
 * @returns The stored row, or `null` if it no longer exists.
 */
export async function updateNotificationDeliveryStatus(
  notificationId: string,
  deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'>,
  db: DatabaseOrTransaction = getDb(),
): Promise<NotificationRecord | null> {
  const rows = await db
    .update(notifications)
    .set({ deliveryStatus, updatedAt: new Date() })
    .where(eq(notifications.id, notificationId))
    .returning();
  return rows[0] ?? null;
}

/** The user's live unread count — the partial index's whole reason for existing. */
export async function countUnreadNotifications(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.oxyUserId, oxyUserId), UNREAD_STATUS_PREDICATE));
  return row?.count ?? 0;
}

/**
 * A page of the user's notifications, newest first, with the matched total.
 *
 * `id` is a secondary sort key that Mongo's `{createdAt: -1}` did not have.
 * `created_at` carries milliseconds and a fan-out writes several notifications
 * inside one, so without a tiebreaker two offset pages can repeat a row and skip
 * another. The id is not meaningful as an order, only as a total one.
 */
export async function findNotificationsPage(
  oxyUserId: string,
  filter: NotificationFilter,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: NotificationRecord[]; total: number }> {
  const where = and(
    eq(notifications.oxyUserId, oxyUserId),
    ...(filter.status ? [eq(notifications.status, filter.status)] : []),
    ...(filter.type ? [eq(notifications.type, filter.type)] : []),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * Mark one of the user's notifications read.
 *
 * `dismissed_at` is cleared in the same statement: a dismissed notification being
 * marked read is leaving the `dismissed` status, and leaving it with the timestamp
 * still set is exactly what `notifications_dismissed_at_check` refuses. The Mongo
 * update wrote `status` alone and this transition was reachable from the feed, so
 * omitting the clear here is a 23514 on a real user action rather than a
 * theoretical one.
 *
 * @returns `false` when the notification is not this user's — the scoping IS the
 *   authorization, and the caller turns it into a NOT_FOUND.
 */
export async function markNotificationRead(
  oxyUserId: string,
  notificationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(notifications)
    .set({ status: 'read', readAt: now, dismissedAt: null, updatedAt: now })
    .where(and(eq(notifications.id, notificationId), eq(notifications.oxyUserId, oxyUserId)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Mark every unread notification of the user's read.
 *
 * `dismissed_at` is NOT touched, and that is deliberate rather than an omission:
 * the predicate selects only `pending`/`sent` rows, and the CHECK guarantees such
 * a row already has a NULL `dismissed_at`. Writing the column anyway would be a
 * no-op update on every row in the set.
 *
 * @returns The ids actually marked, so the caller can report the count and a test
 *   can assert the exact SET the unread predicate selected.
 */
export async function markAllNotificationsRead(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .update(notifications)
    .set({ status: 'read', readAt: now, updatedAt: now })
    .where(and(eq(notifications.oxyUserId, oxyUserId), UNREAD_STATUS_PREDICATE))
    .returning({ id: notifications.id });
  return rows.map((row) => row.id);
}

/**
 * Dismiss one of the user's notifications.
 *
 * Both halves of the CHECK in one statement, which is also what starts the 90-day
 * retention clock — see the module docblock. Re-dismissing an already-dismissed
 * notification RESETS `dismissed_at`, matching what the user just did.
 *
 * @returns `false` when the notification is not this user's.
 */
export async function markNotificationDismissed(
  oxyUserId: string,
  notificationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(notifications)
    .set({ status: 'dismissed', dismissedAt: now, updatedAt: now })
    .where(and(eq(notifications.id, notificationId), eq(notifications.oxyUserId, oxyUserId)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}
