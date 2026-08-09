/**
 * Scoped rating aggregates (#76): derive, project, rebuild, detect drift.
 *
 * ## Everything here DERIVES; nothing increments
 *
 * {@link rebuildScopedAggregate} reads the review rows and SETs the answer. It
 * is therefore idempotent, which is what lets moderation call it after hiding a
 * review without knowing whether the sweep already did, and what makes "hidden
 * reviews leave aggregate counts and ratings" (#76 moderation rule 3) true by
 * construction rather than by a decrement somebody has to remember.
 *
 * ## Verified and unverified never blend
 *
 * The derived figures come back from ONE query with two `filter (where …)`
 * aggregates, and they are stored in two column pairs. There is no combined
 * average anywhere in this file, no combined count, and
 * {@link toScopedAggregateDTO} emits none — so a serializer that wanted to blend
 * them would have to compute the blend itself, in the open.
 *
 * ## The projection, and why it is not a second representation
 *
 * `canonical_products.rating`, `merchants.rating`, `listings.rating` and
 * `seller_profiles.rating` are PROJECTIONS of the aggregate row: written here,
 * in the same call, from the same derived figures, by the only writer any of
 * them has. A projection with one writer cannot disagree with its source; a
 * second WRITER could, which is why `recomputeAggregate`'s legacy path and this
 * one are careful never to cover the same rows (see there).
 *
 * ## The native store's rating comes from ONE place
 *
 * {@link resolveStoreRatingSource} returns EITHER the merchant aggregate (when
 * the store resolves to a canonical merchant) OR the legacy store aggregate —
 * one value, from one function, naming which it is. That is #76 migration rule 6
 * ("must not double-count one review in two public aggregates") answered
 * structurally: there is no code path that can add them, because nothing ever
 * holds both.
 */

import type {
  ReviewAggregateDrift,
  ReviewAggregateRebuildReport,
  ReviewDimensionAggregate,
  ReviewScope,
  ReviewTargetType,
  ScopedRatingAggregate,
  StoreRatingSource,
} from '@mercaria/shared-types';
import {
  findAggregate,
  findDimensionAggregates,
  findStaleAggregates,
  upsertAggregate,
  type ReviewAggregateRecord,
} from '../../db/reviews/reviewAggregateRepository.js';
import {
  aggregateScopedDimensions,
  aggregateScopedReviews,
  findScopedReviewTargets,
} from '../../db/reviews/reviewRepository.js';
import { setListingRating } from '../../db/catalog/listingRepository.js';
import { setSellerRating } from '../../db/buyers/sellerProfileRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { setCanonicalProductRating } from '../../db/canonical/canonicalProductRepository.js';
import { setMerchantRating } from '../../db/commerce-graph/merchantRepository.js';
import { findMerchantIdForStore } from '../../db/reviews/reviewTargetResolver.js';
import { getDb } from '../../db/postgres.js';
import { SCOPES_WITH_ENTITY_PROJECTION, targetTypeForScope } from './review-scope.js';
import { log } from '../../lib/logger.js';

/** Average rating rounded to ONE decimal place. */
function roundRating(average: number): number {
  return Math.round(average * 10) / 10;
}

/**
 * How many aggregates one bounded sweep run touches.
 *
 * Bounded so a run has a predictable ceiling on a shared Postgres, and resumable
 * so the ceiling costs nothing — the caller loops on `hasMore`, or the next
 * scheduled run picks up where this one stopped.
 */
const REBUILD_BATCH_SIZE = 200;

/** Serialize a stored aggregate plus its dimensions for the wire. */
export function toScopedAggregateDTO(
  row: ReviewAggregateRecord,
  targetId: string,
  dimensions: readonly { key: ReviewDimensionAggregate['key']; rating: number; count: number }[],
): ScopedRatingAggregate {
  const dto: ScopedRatingAggregate = {
    scope: row.scope,
    targetType: row.targetType,
    targetId,
    rating: row.rating,
    reviewCount: row.reviewCount,
    unverified: { rating: row.unverifiedRating, count: row.unverifiedCount },
    dimensions: dimensions.map((dimension) => ({
      key: dimension.key,
      rating: dimension.rating,
      count: dimension.count,
    })),
  };
  if (row.lastRebuiltAt) dto.lastRebuiltAt = row.lastRebuiltAt.toISOString();
  return dto;
}

/**
 * Write the aggregate onto the target ENTITY's own denormalized rating columns.
 *
 * The verified figures only. An entity's headline star rating is the public
 * claim a buyer reads at a glance, and #76 verification rule 5 says an unbacked
 * review is weighted separately — a projection that blended them would undo that
 * everywhere the aggregate row is not read directly.
 *
 * `native_transaction` has no projection: an order line has no rating column,
 * and adding one would turn one buyer's private transaction review into a public
 * star rating on their purchase.
 */
async function projectOntoEntity(
  scope: ReviewScope,
  targetId: string,
  rating: number,
  reviewCount: number,
): Promise<void> {
  if (!SCOPES_WITH_ENTITY_PROJECTION.includes(scope)) return;

  switch (scope) {
    case 'product':
      await setCanonicalProductRating(getDb(), targetId, rating, reviewCount);
      return;
    case 'merchant':
      await setMerchantRating(getDb(), targetId, rating, reviewCount);
      return;
    case 'p2p_listing':
      await setListingRating(targetId, rating, reviewCount);
      return;
    case 'p2p_seller':
      // Upserting: a seller's first review can arrive before anything else has
      // created their profile, exactly as the legacy path allowed.
      await setSellerRating(targetId, rating, reviewCount);
      return;
    case 'native_transaction':
      return;
  }
}

/**
 * Derive one scoped aggregate from the review rows, store it, and project it.
 *
 * Idempotent: two calls with no review change in between produce the same
 * stored row. Safe to call from a review write, from moderation enforcement,
 * from a product merge and from the sweep.
 *
 * @returns the stored figures plus whatever the row previously claimed, so the
 *   caller can report drift without a second read.
 */
export async function rebuildScopedAggregate(
  scope: ReviewScope,
  targetId: string,
): Promise<{ aggregate: ScopedRatingAggregate; drift: ReviewAggregateDrift | null }> {
  const targetType = targetTypeForScope(scope);
  const target = { scope, targetType, targetId };

  const [previous, counts, dimensions] = await Promise.all([
    findAggregate(scope, targetType, targetId),
    aggregateScopedReviews(target),
    aggregateScopedDimensions(target),
  ]);

  // `average: null` means "no reviews", which is not the same fact as "an
  // average of zero" — so the zero is written deliberately here rather than
  // inherited from an aggregate that could not tell them apart.
  const rating =
    counts.verifiedAverage !== null && counts.verifiedCount > 0
      ? roundRating(counts.verifiedAverage)
      : 0;
  const unverifiedRating =
    counts.unverifiedAverage !== null && counts.unverifiedCount > 0
      ? roundRating(counts.unverifiedAverage)
      : 0;

  const derivedDimensions = dimensions.map((dimension) => ({
    key: dimension.key,
    rating: roundRating(dimension.average),
    count: dimension.count,
  }));

  const row = await upsertAggregate({
    scope,
    targetType,
    targetId,
    rating,
    reviewCount: counts.verifiedCount,
    unverifiedRating,
    unverifiedCount: counts.unverifiedCount,
    dimensions: derivedDimensions,
  });

  await projectOntoEntity(scope, targetId, rating, counts.verifiedCount);

  const drift =
    previous && (previous.rating !== rating || previous.reviewCount !== counts.verifiedCount)
      ? {
          scope,
          targetId,
          storedRating: previous.rating,
          storedReviewCount: previous.reviewCount,
          derivedRating: rating,
          derivedReviewCount: counts.verifiedCount,
        }
      : null;

  return {
    aggregate: toScopedAggregateDTO(row, targetId, derivedDimensions),
    drift,
  };
}

/** Read one scoped aggregate for display; `null` when the target has none. */
export async function getScopedAggregate(
  scope: ReviewScope,
  targetId: string,
): Promise<ScopedRatingAggregate | null> {
  const row = await findAggregate(scope, targetTypeForScope(scope), targetId);
  if (!row) return null;
  const dimensions = await findDimensionAggregates([row.id]);
  return toScopedAggregateDTO(row, targetId, dimensions);
}

/**
 * The scoped aggregate a page shows, computing it on the spot when no row exists
 * yet.
 *
 * #75 will render structured data from whatever a page displays, and its
 * acceptance is that the two MATCH. So the read path never falls back to a
 * different number or to a legacy column: it either finds the aggregate for
 * exactly this (scope, target) or derives that same aggregate, and a page with
 * no reviews gets a zero that names its scope rather than a borrowed figure.
 */
export async function getOrBuildScopedAggregate(
  scope: ReviewScope,
  targetId: string,
): Promise<ScopedRatingAggregate> {
  const existing = await getScopedAggregate(scope, targetId);
  if (existing) return existing;
  const { aggregate } = await rebuildScopedAggregate(scope, targetId);
  return aggregate;
}

/**
 * Where a native store's PUBLIC rating comes from — and there is exactly one
 * answer.
 *
 * A store linked to a canonical merchant shows the MERCHANT aggregate, because
 * that is the actor buyers are rating and the link is what says the two are the
 * same actor (ADR 0002 D4). An unlinked store shows its own legacy aggregate.
 * Never both, never a sum: this function holds one value at a time and returns
 * it, so #76 migration rule 6 is not a rule anybody can forget.
 */
export async function resolveStoreRatingSource(storeId: string): Promise<StoreRatingSource | null> {
  const merchantId = await findMerchantIdForStore(storeId);
  if (merchantId) {
    const aggregate = await getScopedAggregate('merchant', merchantId);
    return {
      kind: 'merchant',
      merchantId,
      rating: aggregate?.rating ?? 0,
      reviewCount: aggregate?.reviewCount ?? 0,
    };
  }

  const store = await findStoreById(storeId);
  if (!store) return null;
  return { kind: 'legacy_store', rating: store.rating, reviewCount: store.reviewCount };
}

/**
 * One bounded, resumable pass of the rebuild sweep.
 *
 * TWO work lists, and both are needed:
 *
 *  - every scoped target that HAS published reviews, so a new one gets a row;
 *  - every existing aggregate row not rebuilt since `staleBefore`, so a target
 *    whose last review was hidden or deleted stops claiming a rating. That row
 *    appears in no review-derived list precisely because it has no reviews left,
 *    which is exactly what makes it the dangerous one.
 *
 * Drift is REPORTED, not swallowed: the sweep converges the stored figures (it
 * is the repair) and returns what it had to change, so a persistent disagreement
 * is visible as a number rather than as silence.
 */
export async function rebuildReviewAggregates(
  options: { afterTargetKey?: string; staleBefore?: Date; batchSize?: number } = {},
): Promise<ReviewAggregateRebuildReport & { nextTargetKey: string | null }> {
  const batchSize = options.batchSize ?? REBUILD_BATCH_SIZE;
  const staleBefore = options.staleBefore ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

  const targets = await findScopedReviewTargets(options.afterTargetKey ?? null, batchSize);
  const stale = await findStaleAggregates(staleBefore, batchSize);

  const seen = new Set<string>();
  const work: { scope: ReviewScope; targetId: string }[] = [];

  const push = (scope: ReviewScope, targetId: string): void => {
    const key = `${scope}|${targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    work.push({ scope, targetId });
  };

  for (const target of targets) push(target.scope, target.targetId);
  for (const row of stale) {
    const targetId = aggregateTargetIdOf(row);
    if (targetId) push(row.scope, targetId);
  }

  const drifted: ReviewAggregateDrift[] = [];
  for (const item of work) {
    try {
      const { drift } = await rebuildScopedAggregate(item.scope, item.targetId);
      if (drift) drifted.push(drift);
    } catch (err) {
      // One target's failure must not abandon the rest of the batch; the next
      // run retries it because nothing marked it done.
      log.general.warn(
        { err, scope: item.scope, targetId: item.targetId },
        'Review aggregate rebuild failed for one target (continuing)',
      );
    }
  }

  const last = targets.at(-1);
  return {
    scanned: work.length,
    drifted,
    hasMore: targets.length === batchSize,
    nextTargetKey: last?.targetKey ?? null,
  };
}

/** The set target id of an aggregate row, whichever of the six columns holds it. */
function aggregateTargetIdOf(row: ReviewAggregateRecord): string | null {
  return (
    row.canonicalProductId ??
    row.merchantId ??
    row.orderItemId ??
    row.listingId ??
    row.storeId ??
    row.sellerOxyUserId
  );
}

/** The target type of an aggregate row — used by the operator trace. */
export function aggregateTargetTypeOf(row: ReviewAggregateRecord): ReviewTargetType {
  return row.targetType;
}
