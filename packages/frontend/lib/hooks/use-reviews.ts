import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReviewInput,
  ReviewEligibility,
  ReviewListFilters,
  ReviewScope,
  ReviewHelpfulness,
} from '@mercaria/shared-types';
import { REVIEW_HELPFULNESS_BATCH_LIMIT } from '@mercaria/shared-types';
import { useOxy } from '@oxy.so/services';
import {
  createReview,
  fetchListingReviews,
  fetchMerchantReviews,
  fetchProductReviews,
  fetchReviewEligibilities,
  fetchReviewHelpfulness,
  updateReviewHelpfulness,
  type ScopedReviewPage,
} from '../api/reviews';
import { queryKeys } from './query-keys';

/** Two minutes — a review page stays fresh for a reasonable session window. */
const STALE_TIME = 1000 * 60 * 2;

/** One bounded batch per visible page, scoped to the current Oxy account. */
export function useReviewHelpfulness(reviewIds: string[]) {
  const { user, canUsePrivateApi } = useOxy();
  const ids = [...new Set(reviewIds)].sort();
  return useQuery({
    queryKey: queryKeys.reviews.helpfulness(user?.id ?? '', ids),
    queryFn: async () => {
      const batches: Promise<ReviewHelpfulness[]>[] = [];
      for (let start = 0; start < ids.length; start += REVIEW_HELPFULNESS_BATCH_LIMIT) {
        batches.push(
          fetchReviewHelpfulness(ids.slice(start, start + REVIEW_HELPFULNESS_BATCH_LIMIT)),
        );
      }
      return (await Promise.all(batches)).flat();
    },
    enabled: canUsePrivateApi && !!user?.id && ids.length > 0,
    staleTime: STALE_TIME,
    retry: 1,
  });
}

export function useUpdateReviewHelpfulness(reviewId: string) {
  const { user, canUsePrivateApi } = useOxy();
  const queryClient = useQueryClient();
  const userId = user?.id ?? '';
  return useMutation({
    mutationFn: async (helpful: boolean) => {
      if (!canUsePrivateApi || !userId) throw new Error('Sign in to vote');
      // Capture the account with the request: switching accounts while it is
      // in flight must never write the returned personal state into the new one.
      return { account: userId, vote: await updateReviewHelpfulness(reviewId, helpful) };
    },
    onSuccess: async ({ account, vote }) => {
      const queryKey = queryKeys.reviews.helpfulnessAll(account);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueriesData<ReviewHelpfulness[]>({ queryKey }, (previous) =>
        previous?.map((entry) => (entry.reviewId === vote.reviewId ? vote : entry)),
      );
      // Public page counts remain useful after signing out or reopening a sheet.
      for (const root of ['reviews', 'listings', 'stores']) {
        void queryClient.invalidateQueries({ queryKey: [root] });
      }
    },
  });
}

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
 *
 * KEYS rather than the sentences themselves: this is a module-scope `const`,
 * evaluated at import, and the locale store has not rehydrated by then — the
 * wording above would freeze into whichever language loaded first. The render
 * site resolves it with `t()`.
 *
 * Declared and THEN frozen, rather than `Object.freeze({ … })` in one
 * expression. The i18n guard's key reader matches a `const X = { … }`
 * initializer, and a call expression is not one — so freezing inline hides
 * every key here from its referential check and all five read as dead copy.
 * The runtime guarantee is identical. (`SCOPE_TERM_KEYS` in
 * `components/reviews/ReviewEligibilityPrompts.tsx` records the same trap.)
 *
 * Distinct from that `SCOPE_TERM_KEYS`, which is the scope as a TERM that
 * reads inside a sentence. These are HEADINGS, and dropping a heading into a
 * sentence slot is the #442 defect.
 */
export const REVIEW_SCOPE_HEADING_KEYS: Readonly<Record<ReviewScope, string>> = {
  product: 'reviews.scopeHeading.product',
  merchant: 'reviews.scopeHeading.merchant',
  native_transaction: 'reviews.scopeHeading.nativeTransaction',
  p2p_listing: 'reviews.scopeHeading.p2pListing',
  p2p_seller: 'reviews.scopeHeading.p2pSeller',
};
Object.freeze(REVIEW_SCOPE_HEADING_KEYS);

/** A canonical product's PRODUCT reviews plus the aggregate the page shows. */
export function useProductScopeReviews(
  canonicalProductId: string | undefined,
  page = 1,
  limit = 12,
  query = '',
) {
  return useQuery<ScopedReviewPage>({
    queryKey: queryKeys.reviews.product(canonicalProductId ?? '', page, limit, query),
    queryFn: () => fetchProductReviews(canonicalProductId ?? '', { page, limit, query }),
    enabled: !!canonicalProductId,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** The full sheet appends server pages; preview queries keep their own shape. */
export function useInfiniteProductReviews(
  scope: 'product' | 'p2p_listing',
  id: string,
  filters: ReviewListFilters = {},
  limit = 12,
) {
  return useInfiniteQuery({
    queryKey:
      scope === 'product'
        ? queryKeys.reviews.productInfinite(id, limit, filters)
        : queryKeys.listings.infiniteReviews(id, limit, filters),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params = { page: pageParam, limit, ...filters };
      if (scope === 'product') {
        const page = await fetchProductReviews(id, params);
        return { ...page, aggregate: page.aggregate };
      }
      const page = await fetchListingReviews(id, params);
      return { ...page, aggregate: undefined };
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasNextPage ? lastPage.pagination.page + 1 : undefined,
    enabled: !!id,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** A merchant's SERVICE reviews plus the aggregate the page shows. */
export function useMerchantReviews(
  merchantId: string | undefined,
  page = 1,
  limit = 12,
  query = '',
) {
  return useQuery<ScopedReviewPage>({
    queryKey: queryKeys.reviews.merchant(merchantId ?? '', page, limit, query),
    queryFn: () => fetchMerchantReviews(merchantId ?? '', { page, limit, query }),
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
        void queryClient.invalidateQueries({
          queryKey: queryKeys.listings.detail(review.listingId),
        });
        void queryClient.invalidateQueries({
          queryKey: ['listings', review.listingId, 'reviews'],
        });
      }
    },
  });
}
