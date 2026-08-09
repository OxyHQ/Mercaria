import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Listing, PublicSellerListingsPage, PublicSellerProfile } from '@mercaria/shared-types';
import { fetchSellerListings, fetchSellerProfile } from '../api/sellers';
import { queryKeys } from './query-keys';

/** Two minutes — a seller profile is stable within a browsing session. */
const STALE_TIME = 1000 * 60 * 2;

/** How many listings one page of a seller's inventory carries. */
const LISTINGS_PAGE_SIZE = 24;

/**
 * A seller's public profile.
 *
 * A 404 is a legitimate outcome and NOT retried past the first attempt: the
 * server answers deleted, blocked and never-existed with one indistinguishable
 * response, so retrying cannot turn any of them into a page and only delays the
 * empty state.
 */
export function useSellerProfile(oxyUserId: string | undefined) {
  return useQuery<PublicSellerProfile>({
    queryKey: queryKeys.sellers.profile(oxyUserId ?? ''),
    queryFn: () => fetchSellerProfile(oxyUserId ?? ''),
    enabled: Boolean(oxyUserId),
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/**
 * A seller's public listings, paged by KEYSET.
 *
 * `useInfiniteQuery` with the server's own opaque cursor — never a page number.
 * `getNextPageParam` returns `undefined` on the last page, which is what stops
 * the list rather than a count the client would have to keep in step with a
 * catalogue that changes while it is being read.
 */
export function useSellerListings(oxyUserId: string | undefined, enabled = true) {
  return useInfiniteQuery<PublicSellerListingsPage<Listing>, Error, PublicSellerListingsPage<Listing>[], readonly unknown[], string | undefined>({
    queryKey: queryKeys.sellers.listings(oxyUserId ?? ''),
    enabled: Boolean(oxyUserId) && enabled,
    staleTime: STALE_TIME,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      fetchSellerListings(oxyUserId ?? '', {
        limit: LISTINGS_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages,
  });
}
