import { useQuery } from '@tanstack/react-query';
import type { Feed } from '@mercaria/shared-types';
import { fetchFeed } from '../api/feed';
import { queryKeys } from './query-keys';

/** One minute, in ms — how long the feed stays fresh before refetch. */
const FEED_STALE_TIME = 1000 * 60;

/**
 * Home feed query. Public/anonymous: `GET /feed` requires no auth, so this is
 * always enabled (NO auth gate). Loading/error/success are surfaced via the
 * standard TanStack Query result.
 */
export function useFeed() {
  return useQuery<Feed>({
    queryKey: queryKeys.feed.all,
    queryFn: fetchFeed,
    staleTime: FEED_STALE_TIME,
    retry: 2,
  });
}
