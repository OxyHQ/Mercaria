import type {
  ApiResponse,
  CategoryNode,
  NavigationResponse,
  NavigationSurface,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The taxonomy-driven navigation read (#367 step 7), and its parity fallback.
 *
 * ## Two sources, one shape, and the source is always REPORTED
 *
 * `GET /navigation` is mounted only behind `CATALOG_TAXONOMY_V2_ENABLED`, which
 * defaults OFF — so on a deployment that has not turned it on the router does
 * not exist and the request 404s. That is the rollout working, not a fault, and
 * ADR 0007 D13 conditions the storefront rewire on parity with what shipped
 * before it.
 *
 * So the client falls back to `GET /categories` — the v1 tree, always mounted,
 * reading the SAME `categories` rows — and every consumer is told which source
 * answered. The fallback is not a second taxonomy: it is the same identity with
 * no localization record behind it, which is exactly what a surface must say
 * rather than paper over.
 *
 * ## The fallback is deliberately not silent about what it lost
 *
 * A v1 node carries a name in whatever the row stores and no locale, status or
 * provenance. {@link CatalogNavigationSource} is on the result and the menu
 * renders the same either way — but nothing downstream may claim a v1 label was
 * localized, because there is no field on that branch to claim it with.
 */

export type CatalogNavigationSource = 'navigation_trees' | 'category_tree_fallback';

/** `GET /navigation` — refuses to compose a request without a market. */
export async function fetchNavigationTrees(
  market: string,
  locale: string,
  surface?: NavigationSurface,
): Promise<NavigationResponse> {
  const { data } = await apiClient.get<ApiResponse<NavigationResponse>>('/navigation', {
    params: { market, locale, ...(surface === undefined ? {} : { surface }) },
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load navigation');
  }
  return data.data;
}

/** `GET /categories` — the v1 tree, always mounted. */
export async function fetchCategoryTree(): Promise<readonly CategoryNode[]> {
  const { data } = await apiClient.get<ApiResponse<CategoryNode[]>>('/categories');
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load categories');
  }
  return data.data;
}
