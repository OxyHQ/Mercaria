/**
 * The notifications-domain repositories, against a REAL Postgres database.
 *
 * There was no test for either notification service before this port, so nothing
 * here is replacing a mocked one — but a mocked test could not have covered any
 * of it either. Every block below asserts something that only a server can
 * answer, and each corresponds to a way the Mongo code was legal and the
 * Postgres translation is not:
 *
 *  - **`notifications_dismissed_at_check`.** Mongo's `dismissNotification` wrote
 *    `status` alone and its `markAsRead` moved a document OUT of `dismissed`
 *    without a thought. Both spellings are SQLSTATE 23514 now. The rejection is
 *    asserted in BOTH directions (a status with no timestamp, and a timestamp
 *    with no status) because a CHECK written as a one-way implication would pass
 *    a test that only tried one of them.
 *  - **The 90-day retention measures from `dismissed_at`, not `created_at`.** The
 *    two fixtures are the same age by `created_at` and differ ONLY in whether they
 *    were dismissed, so a sweep still measuring from `created_at` — the Mongo rule
 *    — reaps both and fails here rather than passing quietly.
 *  - **The unread set.** Fixtures sit on both sides of every distinction the
 *    predicate makes: `pending` and `sent` in, `read` and `dismissed` out, and
 *    another user's unread row out by scope. A predicate that lost any one of
 *    those clauses fails on a different fixture.
 *  - **`push_tokens_oxy_user_id_token_key`.** A re-registration is an upsert. The
 *    row count is the assertion, since a second row is precisely what the unique
 *    index exists to prevent and precisely what a naive `insert` would produce.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, getTableName, inArray } from 'drizzle-orm';
import { isCheckViolation, uuidv7 } from '@oxyhq/db';
import { sweepExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { EXPIRY_TARGETS } from '../expiryTargets.js';
import { notifications, pushTokens } from '../schema/notifications.js';
import {
  countUnreadNotifications,
  findNotificationsPage,
  insertNotification,
  markAllNotificationsRead,
  markNotificationDismissed,
  markNotificationRead,
  type NewNotification,
  type NotificationRecord,
} from '../notifications/notificationRepository.js';
import {
  deactivatePushToken,
  findPushTokensForDelivery,
  upsertPushToken,
} from '../notifications/pushTokenRepository.js';

let db: Database;

/** Oxy user ids minted by a test, whose rows are dropped after it. */
const createdUserIds: string[] = [];

/** 91 days ago — one day past the retention, on either column. */
const PAST_RETENTION = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);

/**
 * A fresh Oxy user id, registered for cleanup.
 *
 * The WHOLE uuid: v7 is time-ordered, so two ids minted in the same millisecond
 * share their leading characters and a truncated suffix would let one test see
 * another's rows.
 */
function newUserId(): string {
  const id = `notif-${uuidv7()}`;
  createdUserIds.push(id);
  return id;
}

/** A notification with everything a caller must supply, overridable per test. */
async function makeNotification(
  oxyUserId: string,
  overrides: Partial<NewNotification> = {},
): Promise<NotificationRecord> {
  return insertNotification({
    oxyUserId,
    type: 'order_placed',
    title: 'Order placed',
    body: 'Your order has been placed.',
    channels: ['in_app'],
    deliveryStatus: { in_app: 'sent' },
    status: 'sent',
    priority: 'normal',
    ...overrides,
  });
}

/** An Expo-shaped token unique to one test. */
function newPushToken(): string {
  return `ExponentPushToken[${uuidv7()}]`;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;
  await db.delete(notifications).where(inArray(notifications.oxyUserId, userIds));
  await db.delete(pushTokens).where(inArray(pushTokens.oxyUserId, userIds));
});

afterAll(async () => {
  await closePostgres();
});

describe('the dismissed_at CHECK', () => {
  it('sets the status and the timestamp in one statement', async () => {
    const user = newUserId();
    const created = await makeNotification(user);
    // NON-VACUOUS: the row really starts outside the dismissed state, so the
    // assertions below are about the transition and not about the insert.
    expect(created.status).toBe('sent');
    expect(created.dismissedAt).toBeNull();

    expect(await markNotificationDismissed(user, created.id)).toBe(true);

    const { rows } = await findNotificationsPage(user, {}, 1, 10);
    expect(rows[0].status).toBe('dismissed');
    expect(rows[0].dismissedAt).toBeInstanceOf(Date);
  });

  it('REJECTS a dismissed status with no timestamp', async () => {
    const user = newUserId();
    const created = await makeNotification(user);

    // Exactly what Mongo's `dismissNotification` wrote: `{$set: {status}}`.
    let caught: unknown;
    try {
      await db
        .update(notifications)
        .set({ status: 'dismissed' })
        .where(eq(notifications.id, created.id));
    } catch (error) {
      caught = error;
    }
    expect(isCheckViolation(caught, 'notifications_dismissed_at_check')).toBe(true);

    const { rows } = await findNotificationsPage(user, {}, 1, 10);
    expect(rows[0].status).toBe('sent');
  });

  it('REJECTS a timestamp with no dismissed status', async () => {
    const user = newUserId();
    const created = await makeNotification(user);

    // The other half. A CHECK written as a one-way implication
    // (`status = 'dismissed' => dismissed_at is not null`) passes the test above
    // and fails this one, which is why both are here: a stray `dismissed_at` on a
    // live notification would put it in the sweep's set and delete a row the user
    // never dismissed.
    let caught: unknown;
    try {
      await db
        .update(notifications)
        .set({ dismissedAt: new Date() })
        .where(eq(notifications.id, created.id));
    } catch (error) {
      caught = error;
    }
    expect(isCheckViolation(caught, 'notifications_dismissed_at_check')).toBe(true);

    const { rows } = await findNotificationsPage(user, {}, 1, 10);
    expect(rows[0].dismissedAt).toBeNull();
  });

  it('clears BOTH halves when a dismissed notification is marked read', async () => {
    const user = newUserId();
    const created = await makeNotification(user);
    await markNotificationDismissed(user, created.id);

    // Reachable from the feed: the user dismisses a notification and then taps it.
    // Mongo's `markAsRead` wrote `status` alone, which is a 23514 here — so this
    // is the transition, not a hypothetical.
    expect(await markNotificationRead(user, created.id)).toBe(true);

    const { rows } = await findNotificationsPage(user, {}, 1, 10);
    expect(rows[0].status).toBe('read');
    expect(rows[0].dismissedAt).toBeNull();
    expect(rows[0].readAt).toBeInstanceOf(Date);
  });
});

describe('the 90-day retention sweep', () => {
  it('reaps 90 days past the DISMISSAL and never a row that was not dismissed', async () => {
    const user = newUserId();
    const dismissed = await makeNotification(user);
    const neverDismissed = await makeNotification(user);

    await markNotificationDismissed(user, dismissed.id);

    // Both rows are backdated on `created_at` to the same instant, so the ONLY
    // difference between them is `dismissed_at`. A sweep still measuring from
    // `created_at` — Mongo's rule, with its partial filter lost in translation —
    // deletes both and fails the count below.
    await db
      .update(notifications)
      .set({ createdAt: PAST_RETENTION, dismissedAt: PAST_RETENTION })
      .where(eq(notifications.id, dismissed.id));
    await db
      .update(notifications)
      .set({ createdAt: PAST_RETENTION })
      .where(eq(notifications.id, neverDismissed.id));

    const target = EXPIRY_TARGETS.find((entry) => getTableName(entry.table) === 'notifications');
    // Vacuity floor: without an entry the sweep below would run over nothing and
    // "no rows were reaped" would read as a pass.
    expect(target, 'notifications has no EXPIRY_TARGETS entry').toBeDefined();
    if (!target) return;

    const result = await sweepExpiredRows(db, target);
    expect(result.deleted).toBe(1);

    const { rows } = await findNotificationsPage(user, {}, 1, 10);
    expect(rows.map((row) => row.id)).toEqual([neverDismissed.id]);
    expect(rows[0].dismissedAt).toBeNull();
  });
});

describe('the unread count and the unread feed', () => {
  it('selects exactly the pending and sent rows, and only this user’s', async () => {
    const user = newUserId();
    const other = newUserId();

    const pending = await makeNotification(user, { status: 'pending', deliveryStatus: {} });
    const sent = await makeNotification(user, { status: 'sent' });
    const alreadyRead = await makeNotification(user, { status: 'read' });
    const willDismiss = await makeNotification(user);
    await markNotificationDismissed(user, willDismiss.id);
    const otherUsers = await makeNotification(other, { status: 'pending' });

    expect(await countUnreadNotifications(user)).toBe(2);
    expect(await countUnreadNotifications(other)).toBe(1);

    // The FEED is the row set that predicate selects, and `markAllNotificationsRead`
    // is the path that acts on it — so the ids it returns ARE the feed.
    const marked = await markAllNotificationsRead(user);
    expect([...marked].sort()).toEqual([pending.id, sent.id].sort());

    expect(await countUnreadNotifications(user)).toBe(0);
    // The other user's unread notification was never in scope.
    expect(await countUnreadNotifications(other)).toBe(1);

    const { rows } = await findNotificationsPage(user, {}, 1, 10);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // The rows the predicate excluded kept their own state — in particular the
    // dismissed one kept the timestamp its retention is measured from.
    expect(byId.get(alreadyRead.id)?.status).toBe('read');
    expect(byId.get(willDismiss.id)?.status).toBe('dismissed');
    expect(byId.get(willDismiss.id)?.dismissedAt).toBeInstanceOf(Date);

    const otherRows = await findNotificationsPage(other, {}, 1, 10);
    expect(otherRows.rows.map((row) => row.id)).toEqual([otherUsers.id]);
    expect(otherRows.rows[0].status).toBe('pending');
  });
});

describe('push-token registration', () => {
  it('upserts a re-registration instead of inserting a second row', async () => {
    const user = newUserId();
    const token = newPushToken();

    const first = await upsertPushToken(user, { token, deviceId: 'device-a', platform: 'ios' });
    const second = await upsertPushToken(user, { token, platform: 'android' });

    expect(second.id).toBe(first.id);

    const rows = await db
      .select({
        id: pushTokens.id,
        deviceId: pushTokens.deviceId,
        platform: pushTokens.platform,
        active: pushTokens.active,
      })
      .from(pushTokens)
      .where(eq(pushTokens.oxyUserId, user));

    // The unique index absorbed the second registration; a plain insert would
    // have raised 23505, and a duplicate-tolerant one would show two rows here.
    expect(rows).toHaveLength(1);
    // What the client re-reported was refreshed...
    expect(rows[0].platform).toBe('android');
    // ...and what it did NOT send was left alone rather than nulled.
    expect(rows[0].deviceId).toBe('device-a');
    expect(rows[0].active).toBe(true);
  });

  it('reactivates a token the user had logged out of', async () => {
    const user = newUserId();
    const token = newPushToken();

    await upsertPushToken(user, { token });
    expect(await deactivatePushToken(user, token)).toBe(true);
    expect(await findPushTokensForDelivery(user)).toEqual([]);

    await upsertPushToken(user, { token });
    expect((await findPushTokensForDelivery(user)).map((row) => row.token)).toEqual([token]);
  });

  it('stores an unreported deviceId as NULL, never an empty string', async () => {
    const user = newUserId();
    const token = newPushToken();

    await upsertPushToken(user, { token });

    const rows = await db
      .select({ deviceId: pushTokens.deviceId, platform: pushTokens.platform })
      .from(pushTokens)
      .where(eq(pushTokens.oxyUserId, user));

    // A field Mongo left ABSENT is NULL here. `''` is a real value that compares
    // equal to the next device that also reports nothing.
    expect(rows[0].deviceId).toBeNull();
    expect(rows[0].platform).toBeNull();
  });
});
