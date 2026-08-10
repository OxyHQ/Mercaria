/**
 * Reads and writes on `guest_order_claim_outbox` (#109).
 *
 * The moderation-outbox repository, ported for the third time in this codebase
 * and deliberately unchanged where it matters: a DETERMINISTIC caller-supplied
 * id with `ON CONFLICT DO NOTHING` so a repeat is a genuine no-op, and claims
 * that are LEASES taken with `FOR UPDATE SKIP LOCKED` and released with an
 * OWNER check — so N ECS tasks drain the queue without handing each other the
 * same row, and a dead task's expired lease is reclaimable.
 *
 * The row holds no contact, no credential and no order detail. It names a claim
 * and a kind of work, and every handler reads what it needs from the tables
 * that own it — so a queue that backs up is a list of things Mercaria owes, not
 * a copy of anybody's purchase.
 */

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { GuestClaimOutboxType } from '@mercaria/shared-types';
import { guestOrderClaimOutbox } from '../schema/guestClaims.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_order_claim_outbox` row as the backend reads it. */
export type GuestClaimOutboxRow = typeof guestOrderClaimOutbox.$inferSelect;

/**
 * The deterministic id of one follow-up job.
 *
 * `guest-claim:<type>:<claimId>` — the payment outbox's shape. A claim id is
 * already unique per claim, so a retried claim transaction, a replay and two
 * racing requests all collide on the primary key rather than queueing the work
 * twice. There is deliberately no caller-supplied suffix: unlike a transactional
 * message, there is no legitimate reason to want a SECOND eligibility grant for
 * one claim, and an operator repair is the existing idempotent path re-run.
 */
export function guestClaimOutboxId(type: GuestClaimOutboxType, claimId: string): string {
  return `guest-claim:${type}:${claimId}`;
}

/**
 * Enqueue one job, or converge on the one already queued.
 *
 * `ON CONFLICT DO NOTHING` and NOT `DO UPDATE`, for the reason the moderation
 * outbox states and its realdb test pins: a repeat writes nothing at all — no
 * tuple version, no timestamp, no lock — because drizzle applies a column's
 * `$onUpdate` to a conflict branch's `set`, so "write the same values back" is
 * not even a quiet write.
 *
 * Takes a transaction handle from the claim, so the work is owed by exactly the
 * transaction that created the obligation.
 */
export async function enqueueGuestClaimJob(
  db: DatabaseOrTransaction,
  input: {
    claimId: string;
    checkoutGroupId: string;
    type: GuestClaimOutboxType;
    availableAt: Date;
    expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await db
    .insert(guestOrderClaimOutbox)
    .values({
      id: guestClaimOutboxId(input.type, input.claimId),
      claimId: input.claimId,
      checkoutGroupId: input.checkoutGroupId,
      type: input.type,
      availableAt: input.availableAt,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: guestOrderClaimOutbox.id })
    .returning({ id: guestOrderClaimOutbox.id });
  return rows.length > 0;
}

/**
 * Claim up to `limit` jobs for this worker — a LEASE, not a delete.
 *
 * Two branches: due `pending` work, and `processing` work whose lease expired
 * (a dead task's, being reclaimed). Each has its own partial index so neither
 * scans the other's rows. `FOR UPDATE SKIP LOCKED` inside one statement is what
 * makes concurrent dispatchers safe without a distributed lock.
 */
export async function claimGuestClaimJobs(
  db: DatabaseOrTransaction,
  input: { owner: string; now: Date; leaseUntil: Date; limit: number },
): Promise<GuestClaimOutboxRow[]> {
  const claimable = db
    .select({ id: guestOrderClaimOutbox.id })
    .from(guestOrderClaimOutbox)
    .where(
      or(
        and(
          eq(guestOrderClaimOutbox.state, 'pending'),
          lt(guestOrderClaimOutbox.availableAt, input.now),
        ),
        and(
          eq(guestOrderClaimOutbox.state, 'processing'),
          lt(guestOrderClaimOutbox.leaseUntil, input.now),
        ),
      ),
    )
    .orderBy(asc(guestOrderClaimOutbox.createdAt))
    .limit(input.limit)
    .for('update', { skipLocked: true });

  return await db
    .update(guestOrderClaimOutbox)
    .set({ state: 'processing', leaseOwner: input.owner, leaseUntil: input.leaseUntil })
    .where(sql`${guestOrderClaimOutbox.id} in (${claimable})`)
    .returning();
}

/**
 * Mark a claimed job done. Guarded on the LEASE OWNER, so a task whose lease
 * expired and was reclaimed cannot report work the new owner is still doing.
 */
export async function markGuestClaimJobCompleted(
  db: DatabaseOrTransaction,
  input: { id: string; owner: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(guestOrderClaimOutbox)
    .set({
      state: 'completed',
      completedAt: input.now,
      leaseOwner: null,
      leaseUntil: null,
      attempts: sql`${guestOrderClaimOutbox.attempts} + 1`,
      lastError: null,
    })
    .where(
      and(
        eq(guestOrderClaimOutbox.id, input.id),
        eq(guestOrderClaimOutbox.leaseOwner, input.owner),
      ),
    )
    .returning({ id: guestOrderClaimOutbox.id });
  return rows.length > 0;
}

/**
 * Record a failed attempt and the row's next state.
 *
 * The CALLER decides `nextState` and `availableAt`, the `guest_portal_messages`
 * split: "is this retryable, and how long until the next try" is backoff policy
 * and belongs beside the handler that knows what failed, not in SQL.
 */
export async function markGuestClaimJobFailed(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    owner: string;
    error: string;
    nextState: 'pending' | 'failed' | 'dead_letter';
    availableAt: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(guestOrderClaimOutbox)
    .set({
      state: input.nextState,
      lastError: input.error,
      attempts: sql`${guestOrderClaimOutbox.attempts} + 1`,
      availableAt: input.availableAt,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(guestOrderClaimOutbox.id, input.id),
        eq(guestOrderClaimOutbox.leaseOwner, input.owner),
      ),
    )
    .returning({ id: guestOrderClaimOutbox.id });
  return rows.length > 0;
}

/** Every job owed by one checkout group's claims, newest first — the trace. */
export async function listGuestClaimJobsForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  limit: number,
): Promise<GuestClaimOutboxRow[]> {
  return await db
    .select()
    .from(guestOrderClaimOutbox)
    .where(eq(guestOrderClaimOutbox.checkoutGroupId, checkoutGroupId))
    .orderBy(desc(guestOrderClaimOutbox.createdAt))
    .limit(limit);
}

/** The jobs owed by a specific set of claims — the post-commit inline drain. */
export async function findGuestClaimJobsByClaimIds(
  db: DatabaseOrTransaction,
  claimIds: readonly string[],
): Promise<GuestClaimOutboxRow[]> {
  if (claimIds.length === 0) return [];
  return await db
    .select()
    .from(guestOrderClaimOutbox)
    .where(inArray(guestOrderClaimOutbox.claimId, [...claimIds]));
}
