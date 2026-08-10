/**
 * `cancellation_requests` and its lines (#110).
 *
 * ## Every read goes through `publicColumns`
 *
 * `requested_by_grant_id` and `requested_by_oxy_user_id` are registered in
 * `db/protectedColumns.ts`, so the row type below has no such property and a
 * serializer reaching for one fails `tsc`. The service never needs either: it
 * WRITES them for the audit and authorizes from the ORDER, through #106's
 * `authorizeOrderAccess`, which is the only place that decides anything.
 *
 * ## Convergence, not conflict
 *
 * `submitCancellationRequest` is an `ON CONFLICT DO NOTHING` against TWO partial
 * uniques and a read-back, so a double tap, a retried POST and two concurrent
 * submissions all end on one row — acceptance 4. The empty-versus-one-row
 * `RETURNING` set IS the "somebody got there first" answer, the moderation
 * dedupe-claim shape, so a genuine failure still propagates instead of being
 * read as a duplicate.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  BuyerRequestActorKind,
  BuyerRequestCompletionFailure,
  CancellationCompletionMode,
  CancellationRequestReason,
  CancellationRequestState,
} from '@mercaria/shared-types';
import { OPEN_CANCELLATION_REQUEST_STATES } from '@mercaria/shared-types';
import {
  cancellationRequestLines,
  cancellationRequests,
} from '../schema/buyerRequests.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One requested line. */
export interface NewCancellationRequestLine {
  variantId: string;
  requestedQuantity: number;
}

/** Everything an insert states. The state is always `submitted`. */
export interface NewCancellationRequest {
  orderId: string;
  reason: CancellationRequestReason;
  note?: string;
  completionMode: CancellationCompletionMode;
  wholeOrder: boolean;
  requestedByActorKind: BuyerRequestActorKind;
  requestedByOxyUserId?: string;
  requestedByGrantId?: string;
  idempotencyKey?: string;
  lines: NewCancellationRequestLine[];
}

/** A stored request, without the two protected requester columns. */
export type CancellationRequestRow = NonNullable<
  Awaited<ReturnType<typeof findCancellationRequestById>>
>;

/** A stored line. */
export interface CancellationRequestLineRow {
  id: string;
  requestId: string;
  variantId: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
}

const publicRequest = () => publicColumns(cancellationRequests, PROTECTED_COLUMNS);

/**
 * Insert a request and its lines, converging on an existing one.
 *
 * Returns `null` when a live request or the same idempotency key already
 * claimed the order — the caller then READS, rather than being handed somebody
 * else's row from inside a write it did not perform.
 */
export async function insertCancellationRequest(
  tx: DatabaseOrTransaction,
  input: NewCancellationRequest,
): Promise<{ id: string } | null> {
  const [created] = await tx
    .insert(cancellationRequests)
    .values({
      orderId: input.orderId,
      state: 'submitted',
      reason: input.reason,
      ...(input.note === undefined ? {} : { note: input.note }),
      completionMode: input.completionMode,
      wholeOrder: input.wholeOrder,
      requestedByActorKind: input.requestedByActorKind,
      ...(input.requestedByOxyUserId === undefined
        ? {}
        : { requestedByOxyUserId: input.requestedByOxyUserId }),
      ...(input.requestedByGrantId === undefined
        ? {}
        : { requestedByGrantId: input.requestedByGrantId }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    })
    .onConflictDoNothing()
    .returning({ id: cancellationRequests.id });
  if (!created) return null;

  if (input.lines.length > 0) {
    await tx.insert(cancellationRequestLines).values(
      input.lines.map((line) => ({
        requestId: created.id,
        variantId: line.variantId,
        requestedQuantity: line.requestedQuantity,
      })),
    );
  }
  return created;
}

/** One request by id, or `undefined`. */
export async function findCancellationRequestById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
) {
  const [row] = await db.select(publicRequest()).from(cancellationRequests).where(eq(cancellationRequests.id, id)).limit(1);
  return row;
}

/**
 * The LIVE request for an order, if there is one.
 *
 * Reads the same state set the partial unique index enforces, from the same
 * tuple, so "the database says there can be only one" and "the service found
 * the one" cannot disagree.
 */
export async function findOpenCancellationRequestForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
) {
  const [row] = await db
    .select(publicRequest())
    .from(cancellationRequests)
    .where(
      and(
        eq(cancellationRequests.orderId, orderId),
        inArray(cancellationRequests.state, [...OPEN_CANCELLATION_REQUEST_STATES]),
      ),
    )
    .limit(1);
  return row;
}

/** One request by idempotency key — the converge path for a retried call. */
export async function findCancellationRequestByIdempotencyKey(
  key: string,
  db: DatabaseOrTransaction = getDb(),
) {
  const [row] = await db
    .select(publicRequest())
    .from(cancellationRequests)
    .where(eq(cancellationRequests.idempotencyKey, key))
    .limit(1);
  return row;
}

/** Every request filed against one order, newest first. */
export async function listCancellationRequestsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
) {
  return db
    .select(publicRequest())
    .from(cancellationRequests)
    .where(eq(cancellationRequests.orderId, orderId))
    .orderBy(desc(cancellationRequests.createdAt));
}

/** One request's lines, in variant order. */
export async function listCancellationRequestLines(
  requestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CancellationRequestLineRow[]> {
  return db
    .select({
      id: cancellationRequestLines.id,
      requestId: cancellationRequestLines.requestId,
      variantId: cancellationRequestLines.variantId,
      requestedQuantity: cancellationRequestLines.requestedQuantity,
      approvedQuantity: cancellationRequestLines.approvedQuantity,
    })
    .from(cancellationRequestLines)
    .where(eq(cancellationRequestLines.requestId, requestId))
    .orderBy(cancellationRequestLines.variantId);
}

/** Set the agreed quantity on one line. */
export async function setCancellationLineApproved(
  tx: DatabaseOrTransaction,
  requestId: string,
  variantId: string,
  approvedQuantity: number,
): Promise<void> {
  await tx
    .update(cancellationRequestLines)
    .set({ approvedQuantity })
    .where(
      and(
        eq(cancellationRequestLines.requestId, requestId),
        eq(cancellationRequestLines.variantId, variantId),
      ),
    );
}

/**
 * Move a request from one state to another, atomically.
 *
 * A compare-and-swap on the CURRENT state, exactly as `order.service.transition`
 * is: the empty-versus-one-row result is what tells a second decider that
 * somebody already answered, so two sellers clicking accept and reject at once
 * produce one decision rather than two half-applied ones. Every caller here
 * treats `null` as a conflict and says so.
 */
export async function transitionCancellationRequest(
  tx: DatabaseOrTransaction,
  input: {
    id: string;
    from: CancellationRequestState;
    to: CancellationRequestState;
    decidedByActorKind?: BuyerRequestActorKind;
    decidedByOxyUserId?: string;
    decidedAt?: Date;
    decisionNote?: string;
    completedAt?: Date;
    refundId?: string;
    /** Explicitly `null` clears a previously recorded failure on a retry. */
    completionFailure?: BuyerRequestCompletionFailure | null;
  },
): Promise<{ id: string } | null> {
  const [row] = await tx
    .update(cancellationRequests)
    .set({
      state: input.to,
      ...(input.decidedByActorKind === undefined
        ? {}
        : { decidedByActorKind: input.decidedByActorKind }),
      ...(input.decidedByOxyUserId === undefined
        ? {}
        : { decidedByOxyUserId: input.decidedByOxyUserId }),
      ...(input.decidedAt === undefined ? {} : { decidedAt: input.decidedAt }),
      ...(input.decisionNote === undefined ? {} : { decisionNote: input.decisionNote }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.refundId === undefined ? {} : { refundId: input.refundId }),
      ...(input.completionFailure === undefined
        ? {}
        : { completionFailure: input.completionFailure }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(cancellationRequests.id, input.id), eq(cancellationRequests.state, input.from)))
    .returning({ id: cancellationRequests.id });
  return row ?? null;
}

/**
 * Record a completion failure WITHOUT moving the request.
 *
 * Separate from the transition above because it is the one write that leaves
 * the state alone: an accepted request whose completion failed is still
 * accepted, still owed, and retried by the same idempotent call. Folding it
 * into a transition would need a `from` equal to `to`, which reads as a no-op
 * and hides that the row changed.
 */
export async function recordCancellationCompletionFailure(
  tx: DatabaseOrTransaction,
  id: string,
  failure: BuyerRequestCompletionFailure,
): Promise<void> {
  await tx
    .update(cancellationRequests)
    .set({ completionFailure: failure, updatedAt: sql`now()` })
    .where(and(eq(cancellationRequests.id, id), eq(cancellationRequests.state, 'accepted')));
}

/** The merchant queue: open requests for a set of orders, oldest first. */
export async function listOpenCancellationRequestsForOrders(
  orderIds: string[],
  db: DatabaseOrTransaction = getDb(),
) {
  if (orderIds.length === 0) return [];
  return db
    .select(publicRequest())
    .from(cancellationRequests)
    .where(
      and(
        inArray(cancellationRequests.orderId, orderIds),
        inArray(cancellationRequests.state, [...OPEN_CANCELLATION_REQUEST_STATES]),
      ),
    )
    .orderBy(cancellationRequests.createdAt);
}
