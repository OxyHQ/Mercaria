import { useQuery } from '@tanstack/react-query';
import type { Listing, ListingQuery, PaginatedResponse } from '@mercaria/shared-types';
import { fetchListings } from '../api/listings';
import { queryKeys } from './query-keys';

/** Two minutes — listing search results stay fresh for a reasonable session window. */
const STALE_TIME = 1000 * 60 * 2;

/**
 * Browse/search listings. The query object doubles as a TanStack query key so
 * every distinct filter combination is cached independently.
 */
export function useListings(query: ListingQuery & { page?: number; limit?: number }) {
  return useQuery<PaginatedResponse<Listing>>({
    queryKey: queryKeys.listings.list(query),
    queryFn: () => fetchListings(query),
    staleTime: STALE_TIME,
    retry: 2,
  });
}
