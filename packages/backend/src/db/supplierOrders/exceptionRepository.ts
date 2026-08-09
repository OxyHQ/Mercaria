/**
 * Raising, reading and closing the procurement conditions only a person can
 * close.
 *
 * `db/payments/discrepancyRepository.ts`'s posture: detection and repair are
 * separate acts, this module only DETECTS, and nothing here deletes or rewrites
 * a procurement record to make a mismatch go away.
 *
 * ## Raising is idempotent, and that is a partial unique index
 *
 * Two detections of one condition — a webhook noticing a duplicate and the
 * sweep noticing the same one — converge on the case that is already open. The
 * `WHERE resolved_at IS NULL` predicate is what makes a RESOLVED case
 * re-raisable when the condition genuinely recurs, which a plain unique on
 * `(kind, purchase_order_id)` would forbid forever.
 *
 * Both `ON CONFLICT` clauses repeat their index's predicate, because Postgres
 * refuses to infer a partial index's arbiter without it — the `carts` lesson
 * (#104), one domain over.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  ProcurementExceptionKind,
  ProcurementExceptionResolution,
} from '@mercaria/shared-types';
import { PROCUREMENT_HALTING_EXCEPTION_KINDS } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { procurementExceptions } from '../schema/supplierOrders.js';

/** One exception row. */
export type ProcurementExceptionRow = typeof procurementExceptions.$inferSelect;

/** Longest stored detail or note — matches the columns' CHECKs. */
const MAX_NOTE_LENGTH = 2_000;

/** What raising one condition records. */
export interface RaiseProcurementExceptionInput {
  kind: ProcurementExceptionKind;
  purchaseOrderId?: string;
  supplierId?: string;
  supplierAccountId?: string;
  providerEventId?: string;
  /** Already REDACTED and bounded by the caller. Never a payload or an address. */
  detail: string;
  detectedAt?: Date;
}

/** The raise's answer: the open case, and whether this call opened it. */
export interface RaiseProcurementExceptionResult {
  exception: ProcurementExceptionRow;
  raised: boolean;
}

/**
 * Open a case, or converge on the one already open for this condition.
 *
 * The arbiter depends on what the condition is ABOUT: a purchase-order
 * condition keys on the order, and an account-scoped one (a rejected
 * credential, an exhausted quota, a lagging event stream) has no order to key
 * on and keys on the account. A case with neither is refused by the table's own
 * subject CHECK before it reaches either index.
 */
export async function raiseProcurementException(
  input: RaiseProcurementExceptionInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<RaiseProcurementExceptionResult> {
  const detectedAt = input.detectedAt ?? new Date();
  const values = {
    kind: input.kind,
    purchaseOrderId: input.purchaseOrderId ?? null,
    supplierId: input.supplierId ?? null,
    supplierAccountId: input.supplierAccountId ?? null,
    providerEventId: input.providerEventId ?? null,
    detail: input.detail.slice(0, MAX_NOTE_LENGTH),
    detectedAt,
  };

  const inserted = input.purchaseOrderId
    ? await db
        .insert(procurementExceptions)
        .values(values)
        .onConflictDoNothing({
          target: [procurementExceptions.kind, procurementExceptions.purchaseOrderId],
          where: sql`${procurementExceptions.resolvedAt} is null
                           and ${procurementExceptions.purchaseOrderId} is not null`,
        })
        .returning()
    : await db
        .insert(procurementExceptions)
        .values(values)
        .onConflictDoNothing({
          target: [procurementExceptions.kind, procurementExceptions.supplierAccountId],
          where: sql`${procurementExceptions.resolvedAt} is null
                           and ${procurementExceptions.purchaseOrderId} is null
                           and ${procurementExceptions.supplierAccountId} is not null`,
        })
        .returning();

  const [row] = inserted;
  if (row) return { exception: row, raised: true };

  const survivor = await findOpenProcurementException(
    {
      kind: input.kind,
      ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
      ...(input.supplierAccountId ? { supplierAccountId: input.supplierAccountId } : {}),
    },
    db,
  );
  if (!survivor) {
    // The winner's transaction aborted after blocking ours — retry the claim.
    return await raiseProcurementException(input, db);
  }
  return { exception: survivor, raised: false };
}

/** The open case for one condition, if there is one. */
export async function findOpenProcurementException(
  input: { kind: ProcurementExceptionKind; purchaseOrderId?: string; supplierAccountId?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementExceptionRow | undefined> {
  const [row] = await db
    .select()
    .from(procurementExceptions)
    .where(
      and(
        eq(procurementExceptions.kind, input.kind),
        isNull(procurementExceptions.resolvedAt),
        input.purchaseOrderId
          ? eq(procurementExceptions.purchaseOrderId, input.purchaseOrderId)
          : isNull(procurementExceptions.purchaseOrderId),
        ...(input.supplierAccountId
          ? [eq(procurementExceptions.supplierAccountId, input.supplierAccountId)]
          : []),
      ),
    )
    .limit(1);
  return row;
}

/** One exception by id. */
export async function findProcurementExceptionById(
  exceptionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementExceptionRow | undefined> {
  const [row] = await db
    .select()
    .from(procurementExceptions)
    .where(eq(procurementExceptions.id, exceptionId))
    .limit(1);
  return row;
}

/**
 * Close a case with an attributable decision.
 *
 * The `WHERE` requires it to still be open, so a second close matches nothing
 * and the caller learns it lost rather than silently overwriting somebody
 * else's resolution — the `payment_repairs` posture, where every attempt is
 * audited and a refusal is a real outcome.
 */
export async function resolveProcurementException(
  input: {
    exceptionId: string;
    resolution: ProcurementExceptionResolution;
    resolvedByOxyUserId: string;
    resolutionNote?: string;
    resolvedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementExceptionRow | undefined> {
  const resolvedAt = input.resolvedAt ?? new Date();
  const [row] = await db
    .update(procurementExceptions)
    .set({
      resolvedAt,
      resolution: input.resolution,
      resolvedByOxyUserId: input.resolvedByOxyUserId,
      resolutionNote: input.resolutionNote?.slice(0, MAX_NOTE_LENGTH) ?? null,
      updatedAt: resolvedAt,
    })
    .where(
      and(eq(procurementExceptions.id, input.exceptionId), isNull(procurementExceptions.resolvedAt)),
    )
    .returning();
  return row;
}

/** Open cases, oldest first — the operator queue. */
export async function listOpenProcurementExceptions(
  input: { kind?: ProcurementExceptionKind; purchaseOrderId?: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementExceptionRow[]> {
  return await db
    .select()
    .from(procurementExceptions)
    .where(
      and(
        isNull(procurementExceptions.resolvedAt),
        ...(input.kind ? [eq(procurementExceptions.kind, input.kind)] : []),
        ...(input.purchaseOrderId
          ? [eq(procurementExceptions.purchaseOrderId, input.purchaseOrderId)]
          : []),
      ),
    )
    .orderBy(procurementExceptions.detectedAt)
    .limit(input.limit);
}

/** Every case for one purchase order, newest first — the trace. */
export async function listProcurementExceptionsForPurchaseOrder(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementExceptionRow[]> {
  return await db
    .select()
    .from(procurementExceptions)
    .where(eq(procurementExceptions.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(procurementExceptions.detectedAt));
}

/**
 * Whether a purchase order has an open condition that must STOP fulfilment and
 * payment escalation (#124 idempotency 7).
 *
 * The set is `PROCUREMENT_HALTING_EXCEPTION_KINDS` and it is read from
 * shared-types rather than repeated here, so widening it takes effect
 * everywhere at once rather than in whichever caller was updated.
 */
export async function purchaseOrderHasHaltingException(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(procurementExceptions)
    .where(
      and(
        eq(procurementExceptions.purchaseOrderId, purchaseOrderId),
        isNull(procurementExceptions.resolvedAt),
        sql`${procurementExceptions.kind} = any(${sql.param([...PROCUREMENT_HALTING_EXCEPTION_KINDS])}::text[])`,
      ),
    );
  return (row?.total ?? 0) > 0;
}

/** Open-case counts by kind — #124 observability 3, 6 and 9. */
export async function procurementExceptionCounts(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ kind: string; open: number; resolved: number }[]> {
  return await db
    .select({
      kind: procurementExceptions.kind,
      open: sql<number>`count(*) filter (where ${procurementExceptions.resolvedAt} is null)::int`,
      resolved: sql<number>`count(*) filter (where ${procurementExceptions.resolvedAt} is not null)::int`,
    })
    .from(procurementExceptions)
    .groupBy(procurementExceptions.kind);
}
