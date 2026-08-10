/**
 * `return_requests`, its lines and its declared evidence (#110).
 *
 * Everything `cancellationRepository.ts`'s docblock says applies here — reads
 * through `publicColumns`, convergence rather than conflict, and a
 * compare-and-swap on the current state so two deciders produce one decision.
 *
 * The one addition is `listReturnRequestsAwaitingRefundSettlement`, which is the
 * range the reconcile sweep walks. It reads the `refund_pending` partial index,
 * so "which returns are waiting on a rail" is an indexed range rather than a
 * scan of every return ever filed — and it is bounded and resumable by
 * `updated_at`, the shape every sweep in this repository already has.
 */

import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  BuyerRequestActorKind,
  BuyerRequestCompletionFailure,
  ReturnEvidenceKind,
  ReturnRequestReason,
  ReturnRequestState,
  ReturnResolution,
} from '@mercaria/shared-types';
import { OPEN_RETURN_REQUEST_STATES } from '@mercaria/shared-types';
import {
  returnRequestEvidence,
  returnRequestLines,
  returnRequests,
} from '../schema/buyerRequests.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One line the buyer wants to send back. */
export interface NewReturnRequestLine {
  variantId: string;
  requestedQuantity: number;
}

/** One declared photograph. A bare Oxy file id — never a URL, never a copy. */
export interface NewReturnEvidence {
  fileId: string;
  kind: ReturnEvidenceKind;
  position: number;
}

/** Everything an insert states. The state is always `requested`. */
export interface NewReturnRequest {
  orderId: string;
  reason: ReturnRequestReason;
  resolution: ReturnResolution;
  note?: string;
  returnWindowEndsAt: Date;
  requestedByActorKind: BuyerRequestActorKind;
  requestedByOxyUserId?: string;
  requestedByGrantId?: string;
  idempotencyKey?: string;
  lines: NewReturnRequestLine[];
  evidence: NewReturnEvidence[];
}

/** A stored line. */
export interface ReturnRequestLineRow {
  id: string;
  requestId: string;
  variantId: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
}

/** A stored evidence reference. */
export interface ReturnEvidenceRow {
  id: string;
  requestId: string;
  fileId: string;
  kind: ReturnEvidenceKind;
  position: number;
}

const publicRequest = () => publicColumns(returnRequests, PROTECTED_COLUMNS);

/** Insert a request, its lines and its evidence, converging on an existing one. */
export async function insertReturnRequest(
  tx: DatabaseOrTransaction,
  input: NewReturnRequest,
): Promise<{ id: string } | null> {
  const [created] = await tx
    .insert(returnRequests)
    .values({
      orderId: input.orderId,
      state: 'requested',
      reason: input.reason,
      resolution: input.resolution,
      ...(input.note === undefined ? {} : { note: input.note }),
      returnWindowEndsAt: input.returnWindowEndsAt,
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
    .returning({ id: returnRequests.id });
  if (!created) return null;

  await tx.insert(returnRequestLines).values(
    input.lines.map((line) => ({
      requestId: created.id,
      variantId: line.variantId,
      requestedQuantity: line.requestedQuantity,
    })),
  );
  if (input.evidence.length > 0) {
    await tx.insert(returnRequestEvidence).values(
      input.evidence.map((item) => ({
        requestId: created.id,
        fileId: item.fileId,
        kind: item.kind,
        position: item.position,
      })),
    );
  }
  return created;
}

/** One request by id, or `undefined`. */
export async function findReturnRequestById(id: string, db: DatabaseOrTransaction = getDb()) {
  const [row] = await db
    .select(publicRequest())
    .from(returnRequests)
    .where(eq(returnRequests.id, id))
    .limit(1);
  return row;
}

/** A stored request, without the two protected requester columns. */
export type ReturnRequestRow = NonNullable<Awaited<ReturnType<typeof findReturnRequestById>>>;

/** The LIVE request for an order, if there is one. */
export async function findOpenReturnRequestForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
) {
  const [row] = await db
    .select(publicRequest())
    .from(returnRequests)
    .where(
      and(
        eq(returnRequests.orderId, orderId),
        inArray(returnRequests.state, [...OPEN_RETURN_REQUEST_STATES]),
      ),
    )
    .limit(1);
  return row;
}

/** One request by idempotency key — the converge path for a retried call. */
export async function findReturnRequestByIdempotencyKey(
  key: string,
  db: DatabaseOrTransaction = getDb(),
) {
  const [row] = await db
    .select(publicRequest())
    .from(returnRequests)
    .where(eq(returnRequests.idempotencyKey, key))
    .limit(1);
  return row;
}

/** Every return filed against one order, newest first. */
export async function listReturnRequestsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
) {
  return db
    .select(publicRequest())
    .from(returnRequests)
    .where(eq(returnRequests.orderId, orderId))
    .orderBy(desc(returnRequests.createdAt));
}

/** One request's lines, in variant order. */
export async function listReturnRequestLines(
  requestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReturnRequestLineRow[]> {
  return db
    .select({
      id: returnRequestLines.id,
      requestId: returnRequestLines.requestId,
      variantId: returnRequestLines.variantId,
      requestedQuantity: returnRequestLines.requestedQuantity,
      approvedQuantity: returnRequestLines.approvedQuantity,
    })
    .from(returnRequestLines)
    .where(eq(returnRequestLines.requestId, requestId))
    .orderBy(returnRequestLines.variantId);
}

/** One request's declared evidence, in the order the buyer gave it. */
export async function listReturnRequestEvidence(
  requestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReturnEvidenceRow[]> {
  return db
    .select({
      id: returnRequestEvidence.id,
      requestId: returnRequestEvidence.requestId,
      fileId: returnRequestEvidence.fileId,
      kind: returnRequestEvidence.kind,
      position: returnRequestEvidence.position,
    })
    .from(returnRequestEvidence)
    .where(eq(returnRequestEvidence.requestId, requestId))
    .orderBy(asc(returnRequestEvidence.position));
}

/** Set the agreed quantity on one line. */
export async function setReturnLineApproved(
  tx: DatabaseOrTransaction,
  requestId: string,
  variantId: string,
  approvedQuantity: number,
): Promise<void> {
  await tx
    .update(returnRequestLines)
    .set({ approvedQuantity })
    .where(
      and(eq(returnRequestLines.requestId, requestId), eq(returnRequestLines.variantId, variantId)),
    );
}

/** Move a request between states, atomically. See the cancellation twin. */
export async function transitionReturnRequest(
  tx: DatabaseOrTransaction,
  input: {
    id: string;
    from: ReturnRequestState;
    to: ReturnRequestState;
    decidedByActorKind?: BuyerRequestActorKind;
    decidedByOxyUserId?: string;
    decidedAt?: Date;
    decisionNote?: string;
    returnInstructions?: string;
    shipBackDeadlineAt?: Date;
    receivedAt?: Date;
    refundId?: string;
    completedAt?: Date;
    completionFailure?: BuyerRequestCompletionFailure | null;
  },
): Promise<{ id: string } | null> {
  const [row] = await tx
    .update(returnRequests)
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
      ...(input.returnInstructions === undefined
        ? {}
        : { returnInstructions: input.returnInstructions }),
      ...(input.shipBackDeadlineAt === undefined
        ? {}
        : { shipBackDeadlineAt: input.shipBackDeadlineAt }),
      ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
      ...(input.refundId === undefined ? {} : { refundId: input.refundId }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.completionFailure === undefined
        ? {}
        : { completionFailure: input.completionFailure }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(returnRequests.id, input.id), eq(returnRequests.state, input.from)))
    .returning({ id: returnRequests.id });
  return row ?? null;
}

/** Record a completion failure without moving the request. */
export async function recordReturnCompletionFailure(
  tx: DatabaseOrTransaction,
  id: string,
  failure: BuyerRequestCompletionFailure,
): Promise<void> {
  await tx
    .update(returnRequests)
    .set({ completionFailure: failure, updatedAt: sql`now()` })
    .where(
      and(
        eq(returnRequests.id, id),
        inArray(returnRequests.state, ['received', 'refund_pending']),
      ),
    );
}

/**
 * Returns whose commerce refund committed and whose rail has not answered.
 *
 * The reconcile sweep's page. Bounded by `limit` and resumable by
 * `updatedBefore`, so a backlog is drained across ticks rather than in one
 * statement, and the ordering is the same column the partial index carries.
 */
export async function listReturnRequestsAwaitingRefundSettlement(
  input: { updatedBefore: Date; limit: number },
  db: DatabaseOrTransaction = getDb(),
) {
  return db
    .select(publicRequest())
    .from(returnRequests)
    .where(
      and(
        eq(returnRequests.state, 'refund_pending'),
        lt(returnRequests.updatedAt, input.updatedBefore),
      ),
    )
    .orderBy(asc(returnRequests.updatedAt))
    .limit(input.limit);
}

/** The merchant queue: open returns for a set of orders, oldest first. */
export async function listOpenReturnRequestsForOrders(
  orderIds: string[],
  db: DatabaseOrTransaction = getDb(),
) {
  if (orderIds.length === 0) return [];
  return db
    .select(publicRequest())
    .from(returnRequests)
    .where(
      and(
        inArray(returnRequests.orderId, orderIds),
        inArray(returnRequests.state, [...OPEN_RETURN_REQUEST_STATES]),
      ),
    )
    .orderBy(returnRequests.createdAt);
}

/**
 * How many units of each variant earlier returns already covered.
 *
 * Summed in SQL over every non-terminated request, because "how much is left to
 * return" has to count the ones still in flight as well as the ones completed —
 * counting only completed ones would let a buyer open a second return for units
 * a first one is already bringing back, and the two would then both be refunded.
 */
export async function sumReturnedQuantities(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      variantId: returnRequestLines.variantId,
      total: sql<string>`sum(coalesce(${returnRequestLines.approvedQuantity},
                                      ${returnRequestLines.requestedQuantity}))`,
    })
    .from(returnRequestLines)
    .innerJoin(returnRequests, eq(returnRequests.id, returnRequestLines.requestId))
    .where(
      and(
        eq(returnRequests.orderId, orderId),
        inArray(returnRequests.state, [...OPEN_RETURN_REQUEST_STATES, 'completed']),
      ),
    )
    .groupBy(returnRequestLines.variantId);
  // `sum()` over an integer column decodes as a STRING through postgres.js —
  // the bigint rule in AGENTS.md, which applies to every aggregate and not only
  // to bigint columns. Coercing here is what stops `total + 1` becoming string
  // concatenation at the call site.
  return new Map(rows.map((row) => [row.variantId, Number(row.total)]));
}
