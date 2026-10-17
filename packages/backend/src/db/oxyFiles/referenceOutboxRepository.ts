/**
 * `oxy_file_reference_outboxes` — the durable request that an entity's Oxy file
 * references be brought back into agreement with what the entity holds.
 *
 * There is deliberately no TypeScript enqueue. The only writer of a new request
 * is `mercaria_oxy_file_reference_enqueue`, called by the triggers of migration
 * `0172` on every table that holds a file id, inside the writer's own
 * transaction (`db/schema/oxyFiles.ts` says why a trigger, not an `enqueue*`).
 * {@link requestFileReferenceConvergence} calls that same function for the two
 * paths no trigger sees (a re-drive by an operator, a test) and is therefore an
 * enqueue in the house sense: its handle is REQUIRED.
 *
 * The claim/complete/release half is the offer outbox's, with one difference:
 * a converged job is DELETED rather than marked `done`. One row per entity ever
 * touched would be one row per listing, store, review and canonical image —
 * forever — for a fact (`oxy_file_references`) that is already stored.
 */

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { OxyFileReferenceEntityType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH,
  oxyFileReferenceOutboxes,
} from '../schema/oxyFiles.js';

export type OxyFileReferenceOutboxRow = typeof oxyFileReferenceOutboxes.$inferSelect;

/**
 * Ask for an entity's references to be converged — exactly what the triggers
 * do, through the same SQL function, so there is one enqueue and not two.
 */
export async function requestFileReferenceConvergence(
  entityType: OxyFileReferenceEntityType,
  entityId: string,
  db: DatabaseOrTransaction,
): Promise<void> {
  await db.execute(sql`select mercaria_oxy_file_reference_enqueue(${entityType}, ${entityId})`);
}

/**
 * Atomically claim due jobs: `pending` and due, or `processing` with an expired
 * lease (a dead task's). `FOR UPDATE SKIP LOCKED` inside the `UPDATE`, so N
 * tasks drain one queue without handing each other a row or blocking.
 */
export async function claimFileReferenceOutbox(
  options: {
    leaseOwner: string;
    batchSize: number;
    leaseMs?: number;
    now?: Date;
    /**
     * Claim only these entities — the moderation claim's `eventId` option, for
     * an operator re-drive and for a test on the SHARED database, which must
     * never drain rows another file's writes enqueued.
     */
    only?: { entityType: OxyFileReferenceEntityType; entityIds: readonly string[] };
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<OxyFileReferenceOutboxRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 120_000);
  const batchSize = Math.max(1, options.batchSize);
  const scope = options.only
    ? and(
        eq(oxyFileReferenceOutboxes.entityType, options.only.entityType),
        inArray(oxyFileReferenceOutboxes.entityId, [...options.only.entityIds]),
      )
    : undefined;
  const due = and(
    scope,
    or(
      and(
        eq(oxyFileReferenceOutboxes.status, 'pending'),
        or(
          // Never attempted since it was (re)requested: due at once, whatever
          // its `available_at` says. The enqueue trigger stamps that with the
          // DATABASE clock (`now()`) while this claim compares against the
          // APPLICATION's; a database clock ahead of the task's would otherwise
          // hold every fresh request back by the skew. Every later
          // `available_at` (a backoff, a deferral, a re-arm) is written by the
          // application and compared here on the same clock.
          and(eq(oxyFileReferenceOutboxes.attempts, 0), isNull(oxyFileReferenceOutboxes.lastError)),
          lte(oxyFileReferenceOutboxes.availableAt, now),
        ),
      ),
      and(
        eq(oxyFileReferenceOutboxes.status, 'processing'),
        lte(oxyFileReferenceOutboxes.leaseUntil, now),
      ),
    ),
  );
  return (
    db
      .update(oxyFileReferenceOutboxes)
      .set({
        status: 'processing',
        leaseOwner: options.leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseMs),
        // The revision this claim answers; completion compares it with whatever
        // `requested_revision` says by then.
        claimedRevision: sql`${oxyFileReferenceOutboxes.requestedRevision}`,
        attempts: sql`${oxyFileReferenceOutboxes.attempts} + 1`,
        lastError: null,
      })
      // Both references name the SAME table, so the subquery's own range entry
      // shadows the outer one — the correlated-subquery hazard does not apply.
      .where(
        sql`${oxyFileReferenceOutboxes.id} in (
        select ${oxyFileReferenceOutboxes.id} from ${oxyFileReferenceOutboxes}
        where ${due}
        order by ${asc(oxyFileReferenceOutboxes.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
      )
      .returning()
  );
}

function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(oxyFileReferenceOutboxes.id, id),
    eq(oxyFileReferenceOutboxes.status, 'processing'),
    eq(oxyFileReferenceOutboxes.leaseOwner, leaseOwner),
    gt(oxyFileReferenceOutboxes.leaseUntil, now),
  );
}

/**
 * Finish a claim: DELETE the row when no newer request arrived during the run,
 * otherwise leave it `pending` for the next drain.
 *
 * Two statements, and the order is what makes them safe: the delete carries the
 * revision equality, so a request that landed after the claim makes it match
 * nothing, and the re-arm that follows still holds the owner check. Neither can
 * act on a row whose lease was reclaimed by another task.
 *
 * @returns `false` when this task no longer owned the lease.
 */
export async function completeFileReferenceOutbox(
  id: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(oxyFileReferenceOutboxes)
    .where(
      and(
        ownedLease(id, leaseOwner, now),
        sql`${oxyFileReferenceOutboxes.requestedRevision} = ${oxyFileReferenceOutboxes.claimedRevision}`,
      ),
    )
    .returning({ id: oxyFileReferenceOutboxes.id });
  if (deleted.length === 1) return true;
  const rearmed = await db
    .update(oxyFileReferenceOutboxes)
    .set({ status: 'pending', availableAt: now, leaseOwner: null, leaseUntil: null })
    .where(ownedLease(id, leaseOwner, now))
    .returning({ id: oxyFileReferenceOutboxes.id });
  return rearmed.length === 1;
}

/**
 * Release a failed claim with backoff — or stop. `deadLettered` is the caller's
 * decision. A dead letter is VISIBLE: the entity keeps whatever references Oxy
 * already holds, and the nightly reconciliation still converges it.
 */
export async function releaseFileReferenceOutbox(
  options: {
    ids: readonly string[];
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (options.ids.length === 0) return 0;
  const now = options.now ?? new Date();
  const released = await db
    .update(oxyFileReferenceOutboxes)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(
      and(
        inArray(oxyFileReferenceOutboxes.id, [...options.ids]),
        eq(oxyFileReferenceOutboxes.status, 'processing'),
        eq(oxyFileReferenceOutboxes.leaseOwner, options.leaseOwner),
        gt(oxyFileReferenceOutboxes.leaseUntil, now),
      ),
    )
    .returning({ id: oxyFileReferenceOutboxes.id });
  return released.length;
}

/** One job by entity, whatever its state. */
export async function findFileReferenceOutbox(
  entityType: OxyFileReferenceEntityType,
  entityId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OxyFileReferenceOutboxRow | undefined> {
  const rows = await db
    .select()
    .from(oxyFileReferenceOutboxes)
    .where(
      and(
        eq(oxyFileReferenceOutboxes.entityType, entityType),
        eq(oxyFileReferenceOutboxes.entityId, entityId),
      ),
    )
    .limit(1);
  return rows[0];
}
