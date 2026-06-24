import { useQuery } from '@tanstack/react-query';
import type { Listing, PaginatedResponse, Review } from '@mercaria/shared-types';
import { fetchListing } from '../api/listings';
import { fetchListingReviews } from '../api/reviews';
import { queryKeys } from './query-keys';

/** Two minutes — a product detail page stays fresh for a reasonable session window. */
const STALE_TIME = 1000 * 60 * 2;

/**
 * Single product (listing) for the product detail page. Backed by the public
 * `GET /listings/:id` endpoint (`getListingById`), which returns a fully
 * hydrated `Listing` (variants, options, images, owner identity, derived price)
 * wrapped in the standard `ApiResponse` envelope — unwrapped here.
 */
export function useProduct(id: string) {
  return useQuery<Listing>({
    queryKey: queryKeys.listings.detail(id),
    queryFn: async () => {
      const response = await fetchListing(id);
      if (!response.success || !response.data) {
        throw new Error(response.error ?? response.message ?? 'Failed to load product');
      }
      return response.data;
    },
    enabled: !!id,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/**
 * A page of a product's published reviews, backed by the public
 * `GET /listings/:id/reviews` endpoint. Returns the paginated envelope so the
 * PDP can render the review carousel and the total review count.
 */
export function useProductReviews(id: string, page = 1, limit = 12) {
  return useQuery<PaginatedResponse<Review>>({
    queryKey: queryKeys.listings.reviews(id, page),
    queryFn: () => fetchListingReviews(id, { page, limit }),
    enabled: !!id,
    staleTime: STALE_TIME,
    retry: 2,
  });
}
