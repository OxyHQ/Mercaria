import { useQuery } from '@tanstack/react-query';
import type { DiscoveryFeed, DiscoveryScope } from '@mercaria/shared-types';
import { fetchDiscoveryFeed } from '../api/discovery';
import { queryKeys } from './query-keys';

/** One minute, in ms — how long a discovery feed stays fresh before refetch. */
const DISCOVERY_FEED_STALE_TIME = 1000 * 60;

/**
 * The discovery feed for one scope (explore/category/deals). Public/
 * anonymous: `GET /discovery/feed` requires no auth, so this is always
 * enabled (NO auth gate), mirroring `use-feed.ts`.
 *
 * Keyed per scope (`queryKeys.discovery.feed`) so the three screens do not
 * share one cache entry.
 */
export function useDiscoveryFeed(scope: DiscoveryScope) {
  return useQuery<DiscoveryFeed>({
    queryKey: queryKeys.discovery.feed(scope),
    queryFn: () => fetchDiscoveryFeed(scope),
    staleTime: DISCOVERY_FEED_STALE_TIME,
    retry: 2,
  });
}
