import { and, eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { orderItems } from '../schema/orders.js';
import { reviewEligibilities, reviews } from '../schema/reviews.js';

/** Public variant context from the immutable purchase, in one read per page.
 * No order, buyer contact, or payment fields are selected. The eligibility must
 * belong to this author and rating scope; a current catalog variant is never a
 * substitute for missing purchase evidence.
 */
export async function findPurchasedVariantsForReviews(
  reviewIds: string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, string>> {
  if (reviewIds.length === 0) return new Map();
  const rows = await db
    .select({ reviewId: reviews.id, variantTitle: orderItems.variantTitle })
    .from(reviews)
    .innerJoin(
      reviewEligibilities,
      and(
        eq(reviewEligibilities.id, reviews.eligibilityId),
        eq(reviewEligibilities.oxyUserId, reviews.authorOxyUserId),
        eq(reviewEligibilities.scope, reviews.scope),
      ),
    )
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.id, reviewEligibilities.orderItemId),
        eq(orderItems.orderId, reviewEligibilities.orderId),
      ),
    )
    .where(
      and(
        inArray(reviews.id, reviewIds),
        eq(reviews.status, 'published'),
        eq(reviews.verification, 'verified_purchase'),
      ),
    );
  return new Map(
    rows.flatMap(({ reviewId, variantTitle }) => {
      const title = variantTitle.trim();
      // This is the documented catalog sentinel for a product with no options.
      return title && title !== 'Default Title' ? [[reviewId, title]] : [];
    }),
  );
}
