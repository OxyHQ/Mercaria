import { useQuery } from '@tanstack/react-query';
import type { CategoryNode } from '@mercaria/shared-types';
import { fetchCategoryTree } from '@/lib/api/catalog-navigation';
import { queryKeys } from '@/lib/hooks/query-keys';

/**
 * Resolving a category HANDLE, and reading its place in the tree.
 *
 * ## Why this reads the v1 tree and not a taxonomy endpoint
 *
 * There is none. `packages/backend/src/db/taxonomy/taxonomyRepository.ts`
 * implements `findCategoryByKey`, `findCategoryAncestors`,
 * `findCategoryBreadcrumb`, `findChildCategories` and `resolveCategoryRedirect`,
 * and `packages/shared-types/src/taxonomy.ts` publishes `TaxonomyCategory`,
 * `CategoryBreadcrumbStep` and `CategoryRedirectResolution` — and **no route,
 * controller or service imports any of them**. `docs/taxonomy.md` says so
 * outright: "Any HTTP surface — this step is schema, repository and gates only."
 *
 * So the category identity a landing page resolves comes from `GET /categories`,
 * which reads the SAME `categories` rows through `findActiveCategories`. What
 * that costs, stated rather than hidden:
 *
 *  - **no localization.** A v1 name is whatever the row stores. The taxonomy-v2
 *    read would carry the D4 fallback chain and its effective locale.
 *  - **no lifecycle.** v1 filters `is_active` in SQL, so a deprecated or merged
 *    category is simply absent rather than reported as withdrawn.
 *  - **no redirects.** A deprecated or renamed slug resolves through
 *    `GET /seo/resolve`, which is the registry that owns the answer anyway — so
 *    this gap is closed by a different surface rather than left open.
 *
 * ## Ancestors here are a FALLBACK trail, never the authority
 *
 * `SeoDocument.breadcrumbs` is the trail a page renders when the SEO surface
 * answers, because it is the same trail the page's own `BreadcrumbList`
 * structured data is built from. {@link categoryAncestors} exists for the
 * deployment where that surface is not mounted, and a page must prefer the
 * registry's — two trails that disagree is worse than one that is plainer.
 */

/** Ten minutes. The taxonomy changes when an operator publishes. */
const CATEGORY_TREE_STALE_TIME = 1000 * 60 * 10;

export function useCategoryTree(): ReturnType<typeof useQuery<readonly CategoryNode[]>> {
  return useQuery<readonly CategoryNode[]>({
    // The v1 tree is one document for the whole storefront and carries no
    // locale, so it is keyed on nothing. A locale in the key would mint twelve
    // identical cache entries.
    queryKey: queryKeys.catalog.navigation('', '', 'category_tree'),
    staleTime: CATEGORY_TREE_STALE_TIME,
    retry: 1,
    queryFn: fetchCategoryTree,
  });
}

/** Every node of the tree, depth-first. */
export function flattenCategories(
  nodes: readonly CategoryNode[],
): readonly CategoryNode[] {
  const flat: CategoryNode[] = [];
  for (const node of nodes) {
    flat.push(node);
    flat.push(...flattenCategories(node.children ?? []));
  }
  return flat;
}

/**
 * Resolve a `/categories/:handle` segment.
 *
 * A handle is an ID or the current SLUG — #75's `SeoRouteIdentity` of `handle`,
 * which is why the id is always a legal address and a rename never breaks a
 * link. The id is tried FIRST: an id is opaque and cannot collide with a slug,
 * so trying the slug first would let a category whose slug happened to equal
 * another's id shadow it.
 */
export function findCategoryByHandle(
  nodes: readonly CategoryNode[],
  handle: string,
): CategoryNode | undefined {
  const flat = flattenCategories(nodes);
  return (
    flat.find((node) => node.id === handle) ?? flat.find((node) => node.slug === handle)
  );
}

/** The chain from the root down to (and excluding) the category itself. */
export function categoryAncestors(
  nodes: readonly CategoryNode[],
  categoryId: string,
): readonly CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  for (const node of flattenCategories(nodes)) byId.set(node.id, node);

  const chain: CategoryNode[] = [];
  let current = byId.get(categoryId)?.parentId ?? null;
  // A parent chain in a tree cannot cycle, but this read is over data a server
  // composed, and a bound is what keeps a corrupted answer from hanging the app
  // rather than rendering a short trail.
  let guard = 0;
  while (current !== null && guard < 32) {
    const parent = byId.get(current);
    if (parent === undefined) break;
    chain.unshift(parent);
    current = parent.parentId;
    guard += 1;
  }
  return chain;
}
