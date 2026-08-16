/**
 * The #76 scope migration: classify what can be classified, refuse what cannot,
 * and record every decision.
 *
 * ## Bounded, resumable, and it never guesses
 *
 * {@link classifyLegacyReviews} takes a batch ceiling and returns `hasMore`, the
 * shape every long-running job in this repo uses. Its cursor is the
 * `classification_state` column itself: a review leaves the `unclassified`
 * predicate the moment it is decided, so a re-run cannot revisit it and a crash
 * costs at most one batch. There is no offset and no stored cursor row to keep
 * honest.
 *
 * The classification table, in full:
 *
 * | legacy target | becomes | when |
 * |---|---|---|
 * | `seller` | `p2p_seller` | always — the target IS an Oxy seller id, and there is nothing to resolve |
 * | `listing` | `p2p_listing` | always — a listing review describes THAT listing's item, and its condition/description vocabulary is what #76 UI rule 5 asks for |
 * | `store` | `merchant` | only when the store has an ACTIVE `native_store_links` row |
 * | `store` | *(refused)* | otherwise — `store_has_no_linked_merchant` |
 *
 * Two of those look like they might be guesses and are not:
 *
 *  - A **listing** review is NOT promoted to `product`. A legacy listing review
 *    was written about one seller's item, and Mercaria cannot know whether the
 *    author meant the model or the copy that arrived. Reading it as a product
 *    review would put "arrived scratched" on a canonical product's quality
 *    rating — acceptance criterion 1, failed by exactly the inference this
 *    refuses to make. `p2p_listing` says precisely what the row is evidence of.
 *  - A **store** review with no merchant link is left where it is, with the
 *    reason recorded. That is migration rule 3's "leave it on the legacy target
 *    until resolved", and the legacy read path keeps serving it unchanged.
 *
 * ## Every decision is appended
 *
 * A classification and a refusal both write a `review_target_migrations` row in
 * the SAME transaction as the change, so a review's scope history is never a
 * function of what the current row happens to say. Replays converge on the
 * table's own unique index.
 */

import type {
  ReviewAmbiguityReason,
  ReviewClassificationReport,
  ReviewScope,
} from '@mercaria/shared-types';
import {
  classifyReview,
  findAmbiguousReviews,
  findUnclassifiedLegacyReviews,
  markReviewAmbiguous,
  assignReviewToCanonicalProduct,
  type ReviewRecord,
} from '../../db/reviews/reviewRepository.js';
import { recordTargetMigration } from '../../db/reviews/reviewMigrationRepository.js';
import { findMerchantIdForStore } from '../../db/reviews/reviewTargetResolver.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { rebuildScopedAggregate } from './review-aggregate.service.js';
import { scopedTarget } from './review-scope.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/** How many legacy reviews one bounded run examines. */
const CLASSIFY_BATCH_SIZE = 500;

/** What one review's classification resolved to, or why it did not. */
type Verdict =
  | { kind: 'classify'; scope: ReviewScope; targetId: string; reason: string }
  | { kind: 'refuse'; reason: ReviewAmbiguityReason };

/** The legacy target id a row currently carries, whichever column holds it. */
function legacyTargetRef(review: ReviewRecord): string | null {
  return review.listingId ?? review.storeId ?? review.sellerOxyUserId;
}

/**
 * Decide one legacy review, reading only facts — never the review's text, its
 * rating or its age.
 *
 * A rating-dependent rule ("a 1-star store review is probably about delivery")
 * would be a sentiment classifier deciding where somebody's words count, which
 * is the opposite of what #76 asks for.
 */
async function decide(review: ReviewRecord): Promise<Verdict> {
  switch (review.targetType) {
    case 'seller':
      return review.sellerOxyUserId
        ? {
            kind: 'classify',
            scope: 'p2p_seller',
            targetId: review.sellerOxyUserId,
            reason: 'a seller review is P2P seller reputation',
          }
        : { kind: 'refuse', reason: 'listing_no_longer_exists' };

    case 'listing':
      return review.listingId
        ? {
            kind: 'classify',
            scope: 'p2p_listing',
            targetId: review.listingId,
            reason: 'a listing review describes that listing, not the canonical product',
          }
        : { kind: 'refuse', reason: 'listing_no_longer_exists' };

    case 'store': {
      if (!review.storeId) return { kind: 'refuse', reason: 'store_has_no_linked_merchant' };
      const merchantId = await findMerchantIdForStore(review.storeId);
      return merchantId
        ? {
            kind: 'classify',
            scope: 'merchant',
            targetId: merchantId,
            reason: 'the store resolves to a canonical merchant through an active link',
          }
        : { kind: 'refuse', reason: 'store_has_no_linked_merchant' };
    }

    // A row already carrying a scoped target type cannot be in the
    // `unclassified` predicate — `reviews_classification_consistency_check`
    // makes that unrepresentable — so these branches exist only to keep the
    // switch exhaustive without an assertion.
    case 'canonical_product':
    case 'merchant':
    case 'order_item':
      return { kind: 'refuse', reason: 'split_requires_explicit_assignment' };
  }
}

/** Apply one verdict and append its audit row, in ONE transaction. */
async function apply(review: ReviewRecord, verdict: Verdict): Promise<boolean> {
  const fromTargetRef = legacyTargetRef(review);
  if (!fromTargetRef) return false;

  return getDb().transaction(async (tx: DatabaseOrTransaction) => {
    if (verdict.kind === 'refuse') {
      const marked = await markReviewAmbiguous(review.id, verdict.reason, tx);
      if (!marked) return false;
      await recordTargetMigration(
        {
          reviewId: review.id,
          action: 'refuse_ambiguous',
          fromTargetType: review.targetType,
          fromTargetRef,
          reason: verdict.reason,
          actorKind: 'migration',
        },
        tx,
      );
      return true;
    }

    const target = scopedTarget(verdict.scope, verdict.targetId);
    const changed = await classifyReview(review.id, target, tx);
    if (!changed) return false;
    await recordTargetMigration(
      {
        reviewId: review.id,
        action: 'classify',
        fromTargetType: review.targetType,
        fromTargetRef,
        toScope: target.scope,
        toTargetType: target.targetType,
        toTargetRef: target.targetId,
        reason: verdict.reason,
        actorKind: 'migration',
      },
      tx,
    );
    return true;
  });
}

/**
 * One bounded pass of the classification job.
 *
 * `includeAmbiguous` re-examines reviews a previous run refused. Off by default:
 * a refusal is waiting for a FACT to arrive (a store being linked to a merchant),
 * and re-reading them every run costs a query per review forever for a decision
 * that cannot have changed on its own. An operator turns it on after landing the
 * facts.
 *
 * Aggregates are rebuilt for every target this run touched, ONCE per target,
 * after the classifications commit — a classified review has moved between two
 * aggregates and both are now wrong until they are derived again.
 */
export async function classifyLegacyReviews(
  options: { batchSize?: number; includeAmbiguous?: boolean } = {},
): Promise<ReviewClassificationReport> {
  const batchSize = options.batchSize ?? CLASSIFY_BATCH_SIZE;
  const batch = options.includeAmbiguous
    ? await findAmbiguousReviews(batchSize)
    : await findUnclassifiedLegacyReviews(batchSize);

  let classified = 0;
  let ambiguous = 0;
  const touched = new Map<string, { scope: ReviewScope; targetId: string }>();

  for (const review of batch) {
    try {
      const verdict = await decide(review);
      if (options.includeAmbiguous && verdict.kind === 'refuse') {
        // Nothing changed for this row; re-marking it would append no new audit
        // row (the unique index converges) and would cost a write for nothing.
        ambiguous += 1;
        continue;
      }
      const applied = await apply(review, verdict);
      if (!applied) continue;

      if (verdict.kind === 'classify') {
        classified += 1;
        touched.set(`${verdict.scope}|${verdict.targetId}`, {
          scope: verdict.scope,
          targetId: verdict.targetId,
        });
      } else {
        ambiguous += 1;
      }
    } catch (err) {
      // One review's failure must not abandon the batch. Nothing marked it
      // done, so the next run retries it.
      log.general.warn({ err, reviewId: review.id }, 'Review classification failed (continuing)');
    }
  }

  for (const target of touched.values()) {
    try {
      await rebuildScopedAggregate(target.scope, target.targetId);
    } catch (err) {
      log.general.warn(
        { err, scope: target.scope, targetId: target.targetId },
        'Aggregate rebuild after classification failed (the sweep will retry)',
      );
    }
  }

  return {
    scanned: batch.length,
    classified,
    ambiguous,
    hasMore: batch.length === batchSize,
  };
}

/**
 * Assign ONE review to a canonical product explicitly — what a product SPLIT
 * needs, and the only way a scoped target moves outside a merge.
 *
 * #76 migration rule 5: "product splits require explicit review assignment or an
 * ambiguity state". A split cannot be inferred, so this takes one review and one
 * destination from a named operator and refuses to accept a set. The audit row
 * carries the operator, which is the whole difference between this and the job.
 */
export async function assignReviewOnSplit(input: {
  reviewId: string;
  fromCanonicalProductId: string;
  toCanonicalProductId: string;
  actorOxyUserId: string;
  reason: string;
}): Promise<void> {
  if (input.fromCanonicalProductId === input.toCanonicalProductId) {
    throw validationError('A split assignment must name a different product');
  }
  if (!input.reason.trim()) {
    throw validationError('A split assignment must state a reason');
  }

  const moved = await getDb().transaction(async (tx: DatabaseOrTransaction) => {
    const changed = await assignReviewToCanonicalProduct(
      input.reviewId,
      input.fromCanonicalProductId,
      input.toCanonicalProductId,
      tx,
    );
    if (!changed) return false;
    await recordTargetMigration(
      {
        reviewId: input.reviewId,
        action: 'assign_split',
        fromScope: 'product',
        fromTargetType: 'canonical_product',
        fromTargetRef: input.fromCanonicalProductId,
        toScope: 'product',
        toTargetType: 'canonical_product',
        toTargetRef: input.toCanonicalProductId,
        reason: input.reason,
        actorKind: 'operator',
        actorOxyUserId: input.actorOxyUserId,
      },
      tx,
    );
    return true;
  });

  if (!moved) {
    throw notFound('That review is not a product review of the product named');
  }

  // Both products' aggregates are now wrong; deriving them again is the repair.
  await rebuildScopedAggregate('product', input.fromCanonicalProductId);
  await rebuildScopedAggregate('product', input.toCanonicalProductId);
}
