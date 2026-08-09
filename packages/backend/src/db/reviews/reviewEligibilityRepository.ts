/**
 * `review_eligibilities` — the durable "this account bought this, so it may
 * review it" grant (#76).
 *
 * ## Why this is a separate table and not a flag on the review
 *
 * The issue asks for it explicitly, and the reason shows up the first time
 * anything goes wrong: an order correction, a moderation action and a claim
 * audit each need to answer "was this person entitled to write that?" WITHOUT
 * depending on whatever text was written, or on whether the review still
 * exists. A boolean on the review answers none of them.
 *
 * ## What CANNOT create a row here
 *
 * {@link insertEligibility} takes an order LINE and nothing else that identifies
 * a person. There is no email parameter, no phone parameter, no payment-method
 * parameter and no session parameter — not because the caller is trusted not to
 * pass one, but because the row has no column to hold it and the function has no
 * argument to accept it. `REVIEW_FORBIDDEN_EVIDENCE_SOURCES` names the fourteen
 * signals that must never do this, and `review-eligibility.service` refuses each
 * BY NAME so a refusal says which one it refused.
 *
 * ## Idempotency is the constraint, not a pre-check
 *
 * `review_eligibilities_line_author_scope_key` is `UNIQUE(order_item_id,
 * oxy_user_id, scope)` — #76 verification rule 11 stated as DDL. Every writer
 * here converges with `ON CONFLICT DO NOTHING`, so a claim retry, a migration
 * replay and two concurrent grants all end at exactly one row. There is no
 * read-then-write anywhere in this module.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  ReviewEligibilityState,
  ReviewEvidenceType,
  ReviewScope,
  ReviewTargetType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { reviewEligibilities } from '../schema/reviews.js';

/** One row of `review_eligibilities`. */
export type ReviewEligibilityRecord = InferSelectModel<typeof reviewEligibilities>;

/**
 * Everything needed to grant one eligibility.
 *
 * Note the absences as much as the presences: no contact field, no payment
 * field, no session field, no referral field. The evidence is `orderItemId`.
 */
export interface NewReviewEligibility {
  oxyUserId: string;
  orderId: string;
  /** The line that IS the evidence. */
  orderItemId: string;
  scope: ReviewScope;
  targetType: ReviewTargetType;
  targetId: string;
  evidenceType: ReviewEvidenceType;
  /** Required exactly when `evidenceType` is `claimed_guest_purchase`. */
  claimId?: string;
  policyVersion: string;
}

/**
 * The six target columns, the matching one set and the other five NULL.
 *
 * `native_transaction` writes `target_order_item_id`, NOT `order_item_id`: the
 * latter is the EVIDENCE line and is set on every row whatever the scope. The
 * two coincide for that one scope and are different roles, which is why the
 * table carries both columns and this function only ever touches one of them.
 */
function targetColumnValues(target: {
  targetType: ReviewTargetType;
  targetId: string;
}): {
  listingId: string | null;
  storeId: string | null;
  sellerOxyUserId: string | null;
  canonicalProductId: string | null;
  merchantId: string | null;
  targetOrderItemId: string | null;
} {
  return {
    listingId: target.targetType === 'listing' ? target.targetId : null,
    storeId: target.targetType === 'store' ? target.targetId : null,
    sellerOxyUserId: target.targetType === 'seller' ? target.targetId : null,
    canonicalProductId: target.targetType === 'canonical_product' ? target.targetId : null,
    merchantId: target.targetType === 'merchant' ? target.targetId : null,
    targetOrderItemId: target.targetType === 'order_item' ? target.targetId : null,
  };
}

/**
 * Grant one eligibility, converging on a repeat.
 *
 * `ON CONFLICT DO NOTHING` and not `DO UPDATE`: a second grant for the same
 * (line, author, scope) is the SAME grant arriving twice, and rewriting the row
 * would move `updated_at` — making a replay indistinguishable from a real
 * regrant in the audit trail, and resetting a `revoked` row to `open` if a
 * careless `set` ever crept in. The empty vs one-row `RETURNING` set IS the
 * "already granted" answer, exactly as the moderation-event claim reads it.
 *
 * @returns the row when this call created it, `null` when one already existed.
 */
export async function insertEligibility(
  values: NewReviewEligibility,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewEligibilityRecord | null> {
  const [row] = await db
    .insert(reviewEligibilities)
    .values({
      oxyUserId: values.oxyUserId,
      orderId: values.orderId,
      orderItemId: values.orderItemId,
      scope: values.scope,
      targetType: values.targetType,
      ...targetColumnValues(values),
      evidenceType: values.evidenceType,
      claimId: values.claimId ?? null,
      policyVersion: values.policyVersion,
    })
    .onConflictDoNothing({
      target: [
        reviewEligibilities.orderItemId,
        reviewEligibilities.oxyUserId,
        reviewEligibilities.scope,
      ],
    })
    .returning();
  return row ?? null;
}

/** One eligibility by id, or `null`. */
export async function findEligibilityById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewEligibilityRecord | null> {
  const [row] = await db
    .select()
    .from(reviewEligibilities)
    .where(eq(reviewEligibilities.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The author's OPEN eligibilities for one scope and target, oldest first.
 *
 * Oldest first so a buyer who bought the same product twice spends the older
 * grant — which keeps the pairing between an eligibility and the purchase it
 * came from as intuitive as it can be when both are equally valid.
 */
export async function findOpenEligibilitiesForTarget(
  oxyUserId: string,
  scope: ReviewScope,
  targetType: ReviewTargetType,
  targetId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewEligibilityRecord[]> {
  const column =
    targetType === 'listing'
      ? reviewEligibilities.listingId
      : targetType === 'store'
        ? reviewEligibilities.storeId
        : targetType === 'seller'
          ? reviewEligibilities.sellerOxyUserId
          : targetType === 'canonical_product'
            ? reviewEligibilities.canonicalProductId
            : targetType === 'merchant'
              ? reviewEligibilities.merchantId
              : reviewEligibilities.targetOrderItemId;

  return db
    .select()
    .from(reviewEligibilities)
    .where(
      and(
        eq(reviewEligibilities.oxyUserId, oxyUserId),
        eq(reviewEligibilities.scope, scope),
        eq(column, targetId),
        eq(reviewEligibilities.state, 'open'),
      ),
    )
    .orderBy(asc(reviewEligibilities.createdAt), asc(reviewEligibilities.id));
}

/** Everything this account may still review, newest first — the order-history surface. */
export async function findOpenEligibilitiesForUser(
  oxyUserId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewEligibilityRecord[]> {
  return db
    .select()
    .from(reviewEligibilities)
    .where(
      and(eq(reviewEligibilities.oxyUserId, oxyUserId), eq(reviewEligibilities.state, 'open')),
    )
    .orderBy(desc(reviewEligibilities.createdAt), desc(reviewEligibilities.id))
    .limit(limit);
}

/** Every eligibility granted from one order — the trace an operator opens. */
export async function findEligibilitiesForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewEligibilityRecord[]> {
  return db
    .select()
    .from(reviewEligibilities)
    .where(eq(reviewEligibilities.orderId, orderId))
    .orderBy(asc(reviewEligibilities.createdAt));
}

/**
 * Spend an eligibility, in ONE conditional statement.
 *
 * `state = 'open'` is in the predicate, so two concurrent submissions cannot
 * both believe they spent it — the loser's predicate is re-checked against the
 * winner's write and it comes back false. The review insert then fails its own
 * `reviews_eligibility_id_key` if it somehow raced past this, which is the
 * second, independent wall.
 *
 * @returns `true` when this call spent it.
 */
export async function consumeEligibility(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviewEligibilities)
    .set({ state: 'consumed', consumedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(reviewEligibilities.id, id), eq(reviewEligibilities.state, 'open')))
    .returning({ id: reviewEligibilities.id });
  return rows.length > 0;
}

/**
 * Withdraw an UNUSED eligibility.
 *
 * Only from `open`: a consumed one has already produced published content, and
 * #76 moderation rule 8 is explicit that a hidden or removed review does not
 * restore eligibility automatically — the converse of which is that revoking a
 * grant must never silently unpublish anything. A correction to an
 * already-consumed grant is a moderation decision about the REVIEW, taken on the
 * review, where it is visible.
 */
export async function revokeOpenEligibility(
  id: string,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviewEligibilities)
    .set({
      state: 'revoked',
      revokedAt: new Date(),
      revokedReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(reviewEligibilities.id, id), eq(reviewEligibilities.state, 'open')))
    .returning({ id: reviewEligibilities.id });
  return rows.length > 0;
}

/**
 * Mark an eligibility disputed — a claim correction arrived and somebody has to
 * look at it.
 *
 * Reachable from `open` AND from `consumed`, which is the whole point:
 * #76 verification rule 12 asks for an explicit policy for both the unused and
 * the already-consumed case, and the policy is that neither deletes published
 * content. A disputed consumed grant leaves its review exactly where it is and
 * says so out loud.
 */
export async function disputeEligibility(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(reviewEligibilities)
    .set({ state: 'disputed', disputedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(reviewEligibilities.id, id),
        inArray(reviewEligibilities.state, ['open', 'consumed'] as ReviewEligibilityState[]),
      ),
    )
    .returning({ id: reviewEligibilities.id });
  return rows.length > 0;
}

/**
 * How many eligibilities exist per evidence type — the vacuity floor a
 * guest-origin audit reads, and the only aggregate this table exposes.
 *
 * Deliberately NOT broken down by anything else. "How many reviews came from
 * guests" is a question #76 privacy rule 7 refuses to answer at any finer grain
 * than this, and there is no column here that could answer it more precisely.
 */
export async function countEligibilitiesByEvidenceType(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ evidenceType: ReviewEvidenceType; count: number }[]> {
  return db
    .select({
      evidenceType: reviewEligibilities.evidenceType,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewEligibilities)
    .groupBy(reviewEligibilities.evidenceType);
}
