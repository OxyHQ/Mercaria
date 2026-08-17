/**
 * The operator audit — one row per ATTEMPT on the reconciliation surface,
 * refusals included.
 *
 * The `payment_repairs` shape. A table that recorded only successes would make a
 * refused action indistinguishable from one nobody tried, which is precisely the
 * question an incident review asks first. Append-only by trigger, actor and
 * reason mandatory by CHECK, and there is no update and no delete in this file.
 */

import { desc, eq, sql } from 'drizzle-orm';
import type {
  RetailReconciliationOperatorAction,
  RetailReconciliationOperatorOutcome,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { retailReconciliationOperatorActions } from '../schema/retailReconciliation.js';

/** One attempt. */
export type RetailReconciliationOperatorActionRow =
  typeof retailReconciliationOperatorActions.$inferSelect;

/** What one attempt states. Exactly one subject, by CHECK. */
export interface NewOperatorAction {
  action: RetailReconciliationOperatorAction;
  outcome: RetailReconciliationOperatorOutcome;
  actorOxyUserId: string;
  reason: string;
  orderId?: string;
  adjustmentId?: string;
  exceptionId?: string;
  /** Present exactly on a `refused` — a CHECK, both directions. */
  refusalDetail?: string;
  at?: Date;
}

/** Bound on a stored sentence — the same `.slice()` every provider string gets. */
const MAX_NOTE = 2_000;

/**
 * Record one attempt.
 *
 * Called on EVERY path through the operator surface, including the ones that
 * return early. A helper that only the success path remembered to call would
 * make the audit a record of what worked.
 */
export async function recordReconciliationOperatorAction(
  input: NewOperatorAction,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationOperatorActionRow> {
  const [row] = await db
    .insert(retailReconciliationOperatorActions)
    .values({
      id: uuidv7(),
      action: input.action,
      outcome: input.outcome,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason.slice(0, MAX_NOTE),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.adjustmentId ? { adjustmentId: input.adjustmentId } : {}),
      ...(input.exceptionId ? { exceptionId: input.exceptionId } : {}),
      ...(input.refusalDetail ? { refusalDetail: input.refusalDetail.slice(0, MAX_NOTE) } : {}),
      attemptedAt: input.at ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('The reconciliation operator-action insert returned no row.');
  return row;
}

/** Every attempt about one order, newest first — the trace's audit section. */
export async function listOperatorActionsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationOperatorActionRow[]> {
  return db
    .select()
    .from(retailReconciliationOperatorActions)
    .where(eq(retailReconciliationOperatorActions.orderId, orderId))
    .orderBy(desc(retailReconciliationOperatorActions.attemptedAt));
}

/** The most recent attempts across the whole surface. */
export async function listRecentOperatorActions(
  input: { limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationOperatorActionRow[]> {
  return db
    .select()
    .from(retailReconciliationOperatorActions)
    .orderBy(desc(retailReconciliationOperatorActions.attemptedAt))
    .limit(input.limit);
}

/** How many attempts of each outcome — the operator metrics' honesty check. */
export async function countOperatorActionsByOutcome(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ outcome: string; count: number }[]> {
  const rows = await db
    .select({
      outcome: retailReconciliationOperatorActions.outcome,
      total: sql<string>`count(*)`,
    })
    .from(retailReconciliationOperatorActions)
    .groupBy(retailReconciliationOperatorActions.outcome);
  // `count()` comes back from postgres.js as a STRING.
  return rows.map((row) => ({ outcome: row.outcome, count: Number(row.total) }));
}
