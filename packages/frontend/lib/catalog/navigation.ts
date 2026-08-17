import type { Href } from 'expo-router';
import type {
  CategoryNode,
  NavigationNodeView,
  NavigationResponse,
  NavigationSurface,
} from '@mercaria/shared-types';
import type { CatalogNavigationSource } from '@/lib/api/catalog-navigation';
import { categoryHref, navigationTargetExternalUrl, navigationTargetHref } from './routes';

/**
 * Turning either navigation source into the ONE shape a menu renders.
 *
 * Pure — no fetch, no hook, no clock. What arrives is a `NavigationResponse` or
 * a v1 `CategoryNode[]`; what leaves is {@link CatalogMenuEntry}, which carries
 * a `Href` the compiler checked and a label somebody authored.
 *
 * ## A node with no destination is TEXT, not a dead control
 *
 * `navigationTargetHref` answers `undefined` for the three target kinds the
 * storefront has no screen for. Such an entry keeps its label and its children
 * and gets no `href`, so the menu renders it as a heading — the discriminated
 * shape `NAV_ITEMS` already uses for an unbuilt screen, for the same reason: a
 * control that does nothing is worse than a word that never claimed to be one.
 *
 * ## The effective locale travels with the label
 *
 * `NavigationPresentation` reports which locale actually answered and whether a
 * fallback was applied (ADR 0007 D4). That fact is kept on the entry rather
 * than discarded, so a surface can mark untranslated copy instead of presenting
 * a base-locale string as if it were the shopper's language. It is ABSENT on
 * the v1 branch, because there is no localization record there to report — the
 * v1 name is not "in the base locale", it is in whatever the row stores.
 */

export interface CatalogMenuEntry {
  /** Stable within its tree. Never a label, never an index. */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly accessibilityLabel?: string;
  /** Where pressing it goes. Absent means this entry is a heading. */
  readonly href?: Href;
  /** An external campaign destination. Never an `Href`; opening it leaves the app. */
  readonly externalUrl?: string;
  /**
   * The locale that answered, when it is NOT the one requested. Absent means
   * either an exact match or a source that records no locale at all.
   */
  readonly fallbackLocale?: string;
  readonly children: readonly CatalogMenuEntry[];
}

export interface CatalogNavigationTree {
  readonly key: string;
  readonly surface: NavigationSurface | 'category_tree';
  readonly entries: readonly CatalogMenuEntry[];
}

export interface CatalogNavigation {
  readonly source: CatalogNavigationSource;
  readonly trees: readonly CatalogNavigationTree[];
  /**
   * How many nodes the server withheld. A COUNT and never the list — which ones
   * and why is an operator's question, and a public payload naming them would
   * publish that a particular collection is unpublished.
   */
  readonly withheldNodeCount: number;
  readonly requestedLocale?: string;
  readonly market?: string;
}

function toMenuEntry(node: NavigationNodeView): CatalogMenuEntry {
  const href = navigationTargetHref(node.target);
  const externalUrl = navigationTargetExternalUrl(node.target);
  const { presentation } = node;
  return {
    key: node.key,
    label: presentation.label,
    ...(presentation.description === undefined
      ? {}
      : { description: presentation.description }),
    ...(presentation.accessibilityLabel === undefined
      ? {}
      : { accessibilityLabel: presentation.accessibilityLabel }),
    ...(href === undefined ? {} : { href }),
    ...(externalUrl === undefined ? {} : { externalUrl }),
    ...(presentation.fallbackApplied ? { fallbackLocale: presentation.locale } : {}),
    children: node.children.map(toMenuEntry),
  };
}

/** The taxonomy-v2 answer. */
export function navigationFromTrees(response: NavigationResponse): CatalogNavigation {
  return {
    source: 'navigation_trees',
    trees: response.trees.map((tree) => ({
      key: tree.key,
      surface: tree.surface,
      entries: tree.nodes.map(toMenuEntry),
    })),
    withheldNodeCount: response.withheldNodeCount,
    requestedLocale: response.requestedLocale,
    market: response.market,
  };
}

function categoryNodeToEntry(node: CategoryNode): CatalogMenuEntry {
  return {
    key: node.id,
    label: node.name,
    // The slug is the pretty spelling and the id is always legal, so a category
    // with no slug is still addressable rather than dropped.
    href: categoryHref(node.slug.length > 0 ? node.slug : node.id),
    children: (node.children ?? []).map(categoryNodeToEntry),
  };
}

/**
 * The v1 parity answer.
 *
 * ONE synthetic tree rather than one per root: v1 has no surfaces, and minting
 * five would be inventing a structure the source does not have.
 */
export function navigationFromCategoryTree(
  categories: readonly CategoryNode[],
): CatalogNavigation {
  return {
    source: 'category_tree_fallback',
    trees: [
      {
        key: 'category_tree',
        surface: 'category_tree',
        entries: categories.map(categoryNodeToEntry),
      },
    ],
    // v1 withholds nothing it could report: `GET /categories` filters on
    // `is_active` in SQL, so a withheld node is a row the read never saw. Zero
    // is the honest count and not a placeholder.
    withheldNodeCount: 0,
  };
}

/**
 * WHICH source answers, and the fallback that makes ADR 0007 D12's rollback real.
 *
 * Extracted from `use-navigation.ts`'s query function, under the rule this
 * package's `vitest.config.ts` states for exactly this case: when a component or
 * a hook grows logic worth a test, extract the logic rather than mount the
 * renderer. The decision used to live inside a closure inside a `useQuery`, where
 * nothing could reach it — and it is the single most load-bearing claim in
 * `docs/runbooks/catalog-rollout-rollback.md`: turning
 * `CATALOG_TAXONOMY_V2_ENABLED` off must restore the v1 menu rather than break
 * the storefront.
 *
 * Three failures fold into ONE fallback and they are deliberately not
 * distinguished here, because the shopper's answer is the same for all three:
 *
 *  - the lever is off, so `GET /navigation` is a 404 (a REJECTED promise);
 *  - the market is one nobody configured, so it answers `{trees: []}` (RESOLVED
 *    and empty — which must fall back too, or enabling the flag would withdraw
 *    navigation on the deploy that enabled it, exactly what ADR 0007 D13's parity
 *    condition forbids);
 *  - the API is unreachable (a REJECTED promise of a different kind).
 *
 * What is NOT swallowed is the fallback's own failure: if `GET /categories` — the
 * always-mounted v1 read — also fails, this REJECTS. An empty menu presented as
 * the catalogue would be a statement about the shop, and the caller's error state
 * is the honest answer.
 */
export async function resolveCatalogNavigation(input: {
  readonly market: string | undefined;
  readonly locale: string;
  readonly surface: NavigationSurface | undefined;
  readonly readTrees: (
    market: string,
    locale: string,
    surface: NavigationSurface | undefined,
  ) => Promise<NavigationResponse>;
  readonly readCategoryTree: () => Promise<readonly CategoryNode[]>;
}): Promise<CatalogNavigation> {
  if (input.market !== undefined) {
    // `then(onFulfilled, onRejected)` rather than a `try`/`catch` with an empty
    // block: the rejection handler is a value-producing branch and reads as one,
    // where an empty `catch` reads as an error somebody forgot to handle.
    const trees = await input
      .readTrees(input.market, input.locale, input.surface)
      .then(
        (response) => (response.trees.length > 0 ? navigationFromTrees(response) : undefined),
        () => undefined,
      );
    if (trees !== undefined) return trees;
  }
  return navigationFromCategoryTree(await input.readCategoryTree());
}

/** Every entry of a tree, depth-first, parents before children. */
export function flattenMenuEntries(
  entries: readonly CatalogMenuEntry[],
): readonly CatalogMenuEntry[] {
  const flat: CatalogMenuEntry[] = [];
  for (const entry of entries) {
    flat.push(entry);
    flat.push(...flattenMenuEntries(entry.children));
  }
  return flat;
}
