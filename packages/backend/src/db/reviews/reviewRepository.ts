/**
 * `reviews` — one buyer's answer to ONE question about ONE target (#76).
 *
 * ## The target is SIX columns and exactly one of them is set
 *
 * Mongoose stated that in prose and enforced it nowhere, so a write naming both
 * a listing and a store was accepted and then read back by whichever query got
 * to it first. `reviews_target_exclusivity_check` makes it unrepresentable,
 * which means every write path has to satisfy it rather than merely intend to.
 * That is why {@link insertReview} takes ONE `targetId` plus its `targetType`
 * and expands them here — the five nulls are written explicitly, in the single
 * module that owns the layout, instead of being left to whatever the caller
 * forgot to pass. {@link targetColumn} is the same decision on the read side, so
 * a filter cannot disagree with the insert about which column holds the target.
 *
 * ## The aggregate is a filtered scan, deliberately NOT a correlated subquery
 *
 * The rebuild recomputes one target at a time, so {@link aggregatePublishedReviews}
 * and {@link aggregateScopedReviews} are plain `WHERE`-filtered `avg`/`count`
 * over `reviews` alone. That matters: the correlated form — computing every
 * target's aggregate in one statement joined back to `listings`/`stores` — is
 * exactly the shape where a drizzle column interpolated into `sql` renders BARE
 * and silently compares two of the subquery's own columns, returning nothing
 * with no error at all. There is no correlation to qualify here because there is
 * no second table in the statement, and keeping it that way is the cheapest
 * possible defence against that bug. `db/__tests__/buyers.realdb.test.ts` still
 * asserts a NON-VACUOUS result both ways round (a target with reviews, and one
 * whose reviews are all `hidden`), because a single positive assertion cannot
 * tell a working aggregate from one that matches everything.
 *
 * `avg()` returns `numeric`, which postgres.js hands back as a STRING; the
 * `::double precision` cast is what makes the returned value the `number` the
 * rating arithmetic assumes. `count(*)::int` is the same fix for `bigint`.
 *
 * ## `hidden` is written from here and NOWHERE else
 *
 * {@link setReviewStatusIfIn} is the only status writer, and moderation
 * enforcement is its only caller. `review.service` exposes create, two list
 * functions and no update of any kind, so there is no seller-facing path that
 * could move a review OUT of `hidden` — the review equivalent of the escape
 * `catalog-write.service.updateListing` has to close for `restricted` does not
 * exist to be closed. Keep it that way: any future review-edit path must exclude
 * `status`, or it becomes one.
 *
 * ## The scope is written HERE and by the classification job, never edited
 *
 * {@link classifyReview} and {@link markReviewAmbiguous} are the only writers of
 * `scope`/`classification_state` on an existing row,
 * {@link assignReviewToCanonicalProduct} the only writer that moves a scoped
 * target from this module, and each is paired with an append-only
 * `review_target_migrations` row by the service above. A review's scope is never
 * a function of what the caller passed in a PATCH, because no PATCH exists.
 *
 * A MERGE moves `canonical_product_id` through #59's own plan
 * (`merge-plan.ts`, phase `reviews`) rather than through this module — #56's
 * direct merge, and the `rehomeProductReviews` pair it called, were retired with
 * the endpoints (#36 completion criterion 4).
 */

import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  LEGACY_REVIEW_TARGET_TYPES,
  type ReviewAmbiguityReason,
  type ReviewClassificationState,
  type ReviewDimensionKey,
  type ReviewIncentiveDisclosure,
  type ReviewScope,
  type ReviewTargetType,
  type ReviewVerificationState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { reviewDimensions, reviews } from '../schema/reviews.js';

/** One row of `reviews`. */
export type ReviewRecord = InferSelectModel<typeof reviews>;

/** One row of `review_dimensions`. */
export type ReviewDimensionRecord = InferSelectModel<typeof reviewDimensions>;

/** A review target: its kind, and the id of the thing being reviewed. */
export interface ReviewTarget {
  targetType: ReviewTargetType;
  targetId: string;
}

/** A scoped review target — the question plus the thing. */
export interface ScopedReviewTarget {
  scope: ReviewScope;
  targetType: ReviewTargetType;
  targetId: string;
}

/** The columns a caller may set when writing a review. */
export interface NewReview extends ReviewTarget {
  authorOxyUserId: string;
  /** Absent on a legacy write; present on every #76 write. */
  scope?: ReviewScope;
  orderId?: string;
  orderItemId?: string;
  eligibilityId?: string;
  verification: ReviewVerificationState;
  rating: number;
  title?: string;
  body?: string;
  locale?: string;
  incentiveDisclosure: ReviewIncentiveDisclosure;
  classificationState: ReviewClassificationState;
  dimensions?: readonly { key: ReviewDimensionKey; rating: number }[];
}

/** A page of reviews plus the total matching count, for an offset pager. */
export interface ReviewPageRows {
  rows: ReviewRecord[];
  total: number;
}

/** Verified and unverified halves of one scoped aggregate, counted apart. */
export interface ScopedReviewCounts {
  verifiedAverage: number | null;
  verifiedCount: number;
  unverifiedAverage: number | null;
  unverifiedCount: number;
}

/** One dimension's derived aggregate. */
export interface DimensionCounts {
  key: ReviewDimensionKey;
  average: number;
  count: number;
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
    case 'canonical_product':
      return reviews.canonicalProductId;
    case 'merchant':
      return reviews.merchantId;
    case 'order_item':
      return reviews.orderItemId;
  }
}

/**
 * The six target columns for one target — the matching one set, the other five
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

/**
 * The scoped target a review row names, or `null` when it is still on a legacy
 * target with no scope.
 *
 * Exported because moderation needs it: hiding a review has to re-derive the
 * aggregate that review belonged to, and asking the row itself is the only way
 * to know which one that is without the caller reconstructing the mapping.
 */
export function scopedTargetOfReview(row: ReviewRecord): ScopedReviewTarget | null {
  if (!row.scope) return null;
  const targetId =
    row.canonicalProductId ??
    row.merchantId ??
    row.orderItemId ??
    row.listingId ??
    row.storeId ??
    row.sellerOxyUserId;
  return targetId ? { scope: row.scope, targetType: row.targetType, targetId } : null;
}

/** Reviews of one target, whatever their status. */
function targetFilter({ targetType, targetId }: ReviewTarget): SQL {
  return and(eq(reviews.targetType, targetType), eq(targetColumn(targetType), targetId)) as SQL;
}

/** PUBLISHED reviews of one target — what a public list and the aggregate both mean. */
function publishedTargetFilter(target: ReviewTarget): SQL {
  return and(targetFilter(target), eq(reviews.status, 'published')) as SQL;
}

/** PUBLISHED reviews of one SCOPED target — the scoped list and aggregate. */
function publishedScopedFilter(target: ScopedReviewTarget): SQL {
  return and(
    eq(reviews.scope, target.scope),
    eq(targetColumn(target.targetType), target.targetId),
    eq(reviews.status, 'published'),
  ) as SQL;
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
 * as a constraint, and so does `reviews_author_scope_target_key` for every
 * scoped one — see {@link insertReview}.
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
 * Write a review and its dimensions in ONE transaction.
 *
 * `status` is left to the column default (`published`) rather than passed: the
 * DDL is the authority for it, and moderation is the only thing that ever sets
 * the other value.
 *
 * The dimensions travel with the review because a review whose sub-ratings
 * committed separately could be read — and aggregated — half-written.
 *
 * @throws A unique violation on `reviews_author_oxy_user_id_listing_id_key` or
 *   `reviews_author_scope_target_key` when a concurrent write beat this one to
 *   the same (buyer, target) pair, and on `reviews_eligibility_id_key` when two
 *   writes raced to spend one eligibility. The caller maps each to the same
 *   CONFLICT its pre-check produces — the pre-check is the nice error, these are
 *   the ones that actually hold.
 */
export async function insertReview(
  values: NewReview,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRecord> {
  const write = async (tx: DatabaseOrTransaction): Promise<ReviewRecord> => {
    const [row] = await tx
      .insert(reviews)
      .values({
        authorOxyUserId: values.authorOxyUserId,
        targetType: values.targetType,
        scope: values.scope ?? null,
        ...targetColumnValues(values),
        orderId: values.orderId ?? null,
        eligibilityId: values.eligibilityId ?? null,
        verification: values.verification,
        rating: values.rating,
        title: values.title ?? null,
        body: values.body ?? null,
        locale: values.locale ?? null,
        incentiveDisclosure: values.incentiveDisclosure,
        classificationState: values.classificationState,
      })
      .returning();

    if (values.dimensions && values.dimensions.length > 0) {
      await tx.insert(reviewDimensions).values(
        values.dimensions.map((dimension) => ({
          reviewId: row.id,
          key: dimension.key,
          rating: dimension.rating,
        })),
      );
    }

    return row;
  };

  // `db` is already a transaction handle when a caller composed one; opening a
  // second would be a nested subtransaction for no reason.
  return 'transaction' in db && typeof db.transaction === 'function'
    ? await db.transaction(write)
    : await write(db);
}

/**
 * The average rating and count of a LEGACY target's PUBLISHED reviews.
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
 * The verified and unverified halves of a SCOPED target's published reviews,
 * counted apart in ONE pass.
 *
 * Two `filter (where …)` aggregates rather than two queries, so the two halves
 * are read from one snapshot: a review that flips status between them would
 * otherwise be counted twice or not at all, and the aggregate would be provably
 * wrong at exactly the moment a moderation action lands.
 *
 * There is deliberately no combined average here and no combined count. The
 * caller cannot blend them because this never hands it a total to blend.
 */
export async function aggregateScopedReviews(
  target: ScopedReviewTarget,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScopedReviewCounts> {
  const [row] = await db
    .select({
      verifiedAverage: sql<
        number | null
      >`avg(${reviews.rating}) filter (where ${reviews.verification} = 'verified_purchase')::double precision`,
      verifiedCount: sql<
        number
      >`count(*) filter (where ${reviews.verification} = 'verified_purchase')::int`,
      unverifiedAverage: sql<
        number | null
      >`avg(${reviews.rating}) filter (where ${reviews.verification} = 'unverified')::double precision`,
      unverifiedCount: sql<
        number
      >`count(*) filter (where ${reviews.verification} = 'unverified')::int`,
    })
    .from(reviews)
    .where(publishedScopedFilter(target));

  return {
    verifiedAverage: row?.verifiedAverage ?? null,
    verifiedCount: row?.verifiedCount ?? 0,
    unverifiedAverage: row?.unverifiedAverage ?? null,
    unverifiedCount: row?.unverifiedCount ?? 0,
  };
}

/**
 * Per-dimension averages over a scoped target's VERIFIED published reviews.
 *
 * Verified only, and deliberately: a dimension average is the most granular
 * public claim this domain makes, and blending an unbacked one into it would
 * defeat the split the headline rating is careful to keep.
 */
export async function aggregateScopedDimensions(
  target: ScopedReviewTarget,
  db: DatabaseOrTransaction = getDb(),
): Promise<DimensionCounts[]> {
  return db
    .select({
      key: reviewDimensions.key,
      average: sql<number>`avg(${reviewDimensions.rating})::double precision`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewDimensions)
    .innerJoin(reviews, eq(reviewDimensions.reviewId, reviews.id))
    .where(and(publishedScopedFilter(target), eq(reviews.verification, 'verified_purchase')))
    .groupBy(reviewDimensions.key);
}

/** The dimension rows of a set of reviews, for hydrating a page of DTOs. */
export async function findDimensionsForReviews(
  reviewIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewDimensionRecord[]> {
  if (reviewIds.length === 0) return [];
  return db
    .select()
    .from(reviewDimensions)
    .where(inArray(reviewDimensions.reviewId, [...reviewIds]));
}

/**
 * A page of a LEGACY target's PUBLISHED reviews, newest first, plus the total.
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
  return pageOf(publishedTargetFilter(target), page, limit, db);
}

/** A page of a SCOPED target's PUBLISHED reviews, newest first, plus the total. */
export async function findScopedReviewsPage(
  target: ScopedReviewTarget,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewPageRows> {
  return pageOf(publishedScopedFilter(target), page, limit, db);
}

/** The shared body of the two paged reads above. */
async function pageOf(
  where: SQL,
  page: number,
  limit: number,
  db: DatabaseOrTransaction,
): Promise<ReviewPageRows> {
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

  return pageOf(
    and(
      eq(reviews.targetType, 'listing'),
      inArray(reviews.listingId, [...listingIds]),
      eq(reviews.status, 'published'),
    ) as SQL,
    page,
    limit,
    db,
  );
}

/**
 * Every distinct LEGACY target that has at least one PUBLISHED review — the work
 * list of the legacy rating sweep.
 *
 * Scoped rows are excluded: their aggregates live in `review_aggregates` and are
 * rebuilt by {@link findScopedReviewTargets}, so including them here would give
 * one review two rebuild paths writing two different tables from two different
 * queries — which is exactly the drift this domain exists to prevent.
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
    .where(and(eq(reviews.status, 'published'), isNull(reviews.scope)));
}

/**
 * Every distinct SCOPED target that has at least one PUBLISHED review — the
 * rebuild sweep's work list, ordered so a bounded run can resume.
 *
 * `target_key` orders the cursor rather than `created_at`: the sweep walks
 * TARGETS, and a target's identity is stable while its newest review's timestamp
 * is not, so a timestamp cursor could revisit a target forever while a new review
 * arrived.
 */
export async function findScopedReviewTargets(
  afterTargetKey: string | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<(ScopedReviewTarget & { targetKey: string })[]> {
  const rows = await db
    .selectDistinct({
      scope: reviews.scope,
      targetType: reviews.targetType,
      targetKey: reviews.targetKey,
      targetId: sql<string>`case ${reviews.targetType}
        when 'listing' then ${reviews.listingId}
        when 'store' then ${reviews.storeId}
        when 'seller' then ${reviews.sellerOxyUserId}
        when 'canonical_product' then ${reviews.canonicalProductId}
        when 'merchant' then ${reviews.merchantId}
        when 'order_item' then ${reviews.orderItemId}
      end`,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.status, 'published'),
        sql`${reviews.scope} is not null`,
        afterTargetKey === null ? undefined : gt(reviews.targetKey, afterTargetKey),
      ),
    )
    .orderBy(asc(reviews.targetKey))
    .limit(limit);

  // `scope` is nullable in the column type and non-null in every row this
  // predicate can return. Narrowed rather than asserted — the `!` this repo
  // forbids would be exactly the shape that survives a later predicate edit.
  return rows.flatMap((row) =>
    row.scope === null ? [] : [{ ...row, scope: row.scope, targetId: row.targetId }],
  );
}

/**
 * A bounded batch of LEGACY reviews the classification job has not examined,
 * oldest first.
 *
 * `unclassified` only — not `ambiguous`. A review the job already looked at and
 * refused must not be re-examined every run: it needs the missing FACT to
 * arrive, and when it does the operator path (or a re-run with the flag) picks
 * it up deliberately. Cursoring on `created_at` plus `id` is safe here because
 * a classified row leaves the predicate for good.
 */
export async function findUnclassifiedLegacyReviews(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRecord[]> {
  return db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.classificationState, 'unclassified'),
        inArray(reviews.targetType, [...LEGACY_REVIEW_TARGET_TYPES]),
      ),
    )
    .orderBy(asc(reviews.createdAt), asc(reviews.id))
    .limit(limit);
}

/** Reviews previously refused, for a re-examination run once a fact has landed. */
export async function findAmbiguousReviews(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRecord[]> {
  return db
    .select()
    .from(reviews)
    .where(eq(reviews.classificationState, 'ambiguous'))
    .orderBy(asc(reviews.createdAt), asc(reviews.id))
    .limit(limit);
}

/**
 * Give an unclassified review a scope, in ONE conditional statement.
 *
 * The predicate carries `classification_state = 'unclassified'` so two runs of
 * the job cannot both believe they classified the row — the same reasoning as
 * `setReviewStatusIfIn`, and the reason the caller can write its append-only
 * migration row off this boolean rather than off a read it did earlier.
 *
 * The target columns move together with the scope: a `store` review becoming a
 * `merchant` review clears `store_id` in the same statement that sets
 * `merchant_id`, because `reviews_target_exclusivity_check` refuses any
 * intermediate state and there is no order in which two statements could get
 * there.
 *
 * @returns `true` when this call made the change.
 */
export async function classifyReview(
  reviewId: string,
  target: ScopedReviewTarget,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviews)
    .set({
      scope: target.scope,
      targetType: target.targetType,
      ...targetColumnValues(target),
      classificationState: 'classified',
      ambiguityReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(reviews.id, reviewId), eq(reviews.classificationState, 'unclassified')))
    .returning({ id: reviews.id });
  return rows.length > 0;
}

/**
 * Record that classification EXAMINED this review and could not decide.
 *
 * The review stays on its legacy target and keeps reading exactly as it does
 * today — "leave it on the legacy target until resolved" is implemented by
 * changing nothing about where it points.
 */
export async function markReviewAmbiguous(
  reviewId: string,
  reason: ReviewAmbiguityReason,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviews)
    .set({ classificationState: 'ambiguous', ambiguityReason: reason, updatedAt: new Date() })
    .where(and(eq(reviews.id, reviewId), eq(reviews.classificationState, 'unclassified')))
    .returning({ id: reviews.id });
  return rows.length > 0;
}

/**
 * Move ONE review to an explicitly assigned canonical product — a SPLIT.
 *
 * A split cannot be inferred (that is why #76 requires explicit assignment), so
 * this takes one review and one destination and refuses to guess a set. The
 * predicate pins the CURRENT product so a stale operator decision, taken against
 * a page rendered before somebody else moved the review, changes nothing.
 */
export async function assignReviewToCanonicalProduct(
  reviewId: string,
  fromCanonicalProductId: string,
  toCanonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviews)
    .set({ canonicalProductId: toCanonicalProductId, updatedAt: new Date() })
    .where(
      and(
        eq(reviews.id, reviewId),
        eq(reviews.scope, 'product'),
        eq(reviews.canonicalProductId, fromCanonicalProductId),
      ),
    )
    .returning({ id: reviews.id });
  return rows.length > 0;
}
