/**
 * `price_signal_feedback` — merchant correction reports (#82 monitoring 4).
 *
 * A merchant filing the same complaint twice converges on ONE open row, held by
 * the partial unique rather than by a read-then-write: two taps and a retry after
 * a timeout the client never saw are the two cases a read-then-write loses, and
 * they are the two that happen.
 */

import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { priceSignalFeedback } from '../schema/priceSignals.js';

export type PriceSignalFeedbackRow = typeof priceSignalFeedback.$inferSelect;
export type InsertPriceSignalFeedback = typeof priceSignalFeedback.$inferInsert;

/**
 * File a report, or converge on the open one that already says this.
 *
 * `ON CONFLICT DO NOTHING` plus a read, the `guest_checkouts` shape: a second
 * submission carrying a different NOTE must not overwrite the note an operator
 * may already be working from.
 */
export async function fileOrFindOpenPriceSignalFeedback(
  values: InsertPriceSignalFeedback,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalFeedbackRow> {
  const inserted = await db
    .insert(priceSignalFeedback)
    .values(values)
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row !== undefined) return row;

  const existing = await db
    .select()
    .from(priceSignalFeedback)
    .where(
      and(
        eq(priceSignalFeedback.merchantId, values.merchantId),
        eq(priceSignalFeedback.signalKind, values.signalKind),
        isNull(priceSignalFeedback.resolvedAt),
        sql`${priceSignalFeedback.subjectKey} = coalesce(${values.canonicalProductId ?? null}::text, '') || '|' ||
            coalesce(${values.canonicalVariantId ?? null}::text, '') || '|' || ${values.segment} || '|' ||
            coalesce(${values.market ?? null}::text, '') || '|' || ${values.displayCurrency}`,
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found === undefined) {
    // Not reachable through the unique — the insert was refused, so a matching
    // open row exists. Written out rather than asserted, because a non-null
    // assertion is forbidden and a silent `undefined` here would surface as a
    // 500 with no explanation.
    throw new Error('fileOrFindOpenPriceSignalFeedback: conflict with no matching open report.');
  }
  return found;
}

/** One merchant's reports, newest first. */
export async function listPriceSignalFeedbackForMerchant(
  merchantId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalFeedbackRow[]> {
  return db
    .select()
    .from(priceSignalFeedback)
    .where(eq(priceSignalFeedback.merchantId, merchantId))
    .orderBy(desc(priceSignalFeedback.createdAt))
    .limit(limit);
}

/** Every open report, for the operator queue. */
export async function listOpenPriceSignalFeedback(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalFeedbackRow[]> {
  return db
    .select()
    .from(priceSignalFeedback)
    .where(isNull(priceSignalFeedback.resolvedAt))
    .orderBy(desc(priceSignalFeedback.createdAt))
    .limit(limit);
}

/**
 * Close a report as resolved or rejected.
 *
 * The two are kept apart because the CORRECTION RATE monitoring 4 exists to
 * produce is the ratio between them, and one `closed` state would make it
 * unreadable. The CAS on `resolved_at IS NULL` is what makes a second close
 * converge rather than overwrite the first operator's reason.
 */
export async function closePriceSignalFeedback(
  input: {
    readonly id: string;
    readonly status: 'resolved' | 'rejected';
    readonly resolvedByOxyUserId: string;
    readonly resolutionNote?: string;
    readonly now: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalFeedbackRow | undefined> {
  const rows = await db
    .update(priceSignalFeedback)
    .set({
      status: input.status,
      resolvedByOxyUserId: input.resolvedByOxyUserId,
      resolvedAt: input.now,
      ...(input.resolutionNote === undefined ? {} : { resolutionNote: input.resolutionNote }),
    })
    .where(and(eq(priceSignalFeedback.id, input.id), isNull(priceSignalFeedback.resolvedAt)))
    .returning();
  return rows[0];
}

/** The correction-report counts monitoring 4 reports, by reason and by outcome. */
export async function summarizePriceSignalFeedback(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ reason: string; status: string; total: number }[]> {
  return db
    .select({
      reason: priceSignalFeedback.reason,
      status: priceSignalFeedback.status,
      total: count(),
    })
    .from(priceSignalFeedback)
    .groupBy(priceSignalFeedback.reason, priceSignalFeedback.status);
}
