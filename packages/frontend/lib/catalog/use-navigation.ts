import { useQuery } from '@tanstack/react-query';
import type { NavigationSurface } from '@mercaria/shared-types';
import {
  fetchCategoryTree,
  fetchNavigationTrees,
} from '@/lib/api/catalog-navigation';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useCatalogContext } from './context';
import {
  navigationFromCategoryTree,
  navigationFromTrees,
  type CatalogNavigation,
} from './navigation';

/**
 * Read the storefront's navigation, from taxonomy v2 where it is published and
 * from the v1 category tree where it is not.
 *
 * ## ONE query, two sources, and the fallback is INSIDE it
 *
 * Two queries would give the fallback its own loading state, its own error and
 * its own cache entry, and a surface would then have to decide which of two
 * pending states it was in. So the source selection lives in the query function:
 * it asks for the tree it wants, and on any failure asks the always-mounted v1
 * read instead.
 *
 * The catch is broad on purpose. `CATALOG_TAXONOMY_V2_ENABLED` off is a 404, a
 * market nobody configured is a 200 with an empty tree list, an unreachable API
 * is a network error, and none of the three is a state a shopper should see a
 * menu-shaped error in. What distinguishes them for anybody who needs to know is
 * `source` on the answer, which is reported rather than inferred.
 *
 * ## An EMPTY taxonomy-v2 answer still falls back
 *
 * `GET /navigation` answers `{trees: []}` for a market nobody has configured —
 * deliberately, so an unconfigured market does not look like a broken
 * deployment. A storefront rendering that as an empty menu would withdraw
 * navigation on the deploy that enabled the flag, which is exactly what ADR 0007
 * D13's parity condition forbids. So an empty tree list takes the fallback too.
 */

/** Ten minutes. A published menu changes on an operator's schedule, not a shopper's. */
const NAVIGATION_STALE_TIME = 1000 * 60 * 10;

export interface UseCatalogNavigationOptions {
  readonly surface?: NavigationSurface;
}

/**
 * The taxonomy-v2 answer, or `undefined` when this deployment does not give one.
 *
 * Written as `then(onFulfilled, onRejected)` rather than as a `try`/`catch` with
 * an empty block: the rejection handler is a value-producing branch and reads as
 * one, where an empty `catch` reads as an error somebody forgot to handle.
 */
function readNavigationTrees(
  market: string,
  locale: string,
  surface: NavigationSurface | undefined,
): Promise<CatalogNavigation | undefined> {
  return fetchNavigationTrees(market, locale, surface).then(
    (response) => (response.trees.length > 0 ? navigationFromTrees(response) : undefined),
    () => undefined,
  );
}

export function useCatalogNavigation(
  options?: UseCatalogNavigationOptions,
): ReturnType<typeof useQuery<CatalogNavigation>> {
  const context = useCatalogContext();
  const { surface } = options ?? {};

  return useQuery<CatalogNavigation>({
    queryKey: queryKeys.catalog.navigation(
      context.market ?? '',
      context.locale,
      surface ?? '',
    ),
    staleTime: NAVIGATION_STALE_TIME,
    // A menu is the first request of a session and a retry storm on a
    // deliberately-unmounted route is a cost with no benefit: the fallback below
    // already answers, so one attempt at each is enough.
    retry: false,
    queryFn: async () => {
      if (context.market !== undefined) {
        const trees = await readNavigationTrees(context.market, context.locale, surface);
        if (trees !== undefined) return trees;
      }
      return navigationFromCategoryTree(await fetchCategoryTree());
    },
  });
}
