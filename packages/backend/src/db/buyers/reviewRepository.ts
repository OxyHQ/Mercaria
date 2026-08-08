/**
 * `reviews` — a verified buyer's review of ONE target: a listing, a store, or a
 * P2P seller.
 *
 * ## The target is THREE columns and exactly one of them is set
 *
 * Mongoose stated that in prose and enforced it nowhere, so a write naming both
 * a listing and a store was accepted and then read back by whichever query got
 * to it first. `reviews_target_exclusivity_check` makes it unrepresentable, which
 * means every write path has to satisfy it rather than merely intend to. That is
 * why {@link insertReview} takes ONE `targetId` plus its `targetType` and expands
 * them here — the two nulls are written explicitly, in the single module that
 * owns the layout, instead of being left to whatever the caller forgot to pass.
 * {@link targetColumn} is the same decision on the read side, so a filter cannot
 * disagree with the insert about which column holds the target.
 *
 * ## The aggregate is a filtered scan, deliberately NOT a correlated subquery
 *
 * `review.service.recomputeAggregate` recomputes one target at a time, so
 * {@link aggregatePublishedReviews} is a plain `WHERE`-filtered `avg`/`count`
 * over `reviews` alone. That matters: the correlated form — computing every
 * target's aggregate in one statement joined back to `listings`/`stores` — is
 * exactly the shape where a drizzle column interpolated into `sql` renders BARE
 * and silently compares two of the subquery's own columns, returning nothing with
 * no error at all. There is no correlation to qualify here because there is no
 * second table in the statement, and keeping it that way is the cheapest possible
 * defence against that bug. `db/__tests__/buyers.realdb.test.ts` still asserts a
 * NON-VACUOUS result both ways round (a target with reviews, and one whose
 * reviews are all `hidden`), because a single positive assertion cannot tell a
 * working aggregate from one that matches everything.
 *
 * `avg()` returns `numeric`, which postgres.js hands back as a STRING; the
 * `::double precision` cast is what makes the returned value the `number` the
 * rating arithmetic assumes. `count(*)::int` is the same fix for `bigint`.
 *
 * ## `hidden` is written from here and NOWHERE else
 *
 * {@link setReviewStatusIfIn} is the only status writer, and moderation
 * enforcement is its only caller. `review.service` exposes create and two list
 * functions and no update of any kind, so there is no seller-facing path that
 * could move a review OUT of `hidden` — the review equivalent of the escape
 * `catalog-write.service.updateListing` has to close for `restricted` does not
 * exist to be closed. Keep it that way: any future review-edit path must exclude
 * `status`, or it becomes one.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ReviewTargetType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { reviews } from '../schema/buyers.js';

/** One row of `reviews`. */
export type ReviewRecord = InferSelectModel<typeof reviews>;

/** A review target: its kind, and the id of the thing being reviewed. */
export interface ReviewTarget {
  targetType: ReviewTargetType;
  targetId: string;
}

/** The columns a caller may set when writing a review. */
export interface NewReview extends ReviewTarget {
  authorOxyUserId: string;
  orderId?: string;
  rating: number;
  title?: string;
  body?: string;
}

/** A page of reviews plus the total matching count, for an offset pager. */
export interface ReviewPageRows {
  rows: ReviewRecord[];
  total: number;
}

/** The one column that holds the target id for a target type. */
function targetColumn(targetType: ReviewTargetType): PgColumn {
  switch (targetType) {
    case 'listing':
      return reviews.listingId;
    case 'store':
      return reviews.storeId;
    case 'seller':
      return reviews.sellerOxyUserId;
  }
}

/**
 * The three target columns for one target — the matching one set, the other two
 * explicitly NULL.
 *
 * Written out rather than left to the column defaults so the row satisfies
 * `reviews_target_exclusivity_check` by construction, and so a future caller
 * reusing a partially-filled object cannot smuggle a second target in.
 */
function targetColumnValues(target: ReviewTarget): {
  listingId: string | null;
  storeId: string | null;
  sellerOxyUserId: string | null;
} {
  return {
    listingId: target.targetType === 'listing' ? target.targetId : null,
    storeId: target.targetType === 'store' ? target.targetId : null,
    sellerOxyUserId: target.targetType === 'seller' ? target.targetId : null,
  };
}

/** Reviews of one target, whatever their status. */
function targetFilter({ targetType, targetId }: ReviewTarget): SQL {
  return and(eq(reviews.targetType, targetType), eq(targetColumn(targetType), targetId)) as SQL;
}

/** PUBLISHED reviews of one target — what a public list and the aggregate both mean. */
function publishedTargetFilter(target: ReviewTarget): SQL {
  return and(targetFilter(target), eq(reviews.status, 'published')) as SQL;
}

/**
 * One review by id, or `null`.
 *
 * The moderation path's read: a CrowdSource case names a review by the id it was
 * reported under, with no owner to scope it to — a jury is not the author.
 */
export async function findReviewById(
  reviewId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRecord | null> {
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  return row ?? null;
}

/**
 * Move a review's status, but only from one of `allowedCurrent`, and only if it
 * would actually CHANGE.
 *
 * The mirror of `setListingStatusIfIn`, and it exists for the same reason: the
 * enforcement path depends on this being ONE conditional statement. `restrict`
 * must refuse a review someone else already hid, and a correction's `restore`
 * must refuse a review that is no longer hidden — a read-then-write would let two
 * deliveries of the same decision both believe they were the one that acted, and
 * the enforcement ledger would record two.
 *
 * `status <> next` reproduces Mongo's `modifiedCount === 1` exactly: a `$set` to
 * the value a document already holds matches but modifies nothing, and the
 * caller's "the review was already hidden" branch is written against that
 * distinction.
 *
 * @returns `true` when this call made the change, `false` when the guard refused.
 */
export async function setReviewStatusIfIn(
  reviewId: string,
  next: ReviewRecord['status'],
  allowedCurrent: readonly ReviewRecord['status'][],
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviews)
    .set({ status: next, updatedAt: new Date() })
    .where(
      and(
        eq(reviews.id, reviewId),
        inArray(reviews.status, [...allowedCurrent]),
        sql`${reviews.status} <> ${next}`,
      ),
    )
    .returning({ id: reviews.id });
  return rows.length > 0;
}

/**
 * Has this buyer already reviewed this target?
 *
 * Deliberately NOT filtered by status: a review a jury HID still counts as
 * already-reviewed, so hiding one cannot be used to buy a second attempt. For a
 * listing target `reviews_author_oxy_user_id_listing_id_key` says the same thing
 * as a constraint, and {@link insertReview} lets it — see there.
 */
export async function authorHasReviewedTarget(
  authorOxyUserId: string,
  target: ReviewTarget,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.authorOxyUserId, authorOxyUserId), targetFilter(target)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Write a review.
 *
 * `status` is left to the column default (`published`) rather than passed: the
 * DDL is the authority for it, and moderation is the only thing that ever sets
 * the other value.
 *
 * @throws A unique violation on `reviews_author_oxy_user_id_listing_id_key` when
 *   a concurrent write beat this one to the same (buyer, listing) pair. The
 *   caller maps it to the same CONFLICT its pre-check produces — the pre-check is
 *   the nice error, this is the one that actually holds.
 */
export async function insertReview(
  values: NewReview,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRecord> {
  const [row] = await db
    .insert(reviews)
    .values({
      authorOxyUserId: values.authorOxyUserId,
      targetType: values.targetType,
      ...targetColumnValues(values),
      orderId: values.orderId ?? null,
      rating: values.rating,
      title: values.title ?? null,
      body: values.body ?? null,
    })
    .returning();
  return row;
}

/**
 * The average rating and count of a target's PUBLISHED reviews.
 *
 * `average` is `null` when the target has none — the caller decides what an
 * unrated target's stored rating is, rather than this reporting a 0 that cannot
 * be told apart from a genuine 0.
 */
export async function aggregatePublishedReviews(
  target: ReviewTarget,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ average: number | null; count: number }> {
  const [row] = await db
    .select({
      average: sql<number | null>`avg(${reviews.rating})::double precision`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(publishedTargetFilter(target));
  return { average: row?.average ?? null, count: row?.count ?? 0 };
}

/**
 * A page of a target's PUBLISHED reviews, newest first, plus the total.
 *
 * The `id` tiebreaker is new. Mongo sorted on `createdAt` alone, which leaves
 * reviews written in the same millisecond in an order the server may choose
 * differently per query — so an offset pager could show one twice and skip
 * another. `id` is a uuid v7 here, whose time component agrees with `createdAt`,
 * so the tiebreak refines the intended order rather than fighting it.
 */
export async function findReviewsPage(
  target: ReviewTarget,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewPageRows> {
  const where = publishedTargetFilter(target);

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(reviews)
      .where(where)
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(reviews).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * A page of the PUBLISHED listing reviews across several listings — the store
 * review sheet, which shows the reviews of a store's PRODUCTS.
 *
 * `inArray` and not `= any(${ids})`: the latter binds a TUPLE and Postgres
 * refuses it with `op ANY/ALL (array) requires array on right side`.
 */
export async function findListingReviewsPage(
  listingIds: readonly string[],
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewPageRows> {
  if (listingIds.length === 0) return { rows: [], total: 0 };

  const where = and(
    eq(reviews.targetType, 'listing'),
    inArray(reviews.listingId, [...listingIds]),
    eq(reviews.status, 'published'),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(reviews)
      .where(where)
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(reviews).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * Every distinct target that has at least one PUBLISHED review — the work list
 * of the daily rating-drift sweep.
 *
 * The port of a `$group` whose `_id.targetId` was a `$switch` over the three
 * target columns. The `CASE` reads the same way and, unlike the Mongo original,
 * cannot produce a NULL target: `reviews_target_exclusivity_check` guarantees the
 * branch matching `target_type` is the one that is set, so the sweep's old
 * `if (!targetId) continue` guard has nothing left to skip and is gone with it.
 *
 * `SELECT DISTINCT` rather than a `GROUP BY`: the sweep wants the target SET, and
 * nothing downstream reads a count per target.
 */
export async function findPublishedReviewTargets(
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewTarget[]> {
  return db
    .selectDistinct({
      targetType: reviews.targetType,
      targetId: sql<string>`case ${reviews.targetType}
        when 'listing' then ${reviews.listingId}
        when 'store' then ${reviews.storeId}
        when 'seller' then ${reviews.sellerOxyUserId}
      end`,
    })
    .from(reviews)
    .where(eq(reviews.status, 'published'));
}
