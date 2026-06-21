import type {
  Listing,
  ListingQuery,
  PaginatedResponse,
  ApiResponse,
} from '@marketplace/shared-types';
import apiClient from './client';

/**
 * Listings API client.
 *
 * Typed against the shared `@marketplace/shared-types` contract so the frontend
 * and backend agree on the listing/pagination shapes. This is the seam the
 * marketplace domain (browse, search, listing detail) is built on.
 */

/** Search/browse listings. Returns a paginated page of listings. */
export async function fetchListings(
  query: ListingQuery & { page?: number; limit?: number } = {},
): Promise<PaginatedResponse<Listing>> {
  const { data } = await apiClient.get<PaginatedResponse<Listing>>('/listings', {
    params: query,
  });
  return data;
}

/** Fetch a single listing by id. */
export async function fetchListing(id: string): Promise<ApiResponse<Listing>> {
  const { data } = await apiClient.get<ApiResponse<Listing>>(`/listings/${id}`);
  return data;
}
