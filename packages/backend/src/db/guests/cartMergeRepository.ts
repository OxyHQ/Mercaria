/**
 * Reads and writes on `cart_merges` — the durable, append-only record of one
 * guest→Oxy cart merge (#104).
 *
 * The table is INSERT-only (a trigger refuses UPDATE and DELETE), so there is
 * exactly one writer here and it takes the FINAL counts. Nothing accumulates
 * across statements: the merge computes what it did and records it once, inside
 * the same transaction, which is why a crashed merge leaves no half-counted row
 * to reconcile.
 *
 * `insertCartMerge` uses `ON CONFLICT DO NOTHING` on `guest_session_id` and
 * reports the empty result as "already merged". The merge transaction holds
 * `FOR UPDATE` on the session row, so a conflict here should be unreachable —
 * it is the structural backstop for the day a refactor drops that lock, and it
 * is the reason a lost race converges instead of raising a 500 at a buyer who
 * merely tapped twice.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { CartMergeReasonCode } from '@mercaria/shared-types';
import { cartMerges } from '../schema/guests.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One row of `cart_merges`. */
export type CartMergeRow = typeof cartMerges.$inferSelect;

/** The final counts a merge records. Written once; never updated. */
export interface InsertCartMergeInput {
  guestSessionId: string;
  oxyUserId: string;
  targetCartId: string;
  linesAdded: number;
  linesCombined: number;
  linesClamped: number;
  linesFlagged: number;
  discountCodesAdded: number;
  discountCodesDropped: number;
  /** Bounded codes; the caller sorts and deduplicates before calling. */
  reasons: readonly CartMergeReasonCode[];
}

/**
 * Record a merge. Returns the row, or `undefined` when this guest session was
 * already merged (the unique index refused the second insert).
 */
export async function insertCartMerge(
  tx: DatabaseOrTransaction,
  input: InsertCartMergeInput,
): Promise<CartMergeRow | undefined> {
  const [row] = await tx
    .insert(cartMerges)
    .values({ ...input, reasons: [...input.reasons] })
    .onConflictDoNothing({ target: cartMerges.guestSessionId })
    .returning();
  return row;
}

/** The merge recorded for a guest session, if any. */
export async function findCartMergeByGuestSession(
  db: DatabaseOrTransaction,
  guestSessionId: string,
): Promise<CartMergeRow | undefined> {
  const [row] = await db
    .select()
    .from(cartMerges)
    .where(eq(cartMerges.guestSessionId, guestSessionId))
    .limit(1);
  return row;
}

/**
 * The merges an operator asked to see, newest first.
 *
 * Both handles are INTERNAL correlation ids the operator already holds — a
 * guest session row id or an Oxy account id — and neither is a credential:
 * possession of a token is what authorizes a guest, and no token is stored
 * anywhere in this table to leak.
 */
export async function findCartMerges(
  filter: { guestSessionId?: string; oxyUserId?: string },
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartMergeRow[]> {
  const predicates = [
    ...(filter.guestSessionId === undefined
      ? []
      : [eq(cartMerges.guestSessionId, filter.guestSessionId)]),
    ...(filter.oxyUserId === undefined ? [] : [eq(cartMerges.oxyUserId, filter.oxyUserId)]),
  ];
  if (predicates.length === 0) {
    // Refused rather than answered with "every merge ever": the diagnostic is
    // keyed BY a correlation id (#104 idempotency requirement 8), and an
    // unfiltered dump would be a different power than the one this surface has.
    throw new Error('findCartMerges requires at least one correlation filter');
  }
  return db
    .select()
    .from(cartMerges)
    .where(predicates.length === 1 ? predicates[0] : and(...predicates))
    .orderBy(desc(cartMerges.createdAt))
    .limit(limit);
}

/** How many merges have ever been recorded. A count, never contents. */
export async function countCartMerges(db: DatabaseOrTransaction = getDb()): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(cartMerges);
  return row?.count ?? 0;
}
