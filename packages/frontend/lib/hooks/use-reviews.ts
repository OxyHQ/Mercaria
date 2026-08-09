import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReviewInput,
  ReviewEligibility,
  ReviewScope,
} from '@mercaria/shared-types';
import { useOxy } from '@oxyhq/services';
import {
  createReview,
  fetchMerchantReviews,
  fetchProductReviews,
  fetchReviewEligibilities,
  type ScopedReviewPage,
} from '../api/reviews';
import { queryKeys } from './query-keys';

/** Two minutes — a review page stays fresh for a reasonable session window. */
const STALE_TIME = 1000 * 60 * 2;

/**
 * What each scope's rating is ABOUT, in the reader's own words (#76 UI rule 6).
 *
 * ONE map, read by every surface that shows a rating, so a page carrying a
 * product rating and a seller rating cannot show two identical "4.2 ★" rows a
 * reader has to guess between. The wording is deliberately plain and
 * deliberately NOT interchangeable:
 *
 *  - `p2p_listing` says "condition and description" and never "quality",
 *    because #76 UI rule 5 forbids presenting used-listing feedback as a
 *    product-quality rating — and a label reading "Item reviews" would do
 *    exactly that by implication;
 *  - `merchant` says "service", not "seller rating", because the thing being
 *    rated is fulfilment and reliability rather than the goods.
 */
export const REVIEW_SCOPE_LABELS: Readonly<Record<ReviewScope, string>> = Object.freeze({
  product: 'Product reviews',
  merchant: 'Seller service',
  native_transaction: 'This purchase',
  p2p_listing: 'Item condition and description',
  p2p_seller: 'Seller reputation',
});

/** A canonical product's PRODUCT reviews plus the aggregate the page shows. */
export function useProductScopeReviews(canonicalProductId: string | undefined, page = 1, limit = 12) {
  return useQuery<ScopedReviewPage>({
    queryKey: queryKeys.reviews.product(canonicalProductId ?? '', page),
    queryFn: () => fetchProductReviews(canonicalProductId ?? '', { page, limit }),
    enabled: !!canonicalProductId,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** A merchant's SERVICE reviews plus the aggregate the page shows. */
export function useMerchantReviews(merchantId: string | undefined, page = 1, limit = 12) {
  return useQuery<ScopedReviewPage>({
    queryKey: queryKeys.reviews.merchant(merchantId ?? '', page),
    queryFn: () => fetchMerchantReviews(merchantId ?? '', { page, limit }),
    enabled: !!merchantId,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/**
 * What the signed-in buyer may still review — the order-history surface's read
 * (#76 UI rule 3).
 *
 * A QUERY rather than an effect, and `enabled` on the auth state rather than a
 * `useEffect` watching it: React Query's own once-per-`enabled`-transition
 * semantics are the trigger, which is the pattern `useGuestCartMerge` already
 * established here.
 *
 * It returns nothing at all for a signed-out visitor. That is #76 UI rule 8 and
 * acceptance criterion 8 in one: a guest order carries no eligibility until a
 * claim moves it into an Oxy account, so there is no review action to offer and
 * no fake author to invent.
 */
export function useReviewEligibilities() {
  const { isAuthenticated } = useOxy();

  return useQuery<ReviewEligibility[]>({
    queryKey: queryKeys.reviews.eligibilities,
    queryFn: async () => {
      const response = await fetchReviewEligibilities();
      if (!response.success || !response.data) {
        throw new Error(response.error ?? response.message ?? 'Failed to load review options');
      }
      return response.data;
    },
    enabled: isAuthenticated,
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/**
 * Write a scoped review.
 *
 * On success it invalidates the eligibility list (the grant has been spent, so
 * the prompt must disappear) AND the review page for that scope and target. The
 * aggregate travels with that page, so one invalidation refreshes the stars and
 * the list together — there is no second cache entry holding a rating that could
 * drift from the list beside it.
 */
export function useCreateReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateReviewInput) => {
      const response = await createReview(input);
      if (!response.success || !response.data) {
        throw new Error(response.error ?? response.message ?? 'Failed to publish review');
      }
      return response.data;
    },
    onSuccess: (review) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviews.eligibilities });
      if (review.canonicalProductId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.reviews.productAll(review.canonicalProductId),
        });
      }
      if (review.merchantId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.reviews.merchantAll(review.merchantId),
        });
      }
      if (review.listingId) {
        // The legacy listing feed and the listing's own projected rating.
        void queryClient.invalidateQueries({ queryKey: queryKeys.listings.detail(review.listingId) });
        void queryClient.invalidateQueries({
          queryKey: ['listings', review.listingId, 'reviews'],
        });
      }
    },
  });
}
