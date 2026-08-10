/**
 * `price_alert_notifications` — the durable DELIVERY job (#79 evaluation 10).
 *
 * The moderation outbox, ported: a DETERMINISTIC id so a repeat converges, the
 * row IS the job, claims are leases with an owner check, capped exponential
 * backoff, and a VISIBLE `dead_letter`. Three things are different and each is
 * stated where it happens.
 *
 * ## The id is `sha256(triggerId + ':' + channel)`
 *
 * Derived from the two facts that decide identity and from nothing else — no
 * clock, no attempt counter, no evaluation run. A second enqueue for one trigger
 * on one channel therefore collides with the first and `DO NOTHING` writes
 * nothing at all: not a tuple version, not a timestamp, not a lock, on a row a
 * dispatcher may be holding. That structural no-op is what makes an enqueue safe
 * to re-run, and it is the property `moderation-writes.realdb.test.ts` pins with
 * an `xmin` assertion one domain over.
 *
 * ## A SUPPRESSION is terminal and leaves a row
 *
 * Not a delete and not a skip. Issue operations 3 asks for stale-link
 * suppression to be monitored, and a table of messages that were sent can never
 * answer how many were withheld — the same lesson `offer_price_write_metrics`
 * records about deduplication.
 *
 * ## `opened` is answered by a JOIN and is not a state
 *
 * `notification_id` names the `notifications` row this produced, and
 * `notifications.read_at` is the one place "they read it" is stored.
 */

import { and, asc, desc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type {
  PriceAlertDeliveryFailure,
  PriceAlertNotificationChannel,
  PriceAlertSuppressionReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { notifications } from '../schema/notifications.js';
import { priceAlertNotifications } from '../schema/priceAlerts.js';

export type PriceAlertNotificationRow = typeof priceAlertNotifications.$inferSelect;

/**
 * The row's id, derived from the trigger and the channel.
 *
 * Hex sha-256 rather than the two ids joined by a separator, so the id carries
 * no readable trigger id and cannot be used to enumerate one; the domain's own
 * lookups all go through the trigger id column, which is indexed.
 */
export function priceAlertNotificationId(
  triggerId: string,
  channel: PriceAlertNotificationChannel,
): string {
  return createHash('sha256').update(`${triggerId}:${channel}`).digest('hex');
}

/**
 * Queue one delivery. Idempotent by PRIMARY KEY.
 *
 * Runs in the caller's transaction, which is the same transaction the trigger
 * was written in: a trigger with no queued notification is a qualifying event
 * that reached nobody, and evaluation 10's whole point is that the delivery
 * survives independently once it exists.
 */
export async function enqueuePriceAlertNotification(
  input: {
    readonly triggerId: string;
    readonly alertId: string;
    readonly channel: PriceAlertNotificationChannel;
    readonly availableAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  const id = priceAlertNotificationId(input.triggerId, input.channel);
  await db
    .insert(priceAlertNotifications)
    .values({
      id,
      triggerId: input.triggerId,
      alertId: input.alertId,
      channel: input.channel,
      state: 'queued',
      attempts: 0,
      availableAt: input.availableAt,
    })
    .onConflictDoNothing();
  return id;
}

/** Atomically claim due deliveries. `FOR UPDATE SKIP LOCKED`, owner-checked. */
export async function claimPriceAlertNotifications(
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertNotificationRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(eq(priceAlertNotifications.state, 'queued'), lte(priceAlertNotifications.availableAt, now)),
    and(eq(priceAlertNotifications.state, 'failed'), lte(priceAlertNotifications.availableAt, now)),
    and(
      eq(priceAlertNotifications.state, 'delivering'),
      lte(priceAlertNotifications.leaseUntil, now),
    ),
  );

  return db
    .update(priceAlertNotifications)
    .set({
      state: 'delivering',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${priceAlertNotifications.attempts} + 1`,
    })
    .where(
      sql`${priceAlertNotifications.id} in (
        select ${priceAlertNotifications.id} from ${priceAlertNotifications}
        where ${due}
        order by ${asc(priceAlertNotifications.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(priceAlertNotifications.id, id),
    eq(priceAlertNotifications.state, 'delivering'),
    eq(priceAlertNotifications.leaseOwner, leaseOwner),
    gt(priceAlertNotifications.leaseUntil, now),
  );
}

/**
 * It reached the buyer. `notificationId` is what answers `openedAt` later.
 *
 * OPTIONAL, and the absence is a real case rather than laziness: the `email`
 * channel produces no `notifications` row, so there is nothing to link and
 * `openedAt` is permanently unanswerable for one — which is honest, because an
 * email open is a tracking pixel and this domain does not have one. Writing a
 * placeholder id would violate the foreign key, which is the constraint doing
 * exactly its job.
 */
export async function markPriceAlertNotificationDelivered(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly notificationId?: string;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(priceAlertNotifications)
    .set({
      state: 'delivered',
      deliveredAt: now,
      notificationId: input.notificationId ?? null,
      leaseOwner: null,
      leaseUntil: null,
      failureReason: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: priceAlertNotifications.id });
  return rows.length === 1;
}

/**
 * It was WITHHELD, and this row is the measurement.
 *
 * Terminal: a destination that stopped being eligible does not become eligible
 * again for THIS observation, and a deleted alert does not come back. A later
 * qualifying observation produces a new trigger and a new delivery.
 */
export async function markPriceAlertNotificationSuppressed(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly reason: PriceAlertSuppressionReason;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(priceAlertNotifications)
    .set({
      state: 'suppressed',
      suppressionReason: input.reason,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: priceAlertNotifications.id });
  return rows.length === 1;
}

/**
 * Release a failed claim with backoff — or stop, visibly.
 *
 * `deadLettered` is the CALLER's decision. An email delivery on a deployment
 * with no transport registered will reach it every time, which is exactly the
 * intended shape: the row states `transport_unconfigured` and an operator can
 * count them, rather than the feature silently doing nothing.
 */
export async function releasePriceAlertNotification(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly deadLettered: boolean;
    readonly availableAt: Date;
    readonly failure: PriceAlertDeliveryFailure;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(priceAlertNotifications)
    .set({
      state: input.deadLettered ? 'dead_letter' : 'failed',
      availableAt: input.availableAt,
      failureReason: input.failure,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: priceAlertNotifications.id });
  return rows.length === 1;
}

/** One delivery row, with `openedAt` joined from the notification it produced. */
export interface PriceAlertNotificationWithOpen {
  readonly row: PriceAlertNotificationRow;
  readonly openedAt: Date | null;
}

/**
 * One alert's delivery history — the ONLY read that answers `openedAt`.
 *
 * A LEFT join, because `notification_id` is `SET NULL` when the feed entry is
 * reaped by the ninety-day retention sweep: the delivery record outlives it, and
 * "we cannot say whether it was opened" is the honest answer for an old one
 * rather than `false`.
 */
export async function listPriceAlertNotifications(
  alertId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertNotificationWithOpen[]> {
  const rows = await db
    .select({ row: priceAlertNotifications, openedAt: notifications.readAt })
    .from(priceAlertNotifications)
    .leftJoin(notifications, eq(notifications.id, priceAlertNotifications.notificationId))
    .where(eq(priceAlertNotifications.alertId, alertId))
    .orderBy(desc(priceAlertNotifications.createdAt), desc(priceAlertNotifications.id))
    .limit(limit);
  return rows.map((entry) => ({ row: entry.row, openedAt: entry.openedAt ?? null }));
}

/** Every delivery for one trigger — the operator trace's read. */
export async function listPriceAlertNotificationsForTrigger(
  triggerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertNotificationRow[]> {
  return db
    .select()
    .from(priceAlertNotifications)
    .where(eq(priceAlertNotifications.triggerId, triggerId))
    .orderBy(priceAlertNotifications.channel);
}

/**
 * Issue operations 3's delivery rate and stale-link suppression, in one read.
 *
 * The suppression count is broken out BY REASON, because
 * `destination_no_longer_eligible` is the stale-link measurement the issue names
 * and the other three are ordinary buyer actions. A single "suppressed" total
 * would hide the one number an operator is being asked to watch.
 */
export async function summarizePriceAlertNotifications(
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  queued: number;
  delivering: number;
  delivered: number;
  failed: number;
  deadLetter: number;
  suppressedStaleDestination: number;
  suppressedOther: number;
  opened: number;
}> {
  const rows = await db
    .select({
      queued: sql<number>`count(*) filter (where ${priceAlertNotifications.state} = 'queued')::int`,
      delivering: sql<number>`count(*) filter (where ${priceAlertNotifications.state} = 'delivering')::int`,
      delivered: sql<number>`count(*) filter (where ${priceAlertNotifications.state} = 'delivered')::int`,
      failed: sql<number>`count(*) filter (where ${priceAlertNotifications.state} = 'failed')::int`,
      deadLetter: sql<number>`count(*) filter (where ${priceAlertNotifications.state} = 'dead_letter')::int`,
      suppressedStaleDestination: sql<number>`count(*) filter (where ${priceAlertNotifications.suppressionReason} = 'destination_no_longer_eligible')::int`,
      suppressedOther: sql<number>`count(*) filter (where ${priceAlertNotifications.state} = 'suppressed' and ${priceAlertNotifications.suppressionReason} <> 'destination_no_longer_eligible')::int`,
      opened: sql<number>`count(*) filter (where ${notifications.readAt} is not null)::int`,
    })
    .from(priceAlertNotifications)
    .leftJoin(notifications, eq(notifications.id, priceAlertNotifications.notificationId));
  const row = rows[0];
  return {
    queued: row?.queued ?? 0,
    delivering: row?.delivering ?? 0,
    delivered: row?.delivered ?? 0,
    failed: row?.failed ?? 0,
    deadLetter: row?.deadLetter ?? 0,
    suppressedStaleDestination: row?.suppressedStaleDestination ?? 0,
    suppressedOther: row?.suppressedOther ?? 0,
    opened: row?.opened ?? 0,
  };
}
