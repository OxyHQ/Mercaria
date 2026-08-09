/**
 * Reads and writes on `guest_portal_messages` (#108).
 *
 * The moderation-outbox repository, ported: a deterministic caller-supplied id,
 * `ON CONFLICT DO NOTHING` so a repeat is a genuine no-op, and claims that are
 * LEASES taken with `FOR UPDATE SKIP LOCKED` and released with an owner check —
 * so N ECS tasks drain the queue without handing each other the same row, and a
 * dead task's expired lease is reclaimable.
 *
 * The row never holds a recipient address: the send path reads
 * `guest_checkouts` at the moment of sending. So a queue that backs up is a
 * list of things Mercaria owes, not a mailing list.
 */

import { and, eq, lt, or, sql } from 'drizzle-orm';
import type {
  GuestPortalDeliveryFailure,
  GuestPortalMessageKind,
} from '@mercaria/shared-types';
import { guestPortalMessages } from '../schema/guestPortal.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_portal_messages` row as the backend reads it. */
export type GuestPortalMessageRow = typeof guestPortalMessages.$inferSelect;

/** What an enqueue writes. The id is the caller's, deliberately. */
export interface EnqueueGuestPortalMessageInput {
  /** DETERMINISTIC — `guest-msg:<kind>:<dedupeKey>`. See {@link guestPortalMessageId}. */
  id: string;
  checkoutGroupId: string;
  guestCheckoutId: string;
  kind: GuestPortalMessageKind;
  /** Which sibling order this is about; absent for group-level messages. */
  orderId?: string;
  /** Snapshotted from the checkout, so a later checkout cannot retranslate this one. */
  locale?: string;
  availableAt: Date;
  expiresAt: Date;
}

/**
 * The deterministic id of a message.
 *
 * `guest-msg:<kind>:<dedupeKey>` — the payment outbox's shape. The dedupe key
 * is the checkout group for group-level messages and the order for per-order
 * ones, so a redelivered webhook, a reconciliation sweep re-deriving the same
 * fact and two tasks racing all collide on the primary key. That collision IS
 * #108 initial-confirmation rule 7: "duplicate payment webhooks converge on one
 * initial message".
 *
 * A caller wanting a deliberate SECOND message of a kind (an operator re-send)
 * passes a distinguishing suffix, which is an explicit act rather than a
 * duplicate slipping through — see `operator.service.ts`.
 */
export function guestPortalMessageId(kind: GuestPortalMessageKind, dedupeKey: string): string {
  return `guest-msg:${kind}:${dedupeKey}`;
}

/**
 * Enqueue a message, or converge on the one already queued.
 *
 * `ON CONFLICT DO NOTHING` and NOT `DO UPDATE`: a repeat writes nothing at all
 * — no tuple version, no timestamp, no lock — for a STRUCTURAL reason rather
 * than by matching a spelling. drizzle applies a column's `$onUpdate` to a
 * conflict branch's `set`, so "write the same values back" is not even a quiet
 * write, and the realdb test asserts both `updated_at` and `xmin` are
 * unchanged.
 *
 * Returns whether a row was CREATED. The caller logs that rather than the
 * message's existence, because "enqueued" and "already owed" are different
 * facts and an operator reading a trace needs to tell them apart.
 */
export async function enqueueGuestPortalMessage(
  db: DatabaseOrTransaction,
  input: EnqueueGuestPortalMessageInput,
): Promise<boolean> {
  const rows = await db
    .insert(guestPortalMessages)
    .values({
      id: input.id,
      checkoutGroupId: input.checkoutGroupId,
      guestCheckoutId: input.guestCheckoutId,
      kind: input.kind,
      orderId: input.orderId ?? null,
      locale: input.locale ?? null,
      availableAt: input.availableAt,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: guestPortalMessages.id })
    .returning({ id: guestPortalMessages.id });
  return rows.length > 0;
}

/**
 * Claim up to `limit` messages for this worker — a LEASE, not a delete.
 *
 * Two branches, exactly as the moderation outbox: due `pending` work, and
 * `sending` work whose lease expired (a dead task's, being reclaimed). Each has
 * its own partial index so neither scans the other's rows.
 *
 * `FOR UPDATE SKIP LOCKED` inside a single statement is what makes concurrent
 * dispatchers safe without a distributed lock — a row another task is claiming
 * is skipped rather than waited on, so a slow claim never becomes a queue-wide
 * stall.
 */
export async function claimGuestPortalMessages(
  db: DatabaseOrTransaction,
  input: { owner: string; now: Date; leaseUntil: Date; limit: number },
): Promise<GuestPortalMessageRow[]> {
  const claimable = db
    .select({ id: guestPortalMessages.id })
    .from(guestPortalMessages)
    .where(
      or(
        and(eq(guestPortalMessages.state, 'pending'), lt(guestPortalMessages.availableAt, input.now)),
        and(eq(guestPortalMessages.state, 'sending'), lt(guestPortalMessages.leaseUntil, input.now)),
      ),
    )
    .orderBy(guestPortalMessages.createdAt)
    .limit(input.limit)
    .for('update', { skipLocked: true });

  return await db
    .update(guestPortalMessages)
    .set({ state: 'sending', leaseOwner: input.owner, leaseUntil: input.leaseUntil })
    .where(sql`${guestPortalMessages.id} in (${claimable})`)
    .returning();
}

/**
 * Mark a claimed message sent. Guarded on the LEASE OWNER, so a task whose
 * lease expired and was reclaimed cannot report a delivery the new owner is
 * still performing.
 */
export async function markGuestPortalMessageSent(
  db: DatabaseOrTransaction,
  input: { id: string; owner: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(guestPortalMessages)
    .set({
      state: 'sent',
      sentAt: input.now,
      leaseOwner: null,
      leaseUntil: null,
      attempts: sql`${guestPortalMessages.attempts} + 1`,
      lastFailure: null,
    })
    .where(
      and(eq(guestPortalMessages.id, input.id), eq(guestPortalMessages.leaseOwner, input.owner)),
    )
    .returning({ id: guestPortalMessages.id });
  return rows.length > 0;
}

/**
 * Record a failed attempt and decide the row's next state.
 *
 * The CALLER decides `nextState` and `availableAt`, because "is this
 * retryable" is a property of the failure code and lives beside the code's
 * definition (`GUEST_PORTAL_PERMANENT_FAILURES`), not in SQL. The owner guard is
 * the same as above and for the same reason.
 */
export async function markGuestPortalMessageFailed(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    owner: string;
    failure: GuestPortalDeliveryFailure;
    nextState: 'pending' | 'failed' | 'dead_letter' | 'suppressed';
    availableAt: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(guestPortalMessages)
    .set({
      state: input.nextState,
      lastFailure: input.failure,
      attempts: sql`${guestPortalMessages.attempts} + 1`,
      availableAt: input.availableAt,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(
      and(eq(guestPortalMessages.id, input.id), eq(guestPortalMessages.leaseOwner, input.owner)),
    )
    .returning({ id: guestPortalMessages.id });
  return rows.length > 0;
}

/**
 * Every message a checkout group has been sent, newest first — the operator
 * trace. Names its columns; there is no recipient column to omit.
 */
export async function listGuestPortalMessagesForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  limit: number,
): Promise<
  Pick<
    GuestPortalMessageRow,
    'id' | 'kind' | 'state' | 'attempts' | 'lastFailure' | 'createdAt' | 'sentAt'
  >[]
> {
  return await db
    .select({
      id: guestPortalMessages.id,
      kind: guestPortalMessages.kind,
      state: guestPortalMessages.state,
      attempts: guestPortalMessages.attempts,
      lastFailure: guestPortalMessages.lastFailure,
      createdAt: guestPortalMessages.createdAt,
      sentAt: guestPortalMessages.sentAt,
    })
    .from(guestPortalMessages)
    .where(eq(guestPortalMessages.checkoutGroupId, checkoutGroupId))
    .orderBy(sql`${guestPortalMessages.createdAt} desc`)
    .limit(limit);
}
