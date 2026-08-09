import type {
  ApiResponse,
  CreateReviewInput,
  PaginatedResponse,
  Review,
  ReviewEligibility,
  ScopedRatingAggregate,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Reviews API client.
 *
 * Two families, and the split matters (#76):
 *
 *  - the SCOPED reads (`/reviews/product/:id`, `/reviews/merchant/:id`) return a
 *    page PLUS the aggregate for exactly that scope and target, so a surface
 *    never derives a rating from the page it happens to have;
 *  - the LEGACY reads (`/listings/:id/reviews`, `/stores/:handle/reviews`) are
 *    unchanged through the compatibility window and carry no aggregate — a
 *    listing's own reviews are listing-specific feedback, and the star figures
 *    those surfaces show come from the entity's projected `rating` field.
 */

/** Fetch a page of a listing's published reviews. */
export async function fetchListingReviews(
  listingId: string,
  params?: { page?: number; limit?: number },
): Promise<PaginatedResponse<Review>> {
  const { data } = await apiClient.get<PaginatedResponse<Review>>(
    `/listings/${listingId}/reviews`,
    { params },
  );
  return data;
}

/**
 * Fetch a page of a store's PRODUCT reviews by handle (`GET
 * /stores/:handle/reviews`). The backend aggregates the store's listings'
 * published reviews, newest first, each hydrated with minimal `product` context
 * (thumbnail + title) for the store reviews sheet.
 */
export async function fetchStoreReviews(
  handle: string,
  params?: { page?: number; limit?: number },
): Promise<PaginatedResponse<Review>> {
  const { data } = await apiClient.get<PaginatedResponse<Review>>(
    `/stores/${handle}/reviews`,
    { params },
  );
  return data;
}

/**
 * A scoped review page, plus the aggregate the page displays.
 *
 * The aggregate travels WITH the page deliberately (#76, and #75's acceptance
 * that structured data uses "only the rating aggregate matching the visible page
 * and target"): a client that averaged the twelve reviews it received would
 * display a number that is not the target's rating, which is exactly what the
 * product page did before #76.
 */
export interface ScopedReviewPage extends PaginatedResponse<Review> {
  aggregate: ScopedRatingAggregate;
}

/** A canonical product's PRODUCT reviews — quality, durability, value. */
export async function fetchProductReviews(
  canonicalProductId: string,
  params?: { page?: number; limit?: number },
): Promise<ScopedReviewPage> {
  const { data } = await apiClient.get<ScopedReviewPage>(
    `/reviews/product/${canonicalProductId}`,
    { params },
  );
  return data;
}

/** A merchant's SERVICE reviews — fulfilment, packaging, communication. */
export async function fetchMerchantReviews(
  merchantId: string,
  params?: { page?: number; limit?: number },
): Promise<ScopedReviewPage> {
  const { data } = await apiClient.get<ScopedReviewPage>(`/reviews/merchant/${merchantId}`, {
    params,
  });
  return data;
}

/**
 * What the signed-in buyer may still review.
 *
 * Authenticated. Carries the scope, the target and the verification EVIDENCE
 * TYPE — and no contact or payment identifier, because `ReviewEligibility` has
 * no field for one (#76 privacy rule 3).
 */
export async function fetchReviewEligibilities(): Promise<ApiResponse<ReviewEligibility[]>> {
  const { data } = await apiClient.get<ApiResponse<ReviewEligibility[]>>('/reviews/eligibilities');
  return data;
}

/** Write a scoped review. `targetType` is derived server-side from the scope. */
export async function createReview(input: CreateReviewInput): Promise<ApiResponse<Review>> {
  const { data } = await apiClient.post<ApiResponse<Review>>('/reviews', input);
  return data;
}
