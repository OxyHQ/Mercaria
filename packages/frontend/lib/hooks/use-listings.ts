import { useQuery } from '@tanstack/react-query';
import type { Listing, ListingQuery, PaginatedResponse } from '@mercaria/shared-types';
import { fetchListings } from '../api/listings';
import { queryKeys } from './query-keys';

/** Two minutes — listing search results stay fresh for a reasonable session window. */
const STALE_TIME = 1000 * 60 * 2;

/**
 * Browse/search listings. The query object doubles as a TanStack query key so
 * every distinct filter combination is cached independently.
 *
 * `enabled` exists because an EMPTY query is a legitimate value that means
 * "every listing", not "nothing". A caller whose filter is still resolving — a
 * category page waiting on the taxonomy to name its slug — would otherwise fetch
 * the whole catalogue and throw it away, so the honest way to say "not yet" is
 * to disable the query rather than to pass a filter that means something else.
 * It defaults to `true`, so no existing call site changes.
 */
export function useListings(
  query: ListingQuery & { page?: number; limit?: number },
  options?: { enabled?: boolean },
) {
  return useQuery<PaginatedResponse<Listing>>({
    queryKey: queryKeys.listings.list(query),
    queryFn: () => fetchListings(query),
    enabled: options?.enabled ?? true,
    staleTime: STALE_TIME,
    retry: 2,
  });
}
