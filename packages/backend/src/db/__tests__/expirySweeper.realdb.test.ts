/**
 * The expiry sweep LOOP, against a REAL Postgres database.
 *
 * `notifications.realdb.test.ts` already pins the notification target's own rule
 * (90 days past the DISMISSAL, never past creation). This file tests the thing
 * above it: that `sweepExpiredRowsOnce` — what the scheduler in
 * `db/expirySweeper.ts` calls on every tick — actually runs over EVERY registry
 * entry, and that the two moderation targets delete what they should and keep
 * what they should.
 *
 * ## Why this needs its own file rather than one more case next door
 *
 * The registry and the sweep mechanism both existed before anything called them.
 * A registry with no scheduler is not a partially-working feature, it is a list:
 * Postgres has no TTL index, so an unscheduled target grows FOREVER with no
 * error, no failing test and no symptom until disk. The thing that used to do
 * this work was a property of the Mongo SERVER, so nothing in this codebase went
 * missing when it was ported away — there is no deleted call site for a reviewer
 * to notice. That is precisely the class of gap a test has to close, because
 * review cannot.
 *
 * So the assertions here are about the WIRING as much as the SQL: every fixture
 * is swept through the same entry point production uses, and the vacuity floor
 * below fails if the registry ever stops naming all three tables.
 *
 * ## Every fixture pair spans the distinction its target exists to make
 *
 * A sweep test that only seeds expired rows cannot tell a correct predicate from
 * `DELETE FROM <table>`. Each block seeds one row that must GO and one that must
 * STAY, differing only in the column the target measures.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, getTableName, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { EXPIRY_TARGETS } from '../expiryTargets.js';
import { sweepExpiredRowsOnce } from '../expirySweeper.js';
import { moderationEvents, moderationOutboxes } from '../schema/moderation.js';
import { notifications } from '../schema/notifications.js';

let db: Database;

/** An hour in the past — comfortably past any `expires_at` deadline. */
const EXPIRED_AT = new Date(Date.now() - 60 * 60 * 1_000);
/** An hour in the future — comfortably short of one. */
const NOT_YET_EXPIRED_AT = new Date(Date.now() + 60 * 60 * 1_000);
/** 91 days ago: one day past the dismissed-notification retention. */
const PAST_NOTIFICATION_RETENTION = new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000);

const outboxIds: string[] = [];
const eventIds: string[] = [];
const notificationUserIds: string[] = [];

/**
 * An outbox row with a caller-supplied deadline.
 *
 * The id is minted per row rather than derived, unlike production's deterministic
 * `moderation:report.submit:<id>`: what is under test is the sweep, and two tests
 * converging on one row would make a deletion look like a survival.
 */
async function makeOutboxRow(expiresAt: Date): Promise<string> {
  const id = `sweep-outbox-${uuidv7()}`;
  outboxIds.push(id);
  await db.insert(moderationOutboxes).values({
    id,
    kind: 'report.submit',
    payload: { reportId: uuidv7() },
    status: 'pending',
    attempts: 0,
    availableAt: new Date(),
    expiresAt,
  });
  return id;
}

async function makeEventClaim(expiresAt: Date): Promise<string> {
  const id = `sweep-event-${uuidv7()}`;
  eventIds.push(id);
  await db.insert(moderationEvents).values({
    id,
    eventType: 'webhook',
    claimedAt: new Date(),
    expiresAt,
  });
  return id;
}

async function makeNotification(dismissedAt: Date | null): Promise<string> {
  const oxyUserId = `sweep-notif-${uuidv7()}`;
  notificationUserIds.push(oxyUserId);
  const [row] = await db
    .insert(notifications)
    .values({
      oxyUserId,
      type: 'order_placed',
      title: 'Order placed',
      body: 'Your order has been placed.',
      channels: ['in_app'],
      deliveryStatus: { in_app: 'sent' },
      // The CHECK ties these two together, so a dismissed fixture must set both.
      status: dismissedAt === null ? 'sent' : 'dismissed',
      priority: 'normal',
      ...(dismissedAt === null ? {} : { dismissedAt }),
    })
    .returning({ id: notifications.id });
  return row.id;
}

async function outboxExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: moderationOutboxes.id })
    .from(moderationOutboxes)
    .where(eq(moderationOutboxes.id, id));
  return rows.length === 1;
}

async function eventExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: moderationEvents.id })
    .from(moderationEvents)
    .where(eq(moderationEvents.id, id));
  return rows.length === 1;
}

async function notificationExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.id, id));
  return rows.length === 1;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  const outbox = outboxIds.splice(0);
  const events = eventIds.splice(0);
  const users = notificationUserIds.splice(0);
  if (outbox.length > 0) {
    await db.delete(moderationOutboxes).where(inArray(moderationOutboxes.id, outbox));
  }
  if (events.length > 0) {
    await db.delete(moderationEvents).where(inArray(moderationEvents.id, events));
  }
  if (users.length > 0) {
    await db.delete(notifications).where(inArray(notifications.oxyUserId, users));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the registry the sweeper runs over', () => {
  it('names every table that carried a Mongo TTL index, and nothing else', () => {
    // The vacuity floor for every case below: a sweep over an empty or shrunken
    // registry deletes nothing, and "the row survived" would then pass for the
    // wrong reason. Pinning the exact set also fails a table added to the
    // registry without a case here, rather than letting it ride untested.
    expect(EXPIRY_TARGETS.map((target) => getTableName(target.table)).sort()).toEqual([
      'moderation_events',
      'moderation_outboxes',
      'notifications',
    ]);
  });

  it('gives every target a reason, since a registry entry authorises a DELETE', () => {
    for (const target of EXPIRY_TARGETS) {
      expect(target.reason.length, `${getTableName(target.table)} has no reason`).toBeGreaterThan(0);
    }
  });
});

describe('sweepExpiredRowsOnce — the tick the scheduler runs', () => {
  it('reaps an expired outbox row and leaves one whose deadline has not passed', async () => {
    const expired = await makeOutboxRow(EXPIRED_AT);
    const live = await makeOutboxRow(NOT_YET_EXPIRED_AT);

    await sweepExpiredRowsOnce();

    expect(await outboxExists(expired), 'the expired outbox row survived').toBe(false);
    expect(await outboxExists(live), 'a live outbox row was reaped').toBe(true);
  });

  it('reaps an expired webhook dedupe claim and leaves a live one', async () => {
    const expired = await makeEventClaim(EXPIRED_AT);
    const live = await makeEventClaim(NOT_YET_EXPIRED_AT);

    await sweepExpiredRowsOnce();

    expect(await eventExists(expired), 'the expired claim survived').toBe(false);
    // A claim must outlive every redelivery of its event; reaping one early
    // lets a duplicate decision be processed a second time.
    expect(await eventExists(live), 'a live dedupe claim was reaped').toBe(true);
  });

  it('reaps a long-dismissed notification and leaves an undismissed one', async () => {
    const dismissed = await makeNotification(PAST_NOTIFICATION_RETENTION);
    const neverDismissed = await makeNotification(null);

    await sweepExpiredRowsOnce();

    expect(await notificationExists(dismissed), 'the dismissed notification survived').toBe(false);
    expect(await notificationExists(neverDismissed), 'an undismissed notification was reaped').toBe(
      true,
    );
  });

  it('covers all three targets in ONE tick, not just the first', async () => {
    // The case the three above cannot make between them: each passes if the
    // sweep runs only its own target. Seeding one doomed row per table and
    // sweeping once is what proves the loop does not stop early — which is
    // exactly what a `return` in place of a `continue`, or a sweep of
    // `EXPIRY_TARGETS[0]`, would do.
    const outbox = await makeOutboxRow(EXPIRED_AT);
    const event = await makeEventClaim(EXPIRED_AT);
    const notification = await makeNotification(PAST_NOTIFICATION_RETENTION);

    await sweepExpiredRowsOnce();

    expect(await outboxExists(outbox)).toBe(false);
    expect(await eventExists(event)).toBe(false);
    expect(await notificationExists(notification)).toBe(false);
  });
});
