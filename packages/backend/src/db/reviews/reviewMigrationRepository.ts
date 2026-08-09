/**
 * `review_target_migrations` — every scope decision ever made about a review
 * (#76).
 *
 * APPEND-ONLY by trigger. This module is its only writer and offers no update
 * and no delete, so the trigger is a second wall rather than the first one: a
 * caller that wanted to rewrite history would have to write raw SQL, and the
 * database would still refuse.
 *
 * ## Why a log rather than two columns on the review
 *
 * `reviews.scope` answers where a review points NOW. It cannot answer where it
 * pointed before, because a rehome overwrites it — the same limitation
 * `merged_into_id` has, answered the same way `canonical_product_redirects`
 * answers it one domain over. A merge that repointed reviews without recording
 * their origin would make the loser's rating permanently unexplainable, and a
 * SPLIT is unreconstructable by definition: an operator decided it, and the only
 * record that they did is a row saying so.
 *
 * ## Replays converge
 *
 * `UNIQUE(review_id, action, coalesce(to_target_ref, ''))` plus
 * `ON CONFLICT DO NOTHING` on every insert: re-running the classification job
 * over a review it already classified writes nothing new, and neither does a
 * merge re-run against an already-merged product. The `coalesce` is what makes
 * that true for a REFUSAL, which names no destination — without it Postgres
 * would treat two refusals of one review as distinct rows forever.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  ReviewScope,
  ReviewTargetMigrationAction,
  ReviewTargetType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { reviewTargetMigrations } from '../schema/reviews.js';

/** One row of `review_target_migrations`. */
export type ReviewTargetMigrationRecord = InferSelectModel<typeof reviewTargetMigrations>;

/** One recorded scope decision. */
export interface NewReviewTargetMigration {
  reviewId: string;
  action: ReviewTargetMigrationAction;
  fromScope?: ReviewScope;
  fromTargetType: ReviewTargetType;
  fromTargetRef: string;
  /** All three present together, or all three absent (a refusal). */
  toScope?: ReviewScope;
  toTargetType?: ReviewTargetType;
  toTargetRef?: string;
  reason: string;
  actorKind: 'migration' | 'operator';
  /** Required exactly when `actorKind` is `operator`. */
  actorOxyUserId?: string;
}

/**
 * Append one decision, converging on a repeat.
 *
 * @returns the row when this call wrote it, `null` when the decision was already
 *   recorded. The empty vs one-row `RETURNING` set IS the "already recorded"
 *   answer — a real failure (a dropped connection, a CHECK violation) still
 *   propagates instead of being read as a duplicate.
 */
export async function recordTargetMigration(
  values: NewReviewTargetMigration,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewTargetMigrationRecord | null> {
  const [row] = await db
    .insert(reviewTargetMigrations)
    .values({
      reviewId: values.reviewId,
      action: values.action,
      fromScope: values.fromScope ?? null,
      fromTargetType: values.fromTargetType,
      fromTargetRef: values.fromTargetRef,
      toScope: values.toScope ?? null,
      toTargetType: values.toTargetType ?? null,
      toTargetRef: values.toTargetRef ?? null,
      reason: values.reason,
      actorKind: values.actorKind,
      actorOxyUserId: values.actorOxyUserId ?? null,
      at: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** One review's whole scope history, newest first. */
export async function findMigrationsForReview(
  reviewId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewTargetMigrationRecord[]> {
  return db
    .select()
    .from(reviewTargetMigrations)
    .where(eq(reviewTargetMigrations.reviewId, reviewId))
    .orderBy(desc(reviewTargetMigrations.at));
}

/** Every review a given action moved onto one destination — a merge's receipt. */
export async function findMigrationsByDestination(
  action: ReviewTargetMigrationAction,
  toTargetRef: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewTargetMigrationRecord[]> {
  return db
    .select()
    .from(reviewTargetMigrations)
    .where(
      and(
        eq(reviewTargetMigrations.action, action),
        eq(reviewTargetMigrations.toTargetRef, toTargetRef),
      ),
    )
    .orderBy(desc(reviewTargetMigrations.at));
}
