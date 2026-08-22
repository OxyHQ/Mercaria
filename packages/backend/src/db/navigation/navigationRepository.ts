/**
 * The reads a navigation tree is composed from (#367 step 7, ADR 0007 D3).
 *
 * Bounded and batched: one statement for the live trees of a `(market, locale)`,
 * one for every node in them, one for every label in the fallback chain, and one
 * per target KIND present — never one per node. A menu is a small tree, but it
 * is on the critical path of the first request of every session, so the shape
 * that matters is the one that does not grow a round trip per entry.
 *
 * ## Every target read is READ-ONLY and narrow
 *
 * A category, a brand, a family and a collection are read for the two things a
 * node needs — the stable identity it points at, and whether that thing may be
 * shown at all. Nothing here writes to any of those tables and nothing selects a
 * column beyond identity and publication state: ADR 0007 D3 forbids navigation
 * writing to `categories`, and a repository that could select a category's whole
 * row is one edit away from updating it.
 */

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { NavigationSurface } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { brands } from '../schema/organizations.js';
import { canonicalProductFamilies } from '../schema/canonicalCatalog.js';
import { categories } from '../schema/catalog.js';
import { collections } from '../schema/merchandising.js';
import {
  navigationNodeLocalizations,
  navigationNodes,
  navigationSavedQueries,
  navigationSavedQueryAttributeFilters,
  navigationTrees,
} from '../schema/navigation.js';

/** A tree row, exactly as the projection needs it. */
export interface NavigationTreeRow {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly market: string;
  readonly locale: string;
  readonly surface: NavigationSurface;
  readonly lifecycle: string;
  readonly internalLabel: string;
  readonly effectiveFrom: Date | null;
  readonly effectiveTo: Date | null;
  readonly publishedAt: Date | null;
}

/** A node row. The seven pointers travel unresolved; the projection resolves. */
export interface NavigationNodeRow {
  readonly id: string;
  readonly treeId: string;
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

/** One localization row, for one node in one locale. */
export interface NavigationLocalizationRow {
  readonly nodeId: string;
  readonly locale: string;
  readonly label: string;
  readonly description: string | null;
  readonly accessibilityLabel: string | null;
  readonly status: string;
  readonly provenance: string;
}

/** A saved query row plus its attribute filters, as the projection reads them. */
export interface NavigationSavedQueryRow {
  readonly id: string;
  readonly key: string;
  readonly queryText: string | null;
  readonly categoryId: string | null;
  readonly brandIds: readonly string[];
  readonly merchantIds: readonly string[];
  readonly conditionGroups: readonly string[];
  readonly availability: readonly string[];
  readonly offerKinds: readonly string[];
  readonly officialChannelOnly: boolean;
  readonly market: string | null;
  readonly priceMinAmount: number | null;
  readonly priceMaxAmount: number | null;
  /**
   * BOTH ends' currency columns, not one aliased as "the" currency.
   *
   * `optionalMoney` gives each bound its own currency column and the CHECKs
   * demand amount-and-currency together, so a MAX-only bound leaves the min
   * currency NULL — reading that one column as the query's currency drops a
   * max-only filter silently, which is a saved query that quietly searches
   * everything.
   */
  readonly priceMinCurrency: string | null;
  readonly priceMaxCurrency: string | null;
}

/** One attribute filter of a saved query. */
export interface NavigationSavedQueryAttributeRow {
  readonly savedQueryId: string;
  readonly attributeKey: string;
  readonly values: readonly string[];
  readonly position: number;
}

/** A target's stable identity plus whether it may be shown at all. */
export interface NavigationTargetRow {
  readonly id: string;
  /** A slug or a handle — whichever that entity's own identity is. */
  readonly identifier: string;
  /** False withholds the node: a menu must not lead to something withdrawn. */
  readonly publiclyVisible: boolean;
}

const TREE_COLUMNS = {
  id: navigationTrees.id,
  key: navigationTrees.key,
  version: navigationTrees.version,
  market: navigationTrees.market,
  locale: navigationTrees.locale,
  surface: navigationTrees.surface,
  lifecycle: navigationTrees.lifecycle,
  internalLabel: navigationTrees.internalLabel,
  effectiveFrom: navigationTrees.effectiveFrom,
  effectiveTo: navigationTrees.effectiveTo,
  publishedAt: navigationTrees.publishedAt,
};

/**
 * Every tree that is LIVE for one `(market, locale)` at one instant.
 *
 * `published` AND inside its window — the two together, because the lifecycle is
 * the intent and the window is the schedule, and a tree that is one without the
 * other is not live. A DRAFT can never appear here, which is what makes
 * "unpublished navigation is not publicly readable" a property of the query
 * rather than of the caller.
 *
 * ## `version` is the third ordering term, and it is what keeps the ETag stable
 *
 * `(surface, key)` is NOT a total order over what this statement can return.
 * `navigation_trees`' only unique is `(key, market, locale, version)` — there is
 * deliberately no one-published-per-key partial unique — so two published
 * versions of one tree, both inside their effective window, satisfy this WHERE
 * together and tie on `(surface, key)`. The database is then free to return them
 * in either order.
 *
 * That is not a cosmetic tie, because of what consumes this list.
 * `readPublishedNavigation` does not deduplicate: it iterates these rows in
 * order, composes the payload from them, and hands the payload to
 * `navigationEtag`, which hashes it. A tie therefore produces TWO validators for
 * identical data, so every client revalidating gets a 200 with a full body
 * instead of a 304 — a cache that has stopped working while reporting success,
 * which `services/navigation/etag.ts` names as the exact failure its determinism
 * exists to prevent. The ordering half of this epic line and the ETag half are
 * one defect, not two.
 *
 * `market` and `locale` complete that unique and are NOT in the ordering: both
 * are pinned to a single value by the first two conditions below, so they can
 * only ever compare equal. That is recorded as this read's entry in
 * `db/__tests__/ordering-dispositions.ts`, which is what stops the gate reading
 * a legitimately-total ordering as a defect.
 */
export async function findLiveNavigationTrees(
  db: DatabaseOrTransaction,
  params: {
    readonly market: string;
    readonly locale: string;
    readonly surface?: NavigationSurface;
    readonly at: Date;
  },
): Promise<NavigationTreeRow[]> {
  const conditions = [
    eq(navigationTrees.market, params.market),
    eq(navigationTrees.locale, params.locale),
    eq(navigationTrees.lifecycle, 'published'),
    or(isNull(navigationTrees.effectiveFrom), lte(navigationTrees.effectiveFrom, params.at)),
    or(isNull(navigationTrees.effectiveTo), gt(navigationTrees.effectiveTo, params.at)),
  ];
  if (params.surface !== undefined) {
    conditions.push(eq(navigationTrees.surface, params.surface));
  }
  const rows = await db
    .select(TREE_COLUMNS)
    .from(navigationTrees)
    .where(and(...conditions))
    .orderBy(asc(navigationTrees.surface), asc(navigationTrees.key), desc(navigationTrees.version));
  return rows;
}

/** One tree by id, whatever its lifecycle — the operator preview's read. */
export async function findNavigationTreeById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<NavigationTreeRow | undefined> {
  const [row] = await db.select(TREE_COLUMNS).from(navigationTrees).where(eq(navigationTrees.id, id));
  return row;
}

/**
 * Every node of the given trees, in deterministic order.
 *
 * `treeId`, then `position`, then `key`.
 *
 * The tree leads, and it is what makes this total rather than
 * total-if-you-know-the-caller. `navigation_nodes_tree_key_key` is
 * `(tree_id, key)`, so `(position, key)` alone covers no unique once this read
 * spans SEVERAL trees — which it does: `readPublishedNavigation` passes every
 * live tree at once. Two nodes in different trees sharing a position and a key
 * tie, and the database may return them in either order.
 *
 * Before the tree was added the payload was still stable, but only because the
 * caller partitions with `nodes.filter(n => n.treeId === tree.id)` and `filter`
 * preserves relative order. That is a real guarantee and an invisible one: it
 * lives in another module, it is not what this ORDER BY says, and it disappears
 * the day somebody groups with a `Map` or sorts the result. Leading with the
 * tree makes the order total here, changes nothing about the per-tree sequence,
 * and removes the dependency.
 */
export async function listNavigationNodes(
  db: DatabaseOrTransaction,
  treeIds: readonly string[],
): Promise<NavigationNodeRow[]> {
  if (treeIds.length === 0) return [];
  const rows = await db
    .select({
      id: navigationNodes.id,
      treeId: navigationNodes.treeId,
      parentId: navigationNodes.parentId,
      key: navigationNodes.key,
      position: navigationNodes.position,
      targetKind: navigationNodes.targetKind,
      categoryId: navigationNodes.categoryId,
      savedQueryId: navigationNodes.savedQueryId,
      productTypeKey: navigationNodes.productTypeKey,
      brandId: navigationNodes.brandId,
      productFamilyId: navigationNodes.productFamilyId,
      collectionId: navigationNodes.collectionId,
      campaignUrl: navigationNodes.campaignUrl,
      visibility: navigationNodes.visibility,
      visibleFrom: navigationNodes.visibleFrom,
      visibleTo: navigationNodes.visibleTo,
    })
    .from(navigationNodes)
    .where(inArray(navigationNodes.treeId, [...treeIds]))
    .orderBy(asc(navigationNodes.treeId), asc(navigationNodes.position), asc(navigationNodes.key));
  return rows;
}

/** Every label for the given nodes in any locale of the fallback chain. */
export async function listNavigationLocalizations(
  db: DatabaseOrTransaction,
  nodeIds: readonly string[],
  locales: readonly string[],
): Promise<NavigationLocalizationRow[]> {
  if (nodeIds.length === 0 || locales.length === 0) return [];
  const rows = await db
    .select({
      nodeId: navigationNodeLocalizations.nodeId,
      locale: navigationNodeLocalizations.locale,
      label: navigationNodeLocalizations.label,
      description: navigationNodeLocalizations.description,
      accessibilityLabel: navigationNodeLocalizations.accessibilityLabel,
      status: navigationNodeLocalizations.status,
      provenance: navigationNodeLocalizations.provenance,
    })
    .from(navigationNodeLocalizations)
    .where(
      and(
        inArray(navigationNodeLocalizations.nodeId, [...nodeIds]),
        inArray(navigationNodeLocalizations.locale, [...locales]),
      ),
    );
  return rows;
}

/** The saved queries the given nodes point at. */
export async function listNavigationSavedQueries(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<NavigationSavedQueryRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: navigationSavedQueries.id,
      key: navigationSavedQueries.key,
      queryText: navigationSavedQueries.queryText,
      categoryId: navigationSavedQueries.categoryId,
      brandIds: navigationSavedQueries.brandIds,
      merchantIds: navigationSavedQueries.merchantIds,
      conditionGroups: navigationSavedQueries.conditionGroups,
      availability: navigationSavedQueries.availability,
      offerKinds: navigationSavedQueries.offerKinds,
      officialChannelOnly: navigationSavedQueries.officialChannelOnly,
      market: navigationSavedQueries.market,
      priceMinAmount: navigationSavedQueries.priceMinAmount,
      priceMaxAmount: navigationSavedQueries.priceMaxAmount,
      priceMinCurrency: navigationSavedQueries.priceMinCurrency,
      priceMaxCurrency: navigationSavedQueries.priceMaxCurrency,
    })
    .from(navigationSavedQueries)
    .where(inArray(navigationSavedQueries.id, [...ids]));
  return rows;
}

/** Every attribute filter of the given saved queries, in authored order. */
export async function listNavigationSavedQueryAttributes(
  db: DatabaseOrTransaction,
  savedQueryIds: readonly string[],
): Promise<NavigationSavedQueryAttributeRow[]> {
  if (savedQueryIds.length === 0) return [];
  const rows = await db
    .select({
      savedQueryId: navigationSavedQueryAttributeFilters.savedQueryId,
      attributeKey: navigationSavedQueryAttributeFilters.attributeKey,
      values: navigationSavedQueryAttributeFilters.values,
      position: navigationSavedQueryAttributeFilters.position,
    })
    .from(navigationSavedQueryAttributeFilters)
    .where(inArray(navigationSavedQueryAttributeFilters.savedQueryId, [...savedQueryIds]))
    // `savedQueryId` leads, for the reason `listNavigationNodes` above states:
    // the unique is `(saved_query_id, attribute_key)`, this read spans several
    // saved queries, and `(position, attributeKey)` alone covers no unique
    // across them. These filters are composed into the navigation payload that
    // `navigationEtag` hashes, so an arbitrary order between two saved queries'
    // filters is an unstable validator rather than a cosmetic wobble.
    .orderBy(
      asc(navigationSavedQueryAttributeFilters.savedQueryId),
      asc(navigationSavedQueryAttributeFilters.position),
      asc(navigationSavedQueryAttributeFilters.attributeKey),
    );
  return rows;
}

/**
 * The categories the given nodes point at.
 *
 * The predicate is the CONJUNCTION `lifecycle = 'published' AND is_active`,
 * rather than either alone, and the reason is that the two can disagree today:
 * ADR 0007 D2 makes `is_active` a derived read of `lifecycle`, but
 * `categories_is_active_derived_check` is deferred to a `post` migration and the
 * serving image still writes `is_active` directly — so the invariant is intended
 * and not yet enforced. A public menu's failure mode is showing a category
 * somebody withdrew, so it withholds when EITHER column says withdrawn. When
 * that CHECK lands the conjunction becomes redundant and costs nothing.
 *
 * `selectable` is deliberately NOT part of it. That column says a category may
 * not take a product ASSIGNMENT (D2), and a grouping root no product sits in
 * directly is the commonest menu node there is — filtering on it would empty
 * most menus. It is the predicate somebody reaching for "the obvious set of
 * category conditions" would add.
 */
export async function listNavigationCategoryTargets(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<NavigationTargetRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: categories.id,
      identifier: categories.slug,
      publiclyVisible: sql<boolean>`${categories.lifecycle} = 'published' and ${categories.isActive}`,
    })
    .from(categories)
    .where(inArray(categories.id, [...ids]));
  return rows;
}

/** The brands the given nodes point at. A merged brand is a tombstone. */
export async function listNavigationBrandTargets(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<NavigationTargetRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: brands.id,
      identifier: brands.slug,
      publiclyVisible: sql<boolean>`${brands.status} = 'active' and ${brands.mergedIntoId} is null`,
    })
    .from(brands)
    .where(inArray(brands.id, [...ids]));
  return rows;
}

/** The product families the given nodes point at. */
export async function listNavigationFamilyTargets(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<NavigationTargetRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: canonicalProductFamilies.id,
      identifier: canonicalProductFamilies.slug,
      publiclyVisible: sql<boolean>`${canonicalProductFamilies.status} = 'active' and ${canonicalProductFamilies.mergedIntoId} is null`,
    })
    .from(canonicalProductFamilies)
    .where(inArray(canonicalProductFamilies.id, [...ids]));
  return rows;
}

/**
 * The collections the given nodes point at.
 *
 * `is_published` is READ and never written. ADR 0007 D3 keeps collections
 * merchandising: linking one from a menu gives it no category semantics and — as
 * this predicate makes structural — cannot publish it either. An unpublished
 * collection withholds the node.
 */
export async function listNavigationCollectionTargets(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<NavigationTargetRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: collections.id,
      identifier: collections.handle,
      publiclyVisible: collections.isPublished,
    })
    .from(collections)
    .where(inArray(collections.id, [...ids]));
  return rows;
}
