/**
 * Reconciliation exceptions — what a person has to look at (#128 acceptance 7).
 *
 * The `payment_discrepancies` posture: a row here is a RECORDING, detection is
 * separate from repair, and nothing in this file deletes or rewrites a financial
 * record to make a mismatch go away. The only mutation is a RESOLUTION, and it
 * is attributable, dated and explained by CHECK.
 *
 * ## The upsert is what makes a periodic sweep survivable
 *
 * A sweep sees the same unresolved condition on every pass. If each sighting
 * were a row, the queue would grow without bound and the loudest exception would
 * be the oldest rather than the worst — so a repeat BUMPS `last_seen_at` and
 * `occurrences` on the row that is already open, and the partial unique index is
 * what makes that an upsert two tasks cannot both lose.
 *
 * The `ON CONFLICT` target must repeat the index's `WHERE resolved_at IS NULL`
 * predicate: Postgres refuses to infer a PARTIAL unique as an arbiter without
 * it, and the failure is a 500 at runtime rather than a compile error.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { RetailReconciliationExceptionKind } from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { retailReconciliationExceptions } from '../schema/retailReconciliation.js';

/** One condition a person has to close. */
export type RetailReconciliationExceptionRow =
  typeof retailReconciliationExceptions.$inferSelect;

/** What one detection states. */
export interface NewReconciliationException {
  kind: RetailReconciliationExceptionKind;
  orderId: string;
  reconciliationId?: string;
  purchaseOrderId?: string;
  detail: string;
  at?: Date;
}

/** Bound on a stored sentence — the same `.slice()` every provider string gets. */
const MAX_DETAIL = 2_000;

/**
 * Raise an exception, or record that an open one was seen again.
 *
 * @returns The row, open. A caller cannot tell a first sighting from a repeat
 *   off the return value on purpose — nothing should behave differently, and a
 *   boolean would invite a "notify only the first time" branch that goes silent
 *   for a condition that has been open for a month.
 */
export async function raiseReconciliationException(
  input: NewReconciliationException,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationExceptionRow> {
  const at = input.at ?? new Date();
  const [row] = await db
    .insert(retailReconciliationExceptions)
    .values({
      id: uuidv7(),
      kind: input.kind,
      orderId: input.orderId,
      ...(input.reconciliationId ? { reconciliationId: input.reconciliationId } : {}),
      ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
      detail: input.detail.slice(0, MAX_DETAIL),
      raisedAt: at,
      lastSeenAt: at,
      occurrences: 1,
    })
    .onConflictDoUpdate({
      target: [retailReconciliationExceptions.kind, retailReconciliationExceptions.orderId],
      // The partial index's own predicate, repeated: without it Postgres cannot
      // infer a PARTIAL unique as the arbiter and the statement fails at runtime.
      targetWhere: isNull(retailReconciliationExceptions.resolvedAt),
      set: {
        lastSeenAt: at,
        occurrences: sql`${retailReconciliationExceptions.occurrences} + 1`,
        detail: input.detail.slice(0, MAX_DETAIL),
        ...(input.reconciliationId ? { reconciliationId: input.reconciliationId } : {}),
      },
    })
    .returning();
  if (!row) throw new Error('The reconciliation exception upsert returned no row.');
  return row;
}

/**
 * Close an exception, attributably.
 *
 * A compare-and-swap on `resolved_at IS NULL`, so two operators pressing at once
 * converge on the first one's decision rather than overwriting it — and the
 * loser gets `undefined` rather than a silent success, which is what the audit
 * row records as a `no_op`.
 */
export async function resolveReconciliationException(
  input: { id: string; resolvedByOxyUserId: string; reason: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationExceptionRow | undefined> {
  const [row] = await db
    .update(retailReconciliationExceptions)
    .set({
      resolvedAt: input.now ?? new Date(),
      resolvedByOxyUserId: input.resolvedByOxyUserId,
      resolutionReason: input.reason.slice(0, MAX_DETAIL),
    })
    .where(
      and(
        eq(retailReconciliationExceptions.id, input.id),
        isNull(retailReconciliationExceptions.resolvedAt),
      ),
    )
    .returning();
  return row;
}

/**
 * Close every OPEN exception of the given kinds for one order.
 *
 * Used by the sweep when a later revision no longer reports a condition: an
 * exception that has been fixed must stop being open without a person pressing
 * anything, or the queue fills with resolved problems and stops being read. The
 * resolution is attributed to the system with an explicit reason, so it is
 * distinguishable in the trail from one somebody decided.
 */
export async function autoResolveReconciliationExceptions(
  input: {
    orderId: string;
    kinds: readonly RetailReconciliationExceptionKind[];
    reason: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (input.kinds.length === 0) return 0;
  const rows = await db
    .update(retailReconciliationExceptions)
    .set({
      resolvedAt: input.now ?? new Date(),
      resolvedByOxyUserId: 'system:retail-reconciliation',
      resolutionReason: input.reason.slice(0, MAX_DETAIL),
    })
    .where(
      and(
        eq(retailReconciliationExceptions.orderId, input.orderId),
        isNull(retailReconciliationExceptions.resolvedAt),
        sql`${retailReconciliationExceptions.kind} = any(${sql.param([...input.kinds])})`,
      ),
    )
    .returning({ id: retailReconciliationExceptions.id });
  return rows.length;
}

/** Every exception naming one order, newest first. */
export async function listReconciliationExceptionsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationExceptionRow[]> {
  return db
    .select()
    .from(retailReconciliationExceptions)
    .where(eq(retailReconciliationExceptions.orderId, orderId))
    .orderBy(desc(retailReconciliationExceptions.raisedAt));
}

/** The operator queue: what is still open, oldest first. */
export async function listOpenReconciliationExceptions(
  input: { limit: number; kind?: RetailReconciliationExceptionKind },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationExceptionRow[]> {
  return db
    .select()
    .from(retailReconciliationExceptions)
    .where(
      and(
        isNull(retailReconciliationExceptions.resolvedAt),
        ...(input.kind ? [eq(retailReconciliationExceptions.kind, input.kind)] : []),
      ),
    )
    .orderBy(asc(retailReconciliationExceptions.raisedAt))
    .limit(input.limit);
}

/** One exception by id. */
export async function findReconciliationException(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationExceptionRow | undefined> {
  const [row] = await db
    .select()
    .from(retailReconciliationExceptions)
    .where(eq(retailReconciliationExceptions.id, id))
    .limit(1);
  return row;
}

/** How many exceptions of each kind are open — metric 6's numerator. */
export async function countOpenExceptionsByKind(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ kind: string; open: number }[]> {
  const rows = await db
    .select({
      kind: retailReconciliationExceptions.kind,
      open: sql<string>`count(*)`,
    })
    .from(retailReconciliationExceptions)
    .where(isNull(retailReconciliationExceptions.resolvedAt))
    .groupBy(retailReconciliationExceptions.kind);
  // `count()` comes back from postgres.js as a STRING.
  return rows.map((row) => ({ kind: row.kind, open: Number(row.open) }));
}
