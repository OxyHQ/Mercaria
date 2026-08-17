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
