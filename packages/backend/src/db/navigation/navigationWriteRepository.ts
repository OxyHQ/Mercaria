/**
 * The writes the navigation domain makes — and the four tables it may write.
 *
 * `navigation_trees`, `navigation_nodes`, `navigation_node_localizations`,
 * `navigation_saved_queries` and its attribute filters. Nothing else: ADR 0007
 * D3 states that nothing in navigation may write to `categories`, and this
 * module is where such a write would have to be spelled — which is why
 * `navigation-isolation.test.ts` reads this directory whole and fails the build
 * on a category, collection, brand, family or ranking write of any shape.
 *
 * ## The node set is REPLACED, never patched
 *
 * `replaceNavigationNodes` deletes and re-inserts a DRAFT tree's whole node set
 * inside one transaction. The alternative — a dozen create/move/retarget
 * endpoints — makes every intermediate state a real state somebody can leave a
 * tree in, and the states that matter are the ones where the ordering is
 * duplicated or a subtree is orphaned. The set an operator previewed is the set
 * that publishes, which is the `catalog_split_jobs` assignment-list device.
 *
 * A published tree cannot be reached by any of this, and that is enforced twice:
 * every function refuses a non-draft tree, and the freeze trigger refuses it
 * again against `psql` and against a caller who forgets.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { assertLocalizedRow } from '../../lib/localized-text.js';
import type {
  CurrencyCode,
  NavigationLocalizationProvenance,
  NavigationLocalizationStatus,
  NavigationNodeTargetKind,
  NavigationNodeVisibility,
  NavigationSurface,
  NavigationTargetInput,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  navigationNodeLocalizations,
  navigationNodes,
  navigationSavedQueries,
  navigationSavedQueryAttributeFilters,
  navigationTrees,
} from '../schema/navigation.js';

/** What a new draft tree is created from. */
export interface NewNavigationTree {
  readonly key: string;
  readonly market: string;
  readonly locale: string;
  readonly surface: NavigationSurface;
  readonly internalLabel: string;
  readonly version: number;
  readonly supersedesTreeId?: string;
}

/** One node of a replacement node set, with its labels. */
export interface NewNavigationNode {
  readonly key: string;
  readonly parentKey?: string;
  readonly position: number;
  readonly target: NavigationTargetInput;
  readonly visibility?: NavigationNodeVisibility;
  readonly visibleFrom?: Date;
  readonly visibleTo?: Date;
  readonly localizations: readonly NewNavigationLocalization[];
}

/** The pointer columns one target input writes, and the six it leaves NULL. */
interface TargetColumns {
  readonly targetKind: NavigationNodeTargetKind;
  readonly categoryId?: string;
  readonly savedQueryId?: string;
  readonly productTypeKey?: string;
  readonly brandId?: string;
  readonly productFamilyId?: string;
  readonly collectionId?: string;
  readonly campaignUrl?: string;
}

/**
 * A target input as columns — the ONE place the union becomes seven pointers.
 *
 * An exhaustive `switch` over a string discriminant, so adding an eighth target
 * kind fails to compile here as well as failing the row CHECK. Every branch
 * writes exactly one pointer and mentions no other, which is what makes the
 * shape CHECK unreachable through this path rather than merely satisfied by it.
 */
function targetColumns(target: NavigationTargetInput): TargetColumns {
  switch (target.kind) {
    case 'category':
      return { targetKind: 'category', categoryId: target.categoryId };
    case 'saved_query':
      return { targetKind: 'saved_query', savedQueryId: target.savedQueryId };
    case 'product_type':
      return { targetKind: 'product_type', productTypeKey: target.productTypeKey };
    case 'brand':
      return { targetKind: 'brand', brandId: target.brandId };
    case 'product_family':
      return { targetKind: 'product_family', productFamilyId: target.productFamilyId };
    case 'collection':
      return { targetKind: 'collection', collectionId: target.collectionId };
    case 'campaign':
      return { targetKind: 'campaign', campaignUrl: target.url };
  }
}

/** One label of one node, in one locale (ADR 0007 D4). */
export interface NewNavigationLocalization {
  readonly locale: string;
  readonly label: string;
  readonly description?: string;
  readonly accessibilityLabel?: string;
  readonly status: NavigationLocalizationStatus;
  readonly provenance: NavigationLocalizationProvenance;
  readonly sourceLocale?: string;
  readonly reviewedByOxyUserId?: string;
  readonly reviewedAt?: Date;
}

/** A new saved query and its attribute filters. */
export interface NewNavigationSavedQuery {
  readonly key: string;
  readonly internalLabel: string;
  readonly queryText?: string;
  readonly categoryId?: string;
  readonly brandIds?: readonly string[];
  readonly merchantIds?: readonly string[];
  readonly conditionGroups?: readonly string[];
  readonly availability?: readonly string[];
  readonly offerKinds?: readonly string[];
  readonly officialChannelOnly?: boolean;
  readonly market?: string;
  readonly priceCurrency?: CurrencyCode;
  readonly priceMinAmount?: number;
  readonly priceMaxAmount?: number;
  readonly attributes?: readonly {
    readonly attributeKey: string;
    readonly values: readonly string[];
  }[];
}

/** The highest version of a tree key in one `(market, locale)`, or 0. */
export async function findLatestNavigationTreeVersion(
  db: DatabaseOrTransaction,
  params: { readonly key: string; readonly market: string; readonly locale: string },
): Promise<number> {
  const [row] = await db
    .select({ version: sql<number>`coalesce(max(${navigationTrees.version}), 0)::int` })
    .from(navigationTrees)
    .where(
      and(
        eq(navigationTrees.key, params.key),
        eq(navigationTrees.market, params.market),
        eq(navigationTrees.locale, params.locale),
      ),
    );
  return row === undefined ? 0 : row.version;
}

/** Insert a DRAFT tree. A tree is never created in any other lifecycle. */
export async function insertNavigationTree(
  db: DatabaseOrTransaction,
  tree: NewNavigationTree,
): Promise<string> {
  const [row] = await db
    .insert(navigationTrees)
    .values({
      key: tree.key,
      market: tree.market,
      locale: tree.locale,
      surface: tree.surface,
      internalLabel: tree.internalLabel,
      version: tree.version,
      lifecycle: 'draft',
      ...(tree.supersedesTreeId === undefined ? {} : { supersedesTreeId: tree.supersedesTreeId }),
    })
    .returning({ id: navigationTrees.id });
  return row.id;
}

/**
 * Replace a draft tree's whole node set, with its labels, in one statement pair
 * per level.
 *
 * Parents are addressed by KEY rather than by id, because the caller is
 * describing a tree it has not created yet and cannot know the ids of. Nodes are
 * inserted level by level so a parent's id exists before its children reference
 * it; the level count is bounded by `NAVIGATION_MAX_DEPTH`, which the cycle
 * trigger enforces at the row.
 */
export async function replaceNavigationNodes(
  db: DatabaseOrTransaction,
  treeId: string,
  nodes: readonly NewNavigationNode[],
): Promise<number> {
  await db.delete(navigationNodes).where(eq(navigationNodes.treeId, treeId));
  if (nodes.length === 0) return 0;

  const idByKey = new Map<string, string>();
  let pending = [...nodes];
  let inserted = 0;

  while (pending.length > 0) {
    const ready = pending.filter(
      (node) => node.parentKey === undefined || idByKey.has(node.parentKey),
    );
    if (ready.length === 0) {
      // Every remaining node names a parent that is not in this set and is not
      // yet inserted. That is an orphan or a cycle among the KEYS, and it has to
      // be refused here: the row trigger only sees a chain that exists.
      throw new Error(
        'a navigation node names a parent key that is not part of this tree; ' +
          `unresolved keys: ${pending.map((node) => node.key).join(', ')}`,
      );
    }
    const values = ready.map((node) => ({
      treeId,
      key: node.key,
      position: node.position,
      ...targetColumns(node.target),
      ...(node.parentKey === undefined ? {} : { parentId: idByKey.get(node.parentKey) }),
      ...(node.visibility === undefined ? {} : { visibility: node.visibility }),
      ...(node.visibleFrom === undefined ? {} : { visibleFrom: node.visibleFrom }),
      ...(node.visibleTo === undefined ? {} : { visibleTo: node.visibleTo }),
    }));
    const rows = await db
      .insert(navigationNodes)
      .values(values)
      .returning({ id: navigationNodes.id, key: navigationNodes.key });
    for (const row of rows) idByKey.set(row.key, row.id);
    inserted += rows.length;

    const labels = ready.flatMap((node) =>
      node.localizations.map((localization) => ({
        nodeId: idByKey.get(node.key),
        locale: localization.locale,
        label: localization.label,
        status: localization.status,
        provenance: localization.provenance,
        ...(localization.description === undefined
          ? {}
          : { description: localization.description }),
        ...(localization.accessibilityLabel === undefined
          ? {}
          : { accessibilityLabel: localization.accessibilityLabel }),
        ...(localization.sourceLocale === undefined
          ? {}
          : { sourceLocale: localization.sourceLocale }),
        ...(localization.reviewedByOxyUserId === undefined
          ? {}
          : { reviewedByOxyUserId: localization.reviewedByOxyUserId }),
        ...(localization.reviewedAt === undefined ? {} : { reviewedAt: localization.reviewedAt }),
      })),
    );
    // See `listingLocalizationRepository.upsertListingLocalization` (#367 line
    // 187). Applied to the COMPOSED rows immediately before the insert, so it
    // covers every branch above that could have put text in one. Spread rather
    // than checked beside them, so a row this call does not cover is a row that
    // does not reach the insert.
    const checked = labels.map((label) => ({
      ...label,
      ...assertLocalizedRow('navigation_node_localizations', {
        label: label.label,
        description: label.description ?? null,
        accessibilityLabel: label.accessibilityLabel ?? null,
      }),
    }));
    if (checked.length > 0) await db.insert(navigationNodeLocalizations).values(checked);

    const readyKeys = new Set(ready.map((node) => node.key));
    pending = pending.filter((node) => !readyKeys.has(node.key));
  }
  return inserted;
}

/**
 * Take the row lock the publication's exclusion needs.
 *
 * The window-overlap trigger is a REFUSAL and not a mutual exclusion: under READ
 * COMMITTED two concurrent publications each see the other's row as it was
 * before, and both pass. Locking the surface's published rows first is what
 * serializes them; the trigger then catches everything that reaches the table by
 * any other route, including `psql`.
 */
export async function lockPublishedTreesForSurface(
  db: DatabaseOrTransaction,
  params: {
    readonly market: string;
    readonly locale: string;
    readonly surface: NavigationSurface;
  },
): Promise<string[]> {
  const rows = await db
    .select({ id: navigationTrees.id })
    .from(navigationTrees)
    .where(
      and(
        eq(navigationTrees.market, params.market),
        eq(navigationTrees.locale, params.locale),
        eq(navigationTrees.surface, params.surface),
        eq(navigationTrees.lifecycle, 'published'),
      ),
    )
    .for('update');
  return rows.map((row) => row.id);
}

/** Stamp a draft tree published, over the window it was scheduled for. */
export async function markNavigationTreePublished(
  db: DatabaseOrTransaction,
  params: {
    readonly treeId: string;
    readonly publishedByOxyUserId: string;
    readonly publishedAt: Date;
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date;
  },
): Promise<number> {
  const rows = await db
    .update(navigationTrees)
    .set({
      lifecycle: 'published',
      publishedAt: params.publishedAt,
      publishedByOxyUserId: params.publishedByOxyUserId,
      effectiveFrom: params.effectiveFrom,
      ...(params.effectiveTo === undefined ? {} : { effectiveTo: params.effectiveTo }),
    })
    // The CAS: `draft` is the only lifecycle this transition may start from, so
    // two racers cannot both publish one tree and the loser gets zero rows
    // rather than a second publication instant.
    .where(and(eq(navigationTrees.id, params.treeId), eq(navigationTrees.lifecycle, 'draft')))
    .returning({ id: navigationTrees.id });
  return rows.length;
}

/**
 * End a live tree's window at an instant.
 *
 * Used when a successor is published: the incumbent ends exactly when the new
 * one begins, so there is no overlap for the exclusion trigger to refuse and no
 * gap where a surface renders nothing.
 */
export async function endNavigationTreeWindow(
  db: DatabaseOrTransaction,
  treeId: string,
  endsAt: Date,
): Promise<number> {
  const rows = await db
    .update(navigationTrees)
    .set({ effectiveTo: endsAt })
    .where(and(eq(navigationTrees.id, treeId), eq(navigationTrees.lifecycle, 'published')))
    .returning({ id: navigationTrees.id });
  return rows.length;
}

/** Archive a published tree. Never a draft — a draft is deleted, not archived. */
export async function markNavigationTreeArchived(
  db: DatabaseOrTransaction,
  treeId: string,
): Promise<number> {
  const rows = await db
    .update(navigationTrees)
    .set({ lifecycle: 'archived' })
    .where(and(eq(navigationTrees.id, treeId), eq(navigationTrees.lifecycle, 'published')))
    .returning({ id: navigationTrees.id });
  return rows.length;
}

/** How many nodes a tree has, and how many of them carry no label at all. */
export async function countNavigationNodesWithoutLabel(
  db: DatabaseOrTransaction,
  treeId: string,
  locales: readonly string[],
): Promise<{ readonly nodeCount: number; readonly unlabelled: readonly string[] }> {
  const nodes = await db
    .select({ id: navigationNodes.id, key: navigationNodes.key })
    .from(navigationNodes)
    .where(eq(navigationNodes.treeId, treeId));
  if (nodes.length === 0 || locales.length === 0) {
    return { nodeCount: nodes.length, unlabelled: nodes.map((node) => node.key) };
  }
  const labels = await db
    .select({ nodeId: navigationNodeLocalizations.nodeId })
    .from(navigationNodeLocalizations)
    .where(
      and(
        inArray(
          navigationNodeLocalizations.nodeId,
          nodes.map((node) => node.id),
        ),
        inArray(navigationNodeLocalizations.locale, [...locales]),
      ),
    );
  const labelled = new Set(labels.map((row) => row.nodeId));
  return {
    nodeCount: nodes.length,
    unlabelled: nodes.filter((node) => !labelled.has(node.id)).map((node) => node.key),
  };
}

/** Insert a saved query and its attribute filters. */
export async function insertNavigationSavedQuery(
  db: DatabaseOrTransaction,
  query: NewNavigationSavedQuery,
): Promise<string> {
  const [row] = await db
    .insert(navigationSavedQueries)
    .values({
      key: query.key,
      internalLabel: query.internalLabel,
      officialChannelOnly: query.officialChannelOnly === true,
      brandIds: [...(query.brandIds ?? [])],
      merchantIds: [...(query.merchantIds ?? [])],
      conditionGroups: [...(query.conditionGroups ?? [])],
      availability: [...(query.availability ?? [])],
      offerKinds: [...(query.offerKinds ?? [])],
      ...(query.queryText === undefined ? {} : { queryText: query.queryText }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.market === undefined ? {} : { market: query.market }),
      // The currency is stored on BOTH ends because `optionalMoney` gives each
      // its own column and the CHECKs demand amount-and-currency together; the
      // agreement CHECK is what keeps the two ends comparable.
      ...(query.priceMinAmount === undefined || query.priceCurrency === undefined
        ? {}
        : { priceMinAmount: query.priceMinAmount, priceMinCurrency: query.priceCurrency }),
      ...(query.priceMaxAmount === undefined || query.priceCurrency === undefined
        ? {}
        : { priceMaxAmount: query.priceMaxAmount, priceMaxCurrency: query.priceCurrency }),
    })
    .returning({ id: navigationSavedQueries.id });

  const attributes = query.attributes ?? [];
  if (attributes.length > 0) {
    await db.insert(navigationSavedQueryAttributeFilters).values(
      attributes.map((attribute, index) => ({
        savedQueryId: row.id,
        attributeKey: attribute.attributeKey,
        values: [...attribute.values],
        position: index,
      })),
    );
  }
  return row.id;
}

/** Delete a DRAFT tree and everything hanging off it. */
export async function deleteDraftNavigationTree(
  db: DatabaseOrTransaction,
  treeId: string,
): Promise<number> {
  const rows = await db
    .delete(navigationTrees)
    .where(and(eq(navigationTrees.id, treeId), eq(navigationTrees.lifecycle, 'draft')))
    .returning({ id: navigationTrees.id });
  return rows.length;
}
