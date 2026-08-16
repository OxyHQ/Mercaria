/**
 * Turning navigation rows into what a client renders (#367 step 7, ADR 0007 D3).
 *
 * PURE — it takes rows and a clock and returns a tree. It reads no database, no
 * configuration and no lever, which is what lets the operator PREVIEW and the
 * public read share it: a preview that ran a different projection would be a
 * preview of something else.
 *
 * ## Withholding, and why it takes the subtree with it
 *
 * Four things withhold a node: the author hid it, its schedule has not started
 * or has ended, its target is gone or is not publicly visible, or nothing in the
 * locale fallback chain gives it a label. A withheld node's CHILDREN are
 * withheld too, under their own reason (`parent_withheld`) — leaving them in
 * would re-root a submenu at the top level, where it means something different
 * and nobody authored it.
 *
 * The target check is what makes ADR 0007 D3's "a collection membership never
 * becomes a product fact" hold in the read as well as in the schema: an
 * unpublished collection linked from a live menu is WITHHELD, so linking cannot
 * publish it. The same predicate covers an inactive category, a merged brand and
 * a merged family.
 */

import type {
  NavigationNodeView,
  NavigationSavedQueryView,
  NavigationTarget,
  NavigationWithheldNode,
  NavigationWithholdReason,
} from '@mercaria/shared-types';
import type { NavigationLabelRow } from './localization.js';
import { resolveNavigationPresentation } from './localization.js';

/** A node, as the projection needs it — the seven pointers still unresolved. */
export interface ProjectableNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly key: string;
  readonly position: number;
  readonly targetKind: string;
  readonly categoryId: string | null;
  readonly savedQueryId: string | null;
  readonly productTypeKey: string | null;
  readonly brandId: string | null;
  readonly productFamilyId: string | null;
  readonly collectionId: string | null;
  readonly campaignUrl: string | null;
  readonly visibility: string;
  readonly visibleFrom: Date | null;
  readonly visibleTo: Date | null;
}

/** A resolved target: its stable identity, and whether it may be shown. */
export interface ResolvedTarget {
  readonly identifier: string;
  readonly publiclyVisible: boolean;
}

/** Everything the projection needs beyond the nodes themselves. */
export interface NavigationProjectionContext {
  readonly requestedLocale: string;
  readonly localeChain: readonly string[];
  readonly at: Date;
  readonly labelsByNodeId: ReadonlyMap<string, readonly NavigationLabelRow[]>;
  readonly categories: ReadonlyMap<string, ResolvedTarget>;
  readonly brands: ReadonlyMap<string, ResolvedTarget>;
  readonly families: ReadonlyMap<string, ResolvedTarget>;
  readonly collections: ReadonlyMap<string, ResolvedTarget>;
  readonly savedQueries: ReadonlyMap<string, NavigationSavedQueryView>;
}

/** The projection's whole answer. */
export interface NavigationProjection {
  readonly nodes: readonly NavigationNodeView[];
  readonly withheld: readonly NavigationWithheldNode[];
}

/** A target lookup that has failed, or has answered with something withdrawn. */
type TargetOutcome =
  | { readonly outcome: 'resolved'; readonly target: NavigationTarget }
  | { readonly outcome: 'withheld'; readonly reason: NavigationWithholdReason };

/**
 * Resolve one node's target.
 *
 * A `switch` over the `target_kind` column with no default that guesses: an
 * unrecognized kind withholds the node. The row CHECK makes an unrecognized kind
 * unwritable, so this branch is unreachable through the schema — which is
 * exactly why it must not fall through to a plausible-looking target.
 */
function resolveTarget(node: ProjectableNode, context: NavigationProjectionContext): TargetOutcome {
  const withheld = (reason: NavigationWithholdReason): TargetOutcome => ({
    outcome: 'withheld',
    reason,
  });
  const lookup = (
    id: string | null,
    map: ReadonlyMap<string, ResolvedTarget>,
  ): ResolvedTarget | NavigationWithholdReason => {
    if (id === null) return 'target_missing';
    const found = map.get(id);
    if (found === undefined) return 'target_missing';
    if (!found.publiclyVisible) return 'target_not_publicly_visible';
    return found;
  };

  switch (node.targetKind) {
    case 'category': {
      const found = lookup(node.categoryId, context.categories);
      if (typeof found === 'string') return withheld(found);
      return {
        outcome: 'resolved',
        target: {
          kind: 'category',
          categoryId: node.categoryId,
          categorySlug: found.identifier,
        },
      };
    }
    case 'brand': {
      const found = lookup(node.brandId, context.brands);
      if (typeof found === 'string') return withheld(found);
      return {
        outcome: 'resolved',
        target: {
          kind: 'brand',
          brandId: node.brandId,
          brandSlug: found.identifier,
        },
      };
    }
    case 'product_family': {
      const found = lookup(node.productFamilyId, context.families);
      if (typeof found === 'string') return withheld(found);
      return {
        outcome: 'resolved',
        target: {
          kind: 'product_family',
          productFamilyId: node.productFamilyId,
          productFamilySlug: found.identifier,
        },
      };
    }
    case 'collection': {
      const found = lookup(node.collectionId, context.collections);
      if (typeof found === 'string') return withheld(found);
      return {
        outcome: 'resolved',
        target: {
          kind: 'collection',
          collectionId: node.collectionId,
          collectionHandle: found.identifier,
        },
      };
    }
    case 'saved_query': {
      if (node.savedQueryId === null) return withheld('target_missing');
      const savedQuery = context.savedQueries.get(node.savedQueryId);
      if (savedQuery === undefined) return withheld('target_missing');
      return { outcome: 'resolved', target: { kind: 'saved_query', savedQuery } };
    }
    case 'product_type': {
      // Nothing to resolve today: `product_type_definitions` is merge-order step
      // 3 and the pointer is the type's stable KEY, which no table can confirm
      // yet. When the registry lands, this branch gains the lookup the other
      // five have and `target_missing` becomes reachable for it too. Until then
      // a key nobody published is a dead link this projection cannot see, which
      // is stated rather than hidden behind a check that always passes.
      if (node.productTypeKey === null) return withheld('target_missing');
      return {
        outcome: 'resolved',
        target: { kind: 'product_type', productTypeKey: node.productTypeKey },
      };
    }
    case 'campaign': {
      if (node.campaignUrl === null) return withheld('target_missing');
      return { outcome: 'resolved', target: { kind: 'campaign', url: node.campaignUrl } };
    }
    default:
      return withheld('target_missing');
  }
}

/** Whether the clock is inside a node's own schedule. */
function withinVisibilityWindow(node: ProjectableNode, at: Date): boolean {
  if (node.visibleFrom !== null && node.visibleFrom.getTime() > at.getTime()) return false;
  if (node.visibleTo !== null && node.visibleTo.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * Compose one tree's nodes.
 *
 * The order is `position` then `key` — the same total order the repository asks
 * the database for, restated here because the projection must not depend on the
 * caller having sorted correctly. Two requests a millisecond apart return the
 * same bytes, which is what makes the ETag mean anything.
 */
export function projectNavigationNodes(
  nodes: readonly ProjectableNode[],
  context: NavigationProjectionContext,
): NavigationProjection {
  const childrenByParent = new Map<string, ProjectableNode[]>();
  for (const node of nodes) {
    const parentKey = node.parentId === null ? '' : node.parentId;
    const siblings = childrenByParent.get(parentKey);
    if (siblings === undefined) childrenByParent.set(parentKey, [node]);
    else siblings.push(node);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) =>
      left.position === right.position
        ? left.key.localeCompare(right.key)
        : left.position - right.position,
    );
  }

  const withheld: NavigationWithheldNode[] = [];

  /** Record this node and every descendant as withheld, under one reason. */
  const withholdSubtree = (node: ProjectableNode, reason: NavigationWithholdReason): void => {
    withheld.push({ nodeKey: node.key, reason });
    for (const child of childrenByParent.get(node.id) ?? []) {
      withholdSubtree(child, 'parent_withheld');
    }
  };

  const build = (node: ProjectableNode): NavigationNodeView | undefined => {
    if (node.visibility !== 'visible') {
      withholdSubtree(node, 'node_hidden');
      return undefined;
    }
    if (!withinVisibilityWindow(node, context.at)) {
      withholdSubtree(node, 'outside_visibility_window');
      return undefined;
    }
    const target = resolveTarget(node, context);
    if (target.outcome === 'withheld') {
      withholdSubtree(node, target.reason);
      return undefined;
    }
    const presentation = resolveNavigationPresentation(
      context.labelsByNodeId.get(node.id) ?? [],
      context.requestedLocale,
      context.localeChain,
    );
    if (presentation === undefined) {
      withholdSubtree(node, 'no_label_in_fallback_chain');
      return undefined;
    }

    const children: NavigationNodeView[] = [];
    for (const child of childrenByParent.get(node.id) ?? []) {
      const built = build(child);
      if (built !== undefined) children.push(built);
    }

    return {
      id: node.id,
      key: node.key,
      position: node.position,
      target: target.target,
      presentation,
      children,
    };
  };

  const roots: NavigationNodeView[] = [];
  for (const node of childrenByParent.get('') ?? []) {
    const built = build(node);
    if (built !== undefined) roots.push(built);
  }

  return { nodes: roots, withheld };
}
