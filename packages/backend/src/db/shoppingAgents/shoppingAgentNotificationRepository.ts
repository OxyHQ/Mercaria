/**
 * `shopping_agent_notifications` — the durable DELIVERY job (#97 evaluation 1,
 * notification 9).
 *
 * The moderation outbox, ported by way of #79: a DETERMINISTIC id so a repeat
 * converges, the row IS the job, claims are leases with an owner check, capped
 * exponential backoff, and a VISIBLE `dead_letter`. Three things are worth
 * reading before touching this file.
 *
 * ## The id is `sha256(findingId + ':' + channel)`
 *
 * Derived from the two facts that decide identity and from nothing else — no
 * clock, no attempt counter, no evaluation run. A second enqueue for one finding
 * on one channel therefore collides with the first and `DO NOTHING` writes
 * nothing at all: not a tuple version, not a timestamp, not a lock, on a row a
 * dispatcher may be holding. That structural no-op is what makes an enqueue safe
 * to re-run, and it is the property `moderation-writes.realdb.test.ts` pins with
 * an `xmin` assertion one domain over.
 *
 * ## A WITHHELD notification leaves a ROW
 *
 * Not a delete and not a skip, and there are two ways it happens, which is why
 * there are two functions. {@link recordShoppingAgentNotificationSuppressed}
 * records a decision taken BEFORE anything was queued — the cooldown had not
 * elapsed, the improvement was not material, the agent had been paused — and
 * {@link markShoppingAgentNotificationSuppressed} records one taken by the
 * dispatcher holding a lease. Both are terminal and both carry a coded reason,
 * because #97 cost rule 6 asks that duplicate suppression be MONITORED and a
 * table of messages that were sent can never answer how many were withheld.
 *
 * ## `opened` is not a state here
 *
 * `notification_id` names the `notifications` row a delivery produced, and
 * `notifications.read_at` is the one place "they read it" is stored. A second
 * representation of that fact could disagree with Oxy's own feed.
 */

import { and, asc, desc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type {
  ShoppingAgentDeliveryFailure,
  ShoppingAgentNotificationChannel,
  ShoppingAgentSuppressionReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { shoppingAgentNotifications } from '../schema/shoppingAgents.js';

export type ShoppingAgentNotificationRow = typeof shoppingAgentNotifications.$inferSelect;

/**
 * The row's id, derived from the finding and the channel.
 *
 * Hex sha-256 rather than the two values joined by a separator, so the id carries
 * no readable finding id and cannot be used to enumerate one; the domain's own
 * lookups all go through the indexed `finding_id` column.
 */
export function shoppingAgentNotificationId(
  findingId: string,
  channel: ShoppingAgentNotificationChannel,
): string {
  return createHash('sha256').update(`${findingId}:${channel}`).digest('hex');
}

/**
 * Queue one delivery. Idempotent by PRIMARY KEY.
 *
 * Runs in the caller's transaction, which is the same transaction the finding was
 * written in: a qualifying finding with no queued notification is good news that
 * reached nobody, and the delivery's whole point is that it survives
 * independently once it exists.
 *
 * @returns the id, so a caller can trace the row it just queued without reading
 * it back.
 */
export async function enqueueShoppingAgentNotification(
  input: {
    readonly findingId: string;
    readonly agentId: string;
    readonly channel: ShoppingAgentNotificationChannel;
    readonly availableAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  const id = shoppingAgentNotificationId(input.findingId, input.channel);
  await db
    .insert(shoppingAgentNotifications)
    .values({
      id,
      findingId: input.findingId,
      agentId: input.agentId,
      channel: input.channel,
      state: 'queued',
      attempts: 0,
      availableAt: input.availableAt,
    })
    .onConflictDoNothing();
  return id;
}

/**
 * Record that a notification was WITHHELD before it was ever queued.
 *
 * This is how a cooldown, an unimproved amount or a paused agent becomes
 * COUNTABLE. The alternative — returning early and writing nothing — is
 * indistinguishable at every later moment from an evaluation that never
 * qualified, and #97 cost rule 6 asks for exactly this number.
 *
 * The id is the SAME deterministic one an enqueue would have used and the insert
 * is `DO NOTHING`, so a decision taken twice converges and a decision taken after
 * something was already queued writes nothing — the queued row is a live job, and
 * overwriting it from outside the dispatcher would discard a delivery in flight.
 * A dispatcher that then finds the agent ineligible records its own suppression
 * through {@link markShoppingAgentNotificationSuppressed}.
 *
 * @returns whether this call wrote the row.
 */
export async function recordShoppingAgentNotificationSuppressed(
  input: {
    readonly findingId: string;
    readonly agentId: string;
    readonly channel: ShoppingAgentNotificationChannel;
    readonly reason: ShoppingAgentSuppressionReason;
    readonly now: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(shoppingAgentNotifications)
    .values({
      id: shoppingAgentNotificationId(input.findingId, input.channel),
      findingId: input.findingId,
      agentId: input.agentId,
      channel: input.channel,
      state: 'suppressed',
      suppressionReason: input.reason,
      attempts: 0,
      availableAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: shoppingAgentNotifications.id });
  return rows.length === 1;
}

/** Atomically claim due deliveries. `FOR UPDATE SKIP LOCKED`, owner-checked. */
export async function claimShoppingAgentNotifications(
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentNotificationRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(
      eq(shoppingAgentNotifications.state, 'queued'),
      lte(shoppingAgentNotifications.availableAt, now),
    ),
    and(
      eq(shoppingAgentNotifications.state, 'failed'),
      lte(shoppingAgentNotifications.availableAt, now),
    ),
    and(
      eq(shoppingAgentNotifications.state, 'delivering'),
      lte(shoppingAgentNotifications.leaseUntil, now),
    ),
  );

  return db
    .update(shoppingAgentNotifications)
    .set({
      state: 'delivering',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${shoppingAgentNotifications.attempts} + 1`,
    })
    .where(
      sql`${shoppingAgentNotifications.id} in (
        select ${shoppingAgentNotifications.id} from ${shoppingAgentNotifications}
        where ${due}
        order by ${asc(shoppingAgentNotifications.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** Only the lease this worker currently owns matches. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(shoppingAgentNotifications.id, id),
    eq(shoppingAgentNotifications.state, 'delivering'),
    eq(shoppingAgentNotifications.leaseOwner, leaseOwner),
    gt(shoppingAgentNotifications.leaseUntil, now),
  );
}

/**
 * It reached the shopper. `notificationId` is what answers `openedAt` later.
 *
 * OPTIONAL, and the absence is a real case rather than laziness: the `email`
 * channel produces no `notifications` row, so there is nothing to link and
 * `openedAt` is permanently unanswerable for one — which is honest, because an
 * email open is a tracking pixel and this domain does not have one. Writing a
 * placeholder id would violate the foreign key, which is the constraint doing
 * exactly its job.
 */
export async function markShoppingAgentNotificationDelivered(
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
    .update(shoppingAgentNotifications)
    .set({
      state: 'delivered',
      deliveredAt: now,
      notificationId: input.notificationId ?? null,
      leaseOwner: null,
      leaseUntil: null,
      failureReason: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentNotifications.id });
  return rows.length === 1;
}

/**
 * The dispatcher withheld it, and this row is the measurement.
 *
 * Terminal: a destination that stopped being eligible does not become eligible
 * again for THIS finding, and a deleted agent does not come back. A later
 * qualifying observation produces a new finding and a new delivery.
 */
export async function markShoppingAgentNotificationSuppressed(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly reason: ShoppingAgentSuppressionReason;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(shoppingAgentNotifications)
    .set({
      state: 'suppressed',
      suppressionReason: input.reason,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentNotifications.id });
  return rows.length === 1;
}

/**
 * Release a claim with backoff — or stop, visibly.
 *
 * `deadLettered` is the CALLER's decision. An `email` delivery on a deployment
 * with no transport registered will reach it every time, which is exactly the
 * intended shape: the row states `transport_unconfigured` and an operator can
 * count them, rather than the feature silently doing nothing.
 *
 * `failure: null` is a DEFER rather than a failure — quiet hours, and nothing
 * else today. The distinction is not cosmetic: a deferred notification has not
 * gone wrong, and recording a failure reason for one would put every shopper
 * who sleeps into the operator surface's failure count.
 */
export async function releaseShoppingAgentNotification(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly deadLettered: boolean;
    readonly availableAt: Date;
    readonly failure: ShoppingAgentDeliveryFailure | null;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(shoppingAgentNotifications)
    .set({
      state: input.deadLettered ? 'dead_letter' : input.failure === null ? 'queued' : 'failed',
      availableAt: input.availableAt,
      failureReason: input.failure,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentNotifications.id });
  return rows.length === 1;
}

/** Every delivery for one finding — what a client is shown, and the trace's read. */
export async function listShoppingAgentNotifications(
  findingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentNotificationRow[]> {
  return db
    .select()
    .from(shoppingAgentNotifications)
    .where(eq(shoppingAgentNotifications.findingId, findingId))
    .orderBy(asc(shoppingAgentNotifications.channel), desc(shoppingAgentNotifications.createdAt));
}

/**
 * Delivery health and the withheld count, broken out BY REASON.
 *
 * The breakdown is the point: `destination_no_longer_eligible` is a stale-link
 * measurement about the catalogue, `cooldown_active` and `not_materially_better`
 * are the notification policy working as designed, and `agent_deleted` is
 * somebody having moved on. A single "suppressed" total would hide the one number
 * an operator is being asked to watch inside three that need no attention at all.
 */
export async function readShoppingAgentNotificationSummary(
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  queued: number;
  delivering: number;
  delivered: number;
  failed: number;
  deadLetter: number;
  suppressed: number;
  suppressedCooldownActive: number;
  suppressedNotMateriallyBetter: number;
  suppressedAgentNotEnabled: number;
  suppressedAgentDeleted: number;
  suppressedFindingSuperseded: number;
  suppressedDestinationNoLongerEligible: number;
  suppressedChannelUnavailable: number;
}> {
  const rows = await db
    .select({
      queued: sql<number>`count(*) filter (where ${shoppingAgentNotifications.state} = 'queued')::int`,
      delivering: sql<number>`count(*) filter (where ${shoppingAgentNotifications.state} = 'delivering')::int`,
      delivered: sql<number>`count(*) filter (where ${shoppingAgentNotifications.state} = 'delivered')::int`,
      failed: sql<number>`count(*) filter (where ${shoppingAgentNotifications.state} = 'failed')::int`,
      deadLetter: sql<number>`count(*) filter (where ${shoppingAgentNotifications.state} = 'dead_letter')::int`,
      suppressed: sql<number>`count(*) filter (where ${shoppingAgentNotifications.state} = 'suppressed')::int`,
      suppressedCooldownActive: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'cooldown_active')::int`,
      suppressedNotMateriallyBetter: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'not_materially_better')::int`,
      suppressedAgentNotEnabled: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'agent_not_enabled')::int`,
      suppressedAgentDeleted: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'agent_deleted')::int`,
      suppressedFindingSuperseded: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'finding_superseded')::int`,
      suppressedDestinationNoLongerEligible: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'destination_no_longer_eligible')::int`,
      suppressedChannelUnavailable: sql<number>`count(*) filter (where ${shoppingAgentNotifications.suppressionReason} = 'channel_unavailable')::int`,
    })
    .from(shoppingAgentNotifications);
  const row = rows[0];
  return {
    queued: row?.queued ?? 0,
    delivering: row?.delivering ?? 0,
    delivered: row?.delivered ?? 0,
    failed: row?.failed ?? 0,
    deadLetter: row?.deadLetter ?? 0,
    suppressed: row?.suppressed ?? 0,
    suppressedCooldownActive: row?.suppressedCooldownActive ?? 0,
    suppressedNotMateriallyBetter: row?.suppressedNotMateriallyBetter ?? 0,
    suppressedAgentNotEnabled: row?.suppressedAgentNotEnabled ?? 0,
    suppressedAgentDeleted: row?.suppressedAgentDeleted ?? 0,
    suppressedFindingSuperseded: row?.suppressedFindingSuperseded ?? 0,
    suppressedDestinationNoLongerEligible: row?.suppressedDestinationNoLongerEligible ?? 0,
    suppressedChannelUnavailable: row?.suppressedChannelUnavailable ?? 0,
  };
}
