/**
 * `review_aggregates` + `review_dimension_aggregates` — the ONE authority for a
 * scoped rating (#76).
 *
 * ## The upsert is absolute, never a delta
 *
 * {@link upsertAggregate} takes figures the caller DERIVED from review rows and
 * SETs them. There is deliberately no increment path: a counter maintained by
 * deltas drifts the first time a write is lost, retried or rolled back, and
 * "detect drift" then means comparing a number to itself. Deriving is what makes
 * the rebuild idempotent, and idempotence is what lets moderation call it after
 * hiding a review without knowing whether anything else already did.
 *
 * ## The dimension rows are replaced, not merged
 *
 * A dimension that no published verified review supplies any more must
 * DISAPPEAR, not linger at its last value. Merging would leave it. So the
 * rebuild deletes the aggregate's dimension rows and writes the derived set in
 * the same transaction — the whole aggregate is one atomic statement of what the
 * reviews currently say.
 */

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ReviewDimensionKey, ReviewScope, ReviewTargetType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { reviewAggregates, reviewDimensionAggregates } from '../schema/reviews.js';

/** One row of `review_aggregates`. */
export type ReviewAggregateRecord = InferSelectModel<typeof reviewAggregates>;

/** One row of `review_dimension_aggregates`. */
export type ReviewDimensionAggregateRecord = InferSelectModel<typeof reviewDimensionAggregates>;

/** The derived figures one rebuild writes. */
export interface AggregateFigures {
  scope: ReviewScope;
  targetType: ReviewTargetType;
  targetId: string;
  rating: number;
  reviewCount: number;
  unverifiedRating: number;
  unverifiedCount: number;
  dimensions: readonly { key: ReviewDimensionKey; rating: number; count: number }[];
}

/** The six target columns, the matching one set and the other five NULL. */
function targetColumnValues(target: { targetType: ReviewTargetType; targetId: string }): {
  listingId: string | null;
  storeId: string | null;
  sellerOxyUserId: string | null;
  canonicalProductId: string | null;
  merchantId: string | null;
  orderItemId: string | null;
} {
  return {
    listingId: target.targetType === 'listing' ? target.targetId : null,
    storeId: target.targetType === 'store' ? target.targetId : null,
    sellerOxyUserId: target.targetType === 'seller' ? target.targetId : null,
    canonicalProductId: target.targetType === 'canonical_product' ? target.targetId : null,
    merchantId: target.targetType === 'merchant' ? target.targetId : null,
    orderItemId: target.targetType === 'order_item' ? target.targetId : null,
  };
}

/** The column holding a target id for a target type. */
function aggregateTargetColumn(targetType: ReviewTargetType) {
  switch (targetType) {
    case 'listing':
      return reviewAggregates.listingId;
    case 'store':
      return reviewAggregates.storeId;
    case 'seller':
      return reviewAggregates.sellerOxyUserId;
    case 'canonical_product':
      return reviewAggregates.canonicalProductId;
    case 'merchant':
      return reviewAggregates.merchantId;
    case 'order_item':
      return reviewAggregates.orderItemId;
  }
}

/** One scoped aggregate, or `null`. */
export async function findAggregate(
  scope: ReviewScope,
  targetType: ReviewTargetType,
  targetId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewAggregateRecord | null> {
  const [row] = await db
    .select()
    .from(reviewAggregates)
    .where(and(eq(reviewAggregates.scope, scope), eq(aggregateTargetColumn(targetType), targetId)))
    .limit(1);
  return row ?? null;
}

/** Several scoped aggregates in one read — a product page listing many targets. */
export async function findAggregatesForTargets(
  scope: ReviewScope,
  targetType: ReviewTargetType,
  targetIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewAggregateRecord[]> {
  if (targetIds.length === 0) return [];
  return db
    .select()
    .from(reviewAggregates)
    .where(
      and(
        eq(reviewAggregates.scope, scope),
        inArray(aggregateTargetColumn(targetType), [...targetIds]),
      ),
    );
}

/** The dimension rows of a set of aggregates. */
export async function findDimensionAggregates(
  aggregateIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewDimensionAggregateRecord[]> {
  if (aggregateIds.length === 0) return [];
  return db
    .select()
    .from(reviewDimensionAggregates)
    .where(inArray(reviewDimensionAggregates.aggregateId, [...aggregateIds]));
}

/**
 * Write the derived figures, creating the aggregate row if it is the target's
 * first, and replace its dimension rows — all in ONE transaction.
 *
 * `ON CONFLICT (scope, target_key) DO UPDATE` and not a read-then-write: two
 * rebuilds of one target run concurrently the first time a review is written
 * while the sweep is walking past, and the read-then-write form loses one of
 * them. `target_key` is GENERATED, so the conflict target names it rather than
 * the six nullable columns Postgres would treat as distinct.
 *
 * @returns the stored row AFTER the write.
 */
export async function upsertAggregate(
  figures: AggregateFigures,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewAggregateRecord> {
  const write = async (tx: DatabaseOrTransaction): Promise<ReviewAggregateRecord> => {
    const now = new Date();
    const [row] = await tx
      .insert(reviewAggregates)
      .values({
        scope: figures.scope,
        targetType: figures.targetType,
        ...targetColumnValues(figures),
        rating: figures.rating,
        reviewCount: figures.reviewCount,
        unverifiedRating: figures.unverifiedRating,
        unverifiedCount: figures.unverifiedCount,
        lastRebuiltAt: now,
      })
      .onConflictDoUpdate({
        target: [reviewAggregates.scope, reviewAggregates.targetKey],
        set: {
          rating: figures.rating,
          reviewCount: figures.reviewCount,
          unverifiedRating: figures.unverifiedRating,
          unverifiedCount: figures.unverifiedCount,
          lastRebuiltAt: now,
          updatedAt: now,
        },
      })
      .returning();

    // Replaced, not merged — see the module header.
    await tx
      .delete(reviewDimensionAggregates)
      .where(eq(reviewDimensionAggregates.aggregateId, row.id));

    if (figures.dimensions.length > 0) {
      await tx.insert(reviewDimensionAggregates).values(
        figures.dimensions.map((dimension) => ({
          aggregateId: row.id,
          key: dimension.key,
          rating: dimension.rating,
          count: dimension.count,
        })),
      );
    }

    return row;
  };

  return 'transaction' in db && typeof db.transaction === 'function'
    ? await db.transaction(write)
    : await write(db);
}

/**
 * A bounded page of aggregates the rebuild has not touched recently, oldest
 * first, NULLs first.
 *
 * The sweep's other half: {@link findScopedReviewTargets} finds targets that
 * HAVE reviews, this finds aggregate rows that exist. A target whose last review
 * was deleted appears only here, and it is exactly the row that would otherwise
 * keep claiming a rating forever.
 */
export async function findStaleAggregates(
  before: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewAggregateRecord[]> {
  return db
    .select()
    .from(reviewAggregates)
    .where(
      or(
        isNull(reviewAggregates.lastRebuiltAt),
        sql`${reviewAggregates.lastRebuiltAt} < ${before.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(reviewAggregates.lastRebuiltAt), asc(reviewAggregates.id))
    .limit(limit);
}
