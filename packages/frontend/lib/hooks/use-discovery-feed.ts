import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { DiscoveryFeed, DiscoveryScope, DiscoverySignal, DiscoverySignalPage } from '@mercaria/shared-types';
import { fetchDiscoveryFeed, fetchDiscoverySignalPage } from '../api/discovery';
import { queryKeys } from './query-keys';

/** One minute, in ms — how long a discovery feed stays fresh before refetch. */
const DISCOVERY_FEED_STALE_TIME = 1000 * 60;

/** How many products one `/categories/:handle/s/:signal` page asks for. */
const SIGNAL_PAGE_SIZE = 24;

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

/**
 * One signal's full, offset-paged listing for one scope — the
 * `/categories/:handle/s/:signal` "see all" destination every hero card and
 * `SectionCard` on the feed links to.
 *
 * `signal` is `undefined` while the route's own `:signal` segment hasn't been
 * validated yet; the query stays disabled rather than the caller inventing a
 * placeholder signal to satisfy the type (mirrors `useMerchantPage`'s
 * `idOrSlug ?? ""` — a value that is never actually sent because `enabled`
 * gates it).
 *
 * The next page's offset is the count of products already fetched, and
 * `getNextPageParam` stops as soon as a page reports `hasMore: false` —
 * computed server-side from one extra row read past `limit`, never from a
 * client-side arithmetic cap. This is what makes a `'capped'` signal stop at
 * the real edge of what the sweep counted rather than a predicted number.
 */
export function useDiscoverySignalPage(scope: DiscoveryScope, signal: DiscoverySignal | undefined) {
  return useInfiniteQuery<
    DiscoverySignalPage,
    Error,
    DiscoverySignalPage[],
    readonly unknown[],
    number
  >({
    queryKey: queryKeys.discovery.signalPage(scope, signal ?? 'new'),
    enabled: signal !== undefined,
    staleTime: DISCOVERY_FEED_STALE_TIME,
    retry: 2,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchDiscoverySignalPage({
        scope,
        signal: signal ?? 'new',
        limit: SIGNAL_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore
        ? allPages.reduce((total, page) => total + page.products.length, 0)
        : undefined,
    select: (data) => data.pages,
  });
}
