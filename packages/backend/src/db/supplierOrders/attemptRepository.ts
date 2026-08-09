/**
 * The append-only log of every provider call this domain has made (#124
 * idempotency 8).
 *
 * ## Two writes, and the ORDER of them is the whole mechanism
 *
 * {@link openSupplierOrderAttempt} commits an `in_flight` row BEFORE the
 * adapter is invoked; {@link closeSupplierOrderAttempt} writes its terminal
 * outcome afterwards. A task that dies in between leaves the `in_flight` row,
 * which is durable evidence that a request may have reached the provider —
 * indistinguishable from a request that definitely did, which is precisely why
 * the recovery is a LOOKUP by client reference rather than a resubmission.
 *
 * Reversing the two (call, then log) would make a crash silent and a retry
 * blind, and the retry places a second supplier order.
 *
 * ## The attempt NUMBER is allocated by the database
 *
 * `attempt_number` is `max + 1` computed inside the insert, under the unique
 * index on `(purchase_order_id, operation, attempt_number)`. Two concurrent
 * dispatchers therefore cannot both write attempt 3: one wins and the other's
 * insert violates the index, which the caller answers by re-reading rather than
 * by retrying blind. A counter read in application code and written back would
 * hand both of them the same number, and the log would then show one attempt
 * where two calls were made — the single most misleading thing this table could
 * say.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  PurchaseOrderReasonCode,
  SupplierOrderAttemptOutcome,
  SupplierOrderOperation,
  SupplierOrderRefusalReason,
  SupplierProviderErrorClass,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierOrderAttempts } from '../schema/supplierOrders.js';

/**
 * One attempt row, whole. `request_hash` is PROTECTED — see `protectedColumns.ts`.
 *
 * Nothing OUTSIDE this module ever holds one: every function below reads and
 * returns {@link PublicSupplierOrderAttempt} instead, so the digest of a request
 * containing a buyer's street address cannot reach a caller at all. The type
 * exists because the projection is derived from the row's own field types.
 */
export type SupplierOrderAttemptRow = typeof supplierOrderAttempts.$inferSelect;

/**
 * The columns any surface outside this repository may read.
 *
 * `request_hash` is absent, deliberately: it is an exact-match oracle over the
 * buyer's shipping address (see `db/protectedColumns.ts`), and the operator
 * trace has no use for it that a `requestHashMatchesPrevious` boolean does not
 * serve better.
 */
export const PUBLIC_ATTEMPT_COLUMNS = {
  id: supplierOrderAttempts.id,
  purchaseOrderId: supplierOrderAttempts.purchaseOrderId,
  supplierAccountId: supplierOrderAttempts.supplierAccountId,
  operation: supplierOrderAttempts.operation,
  attemptNumber: supplierOrderAttempts.attemptNumber,
  outcome: supplierOrderAttempts.outcome,
  refusalReason: supplierOrderAttempts.refusalReason,
  providerObjectId: supplierOrderAttempts.providerObjectId,
  providerErrorClass: supplierOrderAttempts.providerErrorClass,
  providerErrorAfterWrite: supplierOrderAttempts.providerErrorAfterWrite,
  providerErrorCode: supplierOrderAttempts.providerErrorCode,
  providerMessage: supplierOrderAttempts.providerMessage,
  reasonCode: supplierOrderAttempts.reasonCode,
  stateMappingVersion: supplierOrderAttempts.stateMappingVersion,
  startedAt: supplierOrderAttempts.startedAt,
  completedAt: supplierOrderAttempts.completedAt,
  latencyMs: supplierOrderAttempts.latencyMs,
} as const;

/** An attempt row without the protected digest. */
export type PublicSupplierOrderAttempt = {
  [K in keyof typeof PUBLIC_ATTEMPT_COLUMNS]: SupplierOrderAttemptRow[K];
};

/** What opening an attempt records. */
export interface OpenSupplierOrderAttemptInput {
  purchaseOrderId: string;
  supplierAccountId: string;
  operation: SupplierOrderOperation;
  /** sha-256 hex of the canonical request. 64 characters, CHECK-enforced. */
  requestHash: string;
  startedAt?: Date;
}

/**
 * Commit an `in_flight` attempt row before the provider is called.
 *
 * The insert allocates its own `attempt_number`. On a unique violation the
 * caller lost a race with another dispatcher holding the same purchase order —
 * which cannot happen while the outbox lease is honoured, and which must
 * therefore surface rather than be papered over with a retry loop that would
 * hide a broken lease.
 */
export async function openSupplierOrderAttempt(
  input: OpenSupplierOrderAttemptInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierOrderAttempt> {
  const startedAt = input.startedAt ?? new Date();
  const nextNumber = sql<number>`(
    select coalesce(max(${supplierOrderAttempts.attemptNumber}), 0) + 1
    from ${supplierOrderAttempts}
    where ${supplierOrderAttempts.purchaseOrderId} = ${input.purchaseOrderId}
      and ${supplierOrderAttempts.operation} = ${input.operation}
  )`;
  const [row] = await db
    .insert(supplierOrderAttempts)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      supplierAccountId: input.supplierAccountId,
      operation: input.operation,
      attemptNumber: nextNumber,
      outcome: 'in_flight',
      requestHash: input.requestHash,
      startedAt,
    })
    .returning(PUBLIC_ATTEMPT_COLUMNS);
  if (!row) throw new Error('openSupplierOrderAttempt returned no row');
  return row;
}

/** What closing an attempt records. */
export interface CloseSupplierOrderAttemptInput {
  attemptId: string;
  outcome: Exclude<SupplierOrderAttemptOutcome, 'in_flight'>;
  refusalReason?: SupplierOrderRefusalReason;
  providerObjectId?: string;
  providerErrorClass?: SupplierProviderErrorClass;
  /** Whether the request may already have been applied — the ambiguity flag. */
  providerErrorAfterWrite?: 'yes' | 'no' | 'unknown';
  providerErrorCode?: string;
  /** Already REDACTED and bounded by the caller. */
  providerMessage?: string;
  reasonCode?: PurchaseOrderReasonCode;
  stateMappingVersion?: number;
  completedAt?: Date;
}

/**
 * Write an attempt's terminal outcome — once.
 *
 * The `WHERE` requires the row to still be `in_flight`, so a second close
 * matches nothing and returns `undefined`. That is the same guarantee the
 * trigger gives from below (an UPDATE to a row that has left `in_flight` is
 * refused outright); having it here too means a caller learns it lost rather
 * than receiving a database error it would have to parse.
 */
export async function closeSupplierOrderAttempt(
  input: CloseSupplierOrderAttemptInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierOrderAttempt | undefined> {
  const completedAt = input.completedAt ?? new Date();
  const [row] = await db
    .update(supplierOrderAttempts)
    .set({
      outcome: input.outcome,
      refusalReason: input.refusalReason ?? null,
      providerObjectId: input.providerObjectId ?? null,
      providerErrorClass: input.providerErrorClass ?? null,
      providerErrorAfterWrite: input.providerErrorAfterWrite ?? null,
      providerErrorCode: input.providerErrorCode ?? null,
      providerMessage: input.providerMessage ?? null,
      reasonCode: input.reasonCode ?? null,
      stateMappingVersion: input.stateMappingVersion ?? null,
      completedAt,
      // Bound to the ISO string with an explicit cast, never the `Date`: a
      // `Date` interpolated into a `sql` template has no column to take a type
      // from and postgres.js refuses it with `ERR_INVALID_ARG_TYPE` —
      // `CONVENTIONS.md`, "A `Date` is not a safe parameter against an
      // EXPRESSION". The plain `completedAt` above is fine, because there
      // drizzle knows the column's type.
      latencyMs: sql`greatest(0, (extract(epoch from (${completedAt.toISOString()}::timestamptz - ${supplierOrderAttempts.startedAt})) * 1000)::int)`,
      updatedAt: completedAt,
    })
    .where(
      and(eq(supplierOrderAttempts.id, input.attemptId), eq(supplierOrderAttempts.outcome, 'in_flight')),
    )
    .returning(PUBLIC_ATTEMPT_COLUMNS);
  return row;
}

/** One purchase order's attempts, newest first — the operator trace. */
export async function listSupplierOrderAttempts(
  purchaseOrderId: string,
  limit = 100,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierOrderAttempt[]> {
  return await db
    .select(PUBLIC_ATTEMPT_COLUMNS)
    .from(supplierOrderAttempts)
    .where(eq(supplierOrderAttempts.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(supplierOrderAttempts.startedAt), desc(supplierOrderAttempts.attemptNumber))
    .limit(limit);
}

/**
 * The most recent attempt at one operation on one purchase order.
 *
 * The convergence path's entry point: "is the last thing we did to this order
 * an unresolved submission?" is answered from here rather than from a column on
 * `purchase_orders`, because two representations of one fact can disagree and
 * the place that must not happen is the decision to call a supplier again.
 */
export async function findLatestSupplierOrderAttempt(
  input: { purchaseOrderId: string; operation: SupplierOrderOperation },
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierOrderAttempt | undefined> {
  const [row] = await db
    .select(PUBLIC_ATTEMPT_COLUMNS)
    .from(supplierOrderAttempts)
    .where(
      and(
        eq(supplierOrderAttempts.purchaseOrderId, input.purchaseOrderId),
        eq(supplierOrderAttempts.operation, input.operation),
      ),
    )
    .orderBy(desc(supplierOrderAttempts.attemptNumber))
    .limit(1);
  return row;
}

/**
 * Attempts that may have written and were never resolved — the recovery sweep.
 *
 * `in_flight` is in the predicate beside `ambiguous` because a task that died
 * mid-call leaves exactly that shape, and it is the one an ordinary retry would
 * silently duplicate. The age bound stops the sweep picking up a call that is
 * legitimately still running.
 */
export async function listUnresolvedSupplierOrderAttempts(
  input: { olderThan: Date; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierOrderAttempt[]> {
  return await db
    .select(PUBLIC_ATTEMPT_COLUMNS)
    .from(supplierOrderAttempts)
    .where(
      and(
        inArray(supplierOrderAttempts.outcome, ['ambiguous', 'in_flight']),
        sql`${supplierOrderAttempts.startedAt} <= ${input.olderThan}`,
      ),
    )
    .orderBy(supplierOrderAttempts.startedAt)
    .limit(input.limit);
}

/**
 * Whether an earlier attempt at this operation sent a DIFFERENT request.
 *
 * #124 submission orchestration 6 wants the request persisted before a call is
 * acknowledged, and this is what that persistence is FOR: a resubmission whose
 * canonical request differs from the one that may already have been applied is
 * not a retry, it is a second, different order, and the orchestration refuses
 * it. The comparison happens in SQL so the digest never leaves the database.
 */
export async function supplierOrderRequestDiffersFromPrior(
  input: {
    purchaseOrderId: string;
    operation: SupplierOrderOperation;
    requestHash: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ differing: sql<number>`count(*)::int` })
    .from(supplierOrderAttempts)
    .where(
      and(
        eq(supplierOrderAttempts.purchaseOrderId, input.purchaseOrderId),
        eq(supplierOrderAttempts.operation, input.operation),
        sql`${supplierOrderAttempts.requestHash} <> ${input.requestHash}`,
      ),
    );
  return (row?.differing ?? 0) > 0;
}

/** Attempt counts by outcome for one account — #124 observability 1, 2 and 8. */
export async function supplierOrderAttemptCounts(
  input: { supplierAccountId?: string; since: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ operation: string; outcome: string; total: number; p95LatencyMs: number | null }[]> {
  return await db
    .select({
      operation: supplierOrderAttempts.operation,
      outcome: supplierOrderAttempts.outcome,
      total: sql<number>`count(*)::int`,
      // `bigint`-safe: `percentile_disc` over an int column returns an int, and
      // the explicit cast keeps postgres.js from handing back a string.
      p95LatencyMs: sql<
        number | null
      >`(percentile_disc(0.95) within group (order by ${supplierOrderAttempts.latencyMs}))::int`,
    })
    .from(supplierOrderAttempts)
    .where(
      and(
        sql`${supplierOrderAttempts.startedAt} >= ${input.since}`,
        ...(input.supplierAccountId
          ? [eq(supplierOrderAttempts.supplierAccountId, input.supplierAccountId)]
          : []),
      ),
    )
    .groupBy(supplierOrderAttempts.operation, supplierOrderAttempts.outcome);
}
