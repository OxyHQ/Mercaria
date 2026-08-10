/**
 * `retail_service_requests`, its lines, its evidence and its append-only event
 * trail (#127).
 *
 * ## The one invariant no CHECK can hold
 *
 * The sum of requested quantities against ONE order line, over requests that are
 * neither rejected nor withdrawn nor cancelled, may never exceed that line's own
 * quantity. It is cross-row, so {@link insertRetailServiceRequest} is the SINGLE
 * writer and refuses before issuing SQL, with the order items locked
 * `FOR UPDATE` first — #126's allocation cap, the same shape and the same
 * reason: two concurrent submissions otherwise both read the same pre-insert sum
 * and both pass.
 *
 * #127 acceptance 3 asks that duplicates and reordered events cannot
 * double-refund, double-cancel or double-return a quantity. That has THREE
 * layers and none covers the others: this cap, the partial unique on
 * `(order_id, kind)` over the open states, and `refunds.idempotency_key` derived
 * from the request. The first stops two DIFFERENT requests claiming one unit,
 * the second stops two attempts at one request, and the third stops one decided
 * request paying twice.
 *
 * ## Reads go through `publicColumns`
 *
 * The trail carries `actor_grant_id`, which is a guest's cross-order correlation
 * key. A plain `select()` on a table whose rows a merchant-facing or operator
 * projection serializes whole would put it in a response — #106's
 * `PUBLIC_STATUS_EVENT_COLUMNS` reasoning, applied to the table that inherited
 * the same column.
 */

import { and, asc, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  RetailCustomerOutcome,
  RetailServiceActorKind,
  RetailServiceCompletionFailure,
  RetailServiceEvidenceKind,
  RetailServiceRequestKind,
  RetailServiceRequestOrigin,
  RetailServiceRequestState,
} from '@mercaria/shared-types';
import { OPEN_RETAIL_SERVICE_REQUEST_STATES } from '@mercaria/shared-types';
import {
  retailServiceRequestEvents,
  retailServiceRequestEvidence,
  retailServiceRequestLines,
  retailServiceRequests,
} from '../schema/retailServiceRequests.js';
import { orderItems } from '../schema/orders.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One order line and how many of its units a request names. */
export interface NewRetailServiceRequestLine {
  orderItemId: string;
  requestedQuantity: number;
}

/** One declared Oxy file. Never a URL, never a copy of the bytes. */
export interface NewRetailServiceEvidence {
  fileId: string;
  kind: RetailServiceEvidenceKind;
  caption?: string;
  position: number;
}

/** Everything an insert states. The state is the caller's derived verdict. */
export interface NewRetailServiceRequest {
  orderId: string;
  kind: RetailServiceRequestKind;
  state: RetailServiceRequestState;
  origin: RetailServiceRequestOrigin;
  requesterKind: RetailServiceActorKind;
  requesterOxyUserId?: string;
  requesterGrantId?: string;
  customerNote?: string;
  customerTermsVersion: string;
  policyMarket: string;
  statutoryDeadlineAt?: Date;
  commercialDeadlineAt?: Date;
  supplierResponseDueAt?: Date;
  idempotencyKey?: string;
  lines: NewRetailServiceRequestLine[];
  evidence: NewRetailServiceEvidence[];
}

/**
 * Every read of a request goes through this.
 *
 * The requester triple is in `PROTECTED_COLUMNS` — a portal grant id is a
 * guest's cross-order correlation key, and a request row is serialized to a
 * buyer AND to an operator from this one repository. Nothing in the domain reads
 * it back: it is written for the audit trail and answered only by the events
 * table, which withholds it too.
 */
const publicRequest = () => publicColumns(retailServiceRequests, PROTECTED_COLUMNS);

/** The row shape every read returns — the requester triple withheld. */
export type RetailServiceRequestRow = Omit<
  typeof retailServiceRequests.$inferSelect,
  'requesterOxyUserId' | 'requesterGrantId'
>;

/** One line as stored. */
export type RetailServiceRequestLineRow = typeof retailServiceRequestLines.$inferSelect;

/** One evidence reference as stored. */
export type RetailServiceEvidenceRow = typeof retailServiceRequestEvidence.$inferSelect;

/** A request with its children, which is the only useful unit to read. */
export interface RetailServiceRequestRecord extends RetailServiceRequestRow {
  lines: RetailServiceRequestLineRow[];
  evidence: RetailServiceEvidenceRow[];
}

/** The states that no longer hold a claim on a unit. */
const RELEASING_STATES: readonly RetailServiceRequestState[] = [
  'rejected',
  'withdrawn',
  'cancelled',
];

/** Load one request and its children, or `undefined`. */
export async function findRetailServiceRequest(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRecord | undefined> {
  const [row] = await db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(eq(retailServiceRequests.id, id));
  if (!row) return undefined;
  return withChildren(row, db);
}

/** Every request on one order, newest first. */
export async function listRetailServiceRequestsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRecord[]> {
  const rows = await db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(eq(retailServiceRequests.orderId, orderId))
    .orderBy(desc(retailServiceRequests.createdAt));
  const out: RetailServiceRequestRecord[] = [];
  for (const row of rows) out.push(await withChildren(row, db));
  return out;
}

/** The open request of one kind on one order, if there is one. */
export async function findOpenRetailServiceRequest(
  orderId: string,
  kind: RetailServiceRequestKind,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRecord | undefined> {
  const [row] = await db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(
      and(
        eq(retailServiceRequests.orderId, orderId),
        eq(retailServiceRequests.kind, kind),
        inArray(retailServiceRequests.state, [...OPEN_RETAIL_SERVICE_REQUEST_STATES]),
      ),
    );
  if (!row) return undefined;
  return withChildren(row, db);
}

/** The request a converging retry already created, if there is one. */
export async function findRetailServiceRequestByIdempotencyKey(
  key: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRecord | undefined> {
  const [row] = await db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(eq(retailServiceRequests.idempotencyKey, key));
  if (!row) return undefined;
  return withChildren(row, db);
}

/**
 * How many units of each named order line are still unclaimed.
 *
 * Reads the order line's own quantity and subtracts everything a live request
 * already claims. Called INSIDE the insert's transaction with the lines locked,
 * so the number it returns is still true when the insert lands — the whole point
 * of the lock, and the reason this is not exported as a standalone read.
 */
async function unresolvedUnits(
  db: DatabaseOrTransaction,
  orderItemIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderItemIds.length === 0) return new Map();
  // `sql.param` binds the whole array as ONE parameter; a bare array renders as
  // a ROW constructor, which Postgres rejects outright at runtime.
  const items = await db
    .select({ id: orderItems.id, quantity: orderItems.quantity })
    .from(orderItems)
    .where(sql`${orderItems.id} = any(${sql.param([...orderItemIds])}::text[])`)
    .for('update');

  const claimed = await db
    .select({
      orderItemId: retailServiceRequestLines.orderItemId,
      // `bigint`/`int8` decodes as a JS STRING through postgres.js, and `sum`
      // returns `numeric`. `Number(...)` at the boundary is what stops
      // `total + 1` becoming string concatenation.
      total: sql<string>`coalesce(sum(${retailServiceRequestLines.requestedQuantity}), 0)`,
    })
    .from(retailServiceRequestLines)
    .innerJoin(
      retailServiceRequests,
      eq(retailServiceRequests.id, retailServiceRequestLines.requestId),
    )
    .where(
      and(
        sql`${retailServiceRequestLines.orderItemId} = any(${sql.param([...orderItemIds])}::text[])`,
        notInArray(retailServiceRequests.state, [...RELEASING_STATES]),
      ),
    )
    .groupBy(retailServiceRequestLines.orderItemId);

  const claimedBy = new Map(claimed.map((row) => [row.orderItemId, Number(row.total)]));
  return new Map(
    items.map((item) => [item.id, item.quantity - (claimedBy.get(item.id) ?? 0)]),
  );
}

/** How many units of each named line are still unclaimed, for the derivation. */
export async function readUnresolvedRetailUnits(
  orderItemIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  return unresolvedUnits(db, orderItemIds);
}

/**
 * Create one request, its lines and its evidence in ONE transaction.
 *
 * Refuses BEFORE issuing the insert when the named quantities exceed what is
 * still unclaimed, with the order items locked first. `undefined` on a
 * convergence — the caller reads the winner back rather than being handed a row
 * it did not create, which is #110's shape and keeps "did I create this" answerable.
 */
export async function insertRetailServiceRequest(
  input: NewRetailServiceRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRecord> {
  const available = await unresolvedUnits(
    db,
    input.lines.map((line) => line.orderItemId),
  );
  for (const line of input.lines) {
    const remaining = available.get(line.orderItemId);
    if (remaining === undefined) {
      throw new Error(`order item ${line.orderItemId} is not on this order`);
    }
    if (line.requestedQuantity > remaining) {
      throw new Error(
        `order item ${line.orderItemId} has ${remaining} unclaimed unit(s); ` +
          `${line.requestedQuantity} were requested`,
      );
    }
  }

  const [row] = await db
    .insert(retailServiceRequests)
    .values({
      orderId: input.orderId,
      kind: input.kind,
      state: input.state,
      origin: input.origin,
      requesterKind: input.requesterKind,
      requesterOxyUserId: input.requesterOxyUserId ?? null,
      requesterGrantId: input.requesterGrantId ?? null,
      customerNote: input.customerNote ?? null,
      customerTermsVersion: input.customerTermsVersion,
      policyMarket: input.policyMarket,
      statutoryDeadlineAt: input.statutoryDeadlineAt ?? null,
      commercialDeadlineAt: input.commercialDeadlineAt ?? null,
      supplierResponseDueAt: input.supplierResponseDueAt ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning(publicRequest());
  if (!row) throw new Error('the retail service request insert returned no row');

  if (input.lines.length > 0) {
    await db.insert(retailServiceRequestLines).values(
      input.lines.map((line) => ({
        requestId: row.id,
        orderItemId: line.orderItemId,
        requestedQuantity: line.requestedQuantity,
      })),
    );
  }
  if (input.evidence.length > 0) {
    await db.insert(retailServiceRequestEvidence).values(
      input.evidence.map((item) => ({
        requestId: row.id,
        kind: item.kind,
        fileId: item.fileId,
        caption: item.caption ?? null,
        position: item.position,
      })),
    );
  }
  return withChildren(row, db);
}

/**
 * Move a request's state, only from the state the caller believes it is in.
 *
 * A compare-and-swap rather than a plain update, so two deciders acting at once
 * produce ONE decision and the loser is told the request moved. `undefined` IS
 * the "somebody got there first" answer — an empty `RETURNING` set, the same
 * shape every claim in this repository uses.
 */
export async function transitionRetailServiceRequest(
  input: {
    id: string;
    from: readonly RetailServiceRequestState[];
    to: RetailServiceRequestState;
    outcome?: RetailCustomerOutcome;
    outcomeNote?: string;
    deciderKind?: RetailServiceActorKind;
    deciderOxyUserId?: string;
    decidedAt?: Date;
    refundId?: string;
    completionFailure?: RetailServiceCompletionFailure | null;
    completedAt?: Date | null;
    policyExceptionId?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRow | undefined> {
  const [row] = await db
    .update(retailServiceRequests)
    .set({
      state: input.to,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.outcomeNote === undefined ? {} : { outcomeNote: input.outcomeNote }),
      ...(input.deciderKind === undefined ? {} : { deciderKind: input.deciderKind }),
      ...(input.deciderOxyUserId === undefined
        ? {}
        : { deciderOxyUserId: input.deciderOxyUserId }),
      ...(input.decidedAt === undefined ? {} : { decidedAt: input.decidedAt }),
      ...(input.refundId === undefined ? {} : { refundId: input.refundId }),
      ...(input.completionFailure === undefined
        ? {}
        : { completionFailure: input.completionFailure }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.policyExceptionId === undefined
        ? {}
        : { policyExceptionId: input.policyExceptionId }),
    })
    .where(
      and(
        eq(retailServiceRequests.id, input.id),
        inArray(retailServiceRequests.state, [...input.from]),
      ),
    )
    .returning(publicRequest());
  return row;
}

/** Attach evidence to a request that is waiting for it. */
export async function addRetailServiceEvidence(
  requestId: string,
  evidence: readonly NewRetailServiceEvidence[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (evidence.length === 0) return 0;
  const rows = await db
    .insert(retailServiceRequestEvidence)
    .values(
      evidence.map((item) => ({
        requestId,
        kind: item.kind,
        fileId: item.fileId,
        caption: item.caption ?? null,
        position: item.position,
      })),
    )
    // A buyer re-uploading the same file is a repeat, not an error.
    .onConflictDoNothing()
    .returning();
  return rows.length;
}

/** Set what Mercaria approved, per line. The only quantity a refund reads. */
export async function approveRetailServiceRequestLines(
  requestId: string,
  approvals: ReadonlyMap<string, number>,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  for (const [orderItemId, quantity] of approvals) {
    await db
      .update(retailServiceRequestLines)
      .set({ approvedQuantity: quantity })
      .where(
        and(
          eq(retailServiceRequestLines.requestId, requestId),
          eq(retailServiceRequestLines.orderItemId, orderItemId),
        ),
      );
  }
}

/** Append one event. The trail refuses UPDATE and DELETE by trigger. */
export async function appendRetailServiceEvent(
  input: {
    requestId: string;
    kind: string;
    resultingState?: RetailServiceRequestState;
    actorKind: RetailServiceActorKind;
    actorOxyUserId?: string;
    actorGrantId?: string;
    detail?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(retailServiceRequestEvents).values({
    requestId: input.requestId,
    kind: input.kind,
    resultingState: input.resultingState ?? null,
    actorKind: input.actorKind,
    actorOxyUserId: input.actorOxyUserId ?? null,
    actorGrantId: input.actorGrantId ?? null,
    detail: input.detail ?? null,
  });
}

/** The trail, oldest first, with the guest correlation key withheld. */
export async function listRetailServiceEvents(
  requestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  Omit<typeof retailServiceRequestEvents.$inferSelect, 'actorGrantId' | 'actorOxyUserId'>[]
> {
  return db
    .select(publicColumns(retailServiceRequestEvents, PROTECTED_COLUMNS))
    .from(retailServiceRequestEvents)
    .where(eq(retailServiceRequestEvents.requestId, requestId))
    .orderBy(asc(retailServiceRequestEvents.createdAt));
}

/**
 * The reconciler's page: requests whose refund the rail has not settled.
 *
 * Bounded and resumable on `updated_at`, reading the partial index, so "which
 * requests are waiting on a rail" is an indexed range rather than a scan of
 * every request ever filed.
 */
export async function listRetailServiceRequestsAwaitingSettlement(
  input: { olderThan: Date; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRow[]> {
  return db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(
      and(
        eq(retailServiceRequests.state, 'in_progress'),
        sql`${retailServiceRequests.refundId} is not null`,
        lt(retailServiceRequests.updatedAt, input.olderThan),
      ),
    )
    .orderBy(asc(retailServiceRequests.updatedAt))
    .limit(input.limit);
}

/** Every request still open, oldest first — the operator queue. */
export async function listOpenRetailServiceRequests(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRow[]> {
  return db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(inArray(retailServiceRequests.state, [...OPEN_RETAIL_SERVICE_REQUEST_STATES]))
    .orderBy(asc(retailServiceRequests.createdAt))
    .limit(limit);
}

/** Requests whose SUPPLIER clock has passed and which nothing has closed. */
export async function listRetailServiceRequestsPastSupplierClock(
  now: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServiceRequestRow[]> {
  return db
    .select(publicRequest())
    .from(retailServiceRequests)
    .where(
      and(
        inArray(retailServiceRequests.state, [...OPEN_RETAIL_SERVICE_REQUEST_STATES]),
        lt(retailServiceRequests.supplierResponseDueAt, now),
        isNull(retailServiceRequests.completedAt),
      ),
    )
    .orderBy(asc(retailServiceRequests.supplierResponseDueAt))
    .limit(limit);
}

/** A request plus its lines and evidence. */
async function withChildren(
  row: RetailServiceRequestRow,
  db: DatabaseOrTransaction,
): Promise<RetailServiceRequestRecord> {
  const [lines, evidence] = await Promise.all([
    db
      .select()
      .from(retailServiceRequestLines)
      .where(eq(retailServiceRequestLines.requestId, row.id)),
    db
      .select()
      .from(retailServiceRequestEvidence)
      .where(eq(retailServiceRequestEvidence.requestId, row.id))
      .orderBy(asc(retailServiceRequestEvidence.position)),
  ]);
  return { ...row, lines, evidence };
}
