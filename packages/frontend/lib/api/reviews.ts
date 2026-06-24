import type { PaginatedResponse, Review } from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Reviews API client.
 *
 * Public, paginated reads of a listing's published reviews. Typed against the
 * shared `@mercaria/shared-types` contract so the product detail page renders
 * the same `Review` shape the backend serializes from `GET /listings/:id/reviews`.
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
