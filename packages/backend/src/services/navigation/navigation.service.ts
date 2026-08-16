/**
 * Composing a navigation read (#367 step 7, ADR 0007 D3).
 *
 * Two entry points over ONE composition: the public read, which sees only what
 * is published and live, and the operator preview, which sees one tree whatever
 * its lifecycle and additionally gets the reasons nodes were withheld. Both run
 * `projectNavigationNodes`, so a preview cannot show a menu that publishing
 * would not produce.
 *
 * ## The read is bounded, and it is bounded by KIND rather than by node
 *
 * Four statements for the trees, their nodes and their labels, then at most one
 * per target kind actually present, then one for the saved queries' attribute
 * filters. A menu of eighty entries is nine statements, not eighty-nine, and
 * that is the number that matters: this is the first request of every session.
 *
 * ## What this service cannot do
 *
 * It writes nothing at all, and it reads no category, collection, brand or
 * family column beyond identity and publication state. ADR 0007 D3's "nothing in
 * navigation may write to `categories`" is held by the repository's own narrow
 * selects and by `navigation-isolation.test.ts`, which reads this directory
 * whole.
 */

import type {
  NavigationPreviewResponse,
  NavigationResponse,
  NavigationSavedQueryView,
  NavigationSurface,
  NavigationTreeLifecycle,
  NavigationTreeView,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findLiveNavigationTrees,
  findNavigationTreeById,
  listNavigationBrandTargets,
  listNavigationCategoryTargets,
  listNavigationCollectionTargets,
  listNavigationFamilyTargets,
  listNavigationLocalizations,
  listNavigationNodes,
  listNavigationSavedQueries,
  listNavigationSavedQueryAttributes,
  type NavigationNodeRow,
  type NavigationTargetRow,
  type NavigationTreeRow,
} from '../../db/navigation/navigationRepository.js';
import { navigationEtag } from './etag.js';
import { navigationFallbackChain, type NavigationLabelRow } from './localization.js';
import {
  projectNavigationNodes,
  type NavigationProjectionContext,
  type ResolvedTarget,
} from './projection.js';

/** What the public read is asked for. */
export interface NavigationReadParams {
  readonly market: string;
  readonly locale: string;
  readonly surface?: NavigationSurface;
  /** The instant the schedule is evaluated at. Injected, never read here. */
  readonly at: Date;
}

/** Non-null ids of one pointer column, de-duplicated. */
function pointerIds(
  nodes: readonly NavigationNodeRow[],
  pick: (node: NavigationNodeRow) => string | null,
): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    const id = pick(node);
    if (id !== null && id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** A target-row list as the map the projection takes. */
function targetMap(rows: readonly NavigationTargetRow[]): Map<string, ResolvedTarget> {
  const map = new Map<string, ResolvedTarget>();
  for (const row of rows) {
    map.set(row.id, { identifier: row.identifier, publiclyVisible: row.publiclyVisible === true });
  }
  return map;
}

/**
 * The saved queries the given nodes point at, with their attribute filters.
 *
 * The price bound is emitted only when BOTH an amount and its currency are
 * present — the row CHECKs make a half bound unwritable, and re-deriving it here
 * rather than trusting the row means a filter that somehow lost its currency is
 * dropped instead of being served as an unpriced comparison.
 */
async function loadSavedQueries(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<Map<string, NavigationSavedQueryView>> {
  const map = new Map<string, NavigationSavedQueryView>();
  if (ids.length === 0) return map;

  const [rows, attributes] = await Promise.all([
    listNavigationSavedQueries(db, ids),
    listNavigationSavedQueryAttributes(db, ids),
  ]);
  for (const row of rows) {
    const filters = attributes
      .filter((attribute) => attribute.savedQueryId === row.id)
      .map((attribute) => ({ attributeKey: attribute.attributeKey, values: attribute.values }));
    // Whichever bound is present carries the currency; the agreement CHECK is
    // what makes reading either one safe when both are.
    const priceCurrency = row.priceMinCurrency ?? row.priceMaxCurrency;
    const hasPrice =
      priceCurrency !== null && (row.priceMinAmount !== null || row.priceMaxAmount !== null);
    map.set(row.id, {
      id: row.id,
      key: row.key,
      ...(row.queryText === null ? {} : { queryText: row.queryText }),
      ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
      brandIds: row.brandIds,
      merchantIds: row.merchantIds,
      conditionGroups: row.conditionGroups as NavigationSavedQueryView['conditionGroups'],
      availability: row.availability as NavigationSavedQueryView['availability'],
      offerKinds: row.offerKinds as NavigationSavedQueryView['offerKinds'],
      officialChannelOnly: row.officialChannelOnly === true,
      ...(row.market === null ? {} : { market: row.market }),
      ...(hasPrice
        ? {
            price: {
              currency: priceCurrency as NonNullable<
                NavigationSavedQueryView['price']
              >['currency'],
              ...(row.priceMinAmount === null ? {} : { minAmount: row.priceMinAmount }),
              ...(row.priceMaxAmount === null ? {} : { maxAmount: row.priceMaxAmount }),
            },
          }
        : {}),
      attributes: filters,
    });
  }
  return map;
}

/** Everything the projection needs, read in one batch per kind. */
async function buildProjectionContext(
  db: DatabaseOrTransaction,
  nodes: readonly NavigationNodeRow[],
  requestedLocale: string,
  at: Date,
): Promise<NavigationProjectionContext> {
  const localeChain = navigationFallbackChain(requestedLocale);
  const nodeIds = nodes.map((node) => node.id);

  const [labels, categories, brands, families, collections, savedQueries] = await Promise.all([
    listNavigationLocalizations(db, nodeIds, localeChain),
    listNavigationCategoryTargets(
      db,
      pointerIds(nodes, (node) => node.categoryId),
    ),
    listNavigationBrandTargets(
      db,
      pointerIds(nodes, (node) => node.brandId),
    ),
    listNavigationFamilyTargets(
      db,
      pointerIds(nodes, (node) => node.productFamilyId),
    ),
    listNavigationCollectionTargets(
      db,
      pointerIds(nodes, (node) => node.collectionId),
    ),
    loadSavedQueries(
      db,
      pointerIds(nodes, (node) => node.savedQueryId),
    ),
  ]);

  const labelsByNodeId = new Map<string, NavigationLabelRow[]>();
  for (const row of labels) {
    const existing = labelsByNodeId.get(row.nodeId);
    if (existing === undefined) labelsByNodeId.set(row.nodeId, [row]);
    else existing.push(row);
  }

  return {
    requestedLocale,
    localeChain,
    at,
    labelsByNodeId,
    categories: targetMap(categories),
    brands: targetMap(brands),
    families: targetMap(families),
    collections: targetMap(collections),
    savedQueries,
  };
}

/** A tree row plus its projected nodes, as the DTO. */
function toTreeView(
  tree: NavigationTreeRow,
  nodes: NavigationTreeView['nodes'],
): NavigationTreeView {
  return {
    id: tree.id,
    key: tree.key,
    version: tree.version,
    market: tree.market,
    locale: tree.locale,
    surface: tree.surface,
    ...(tree.publishedAt === null ? {} : { publishedAt: tree.publishedAt.toISOString() }),
    ...(tree.effectiveFrom === null ? {} : { effectiveFrom: tree.effectiveFrom.toISOString() }),
    ...(tree.effectiveTo === null ? {} : { effectiveTo: tree.effectiveTo.toISOString() }),
    nodes,
  };
}

/**
 * The public read: every tree that is live for one `(market, locale)` now.
 *
 * A DRAFT can never reach this — `findLiveNavigationTrees` filters on the
 * published lifecycle AND the window, and the two together are what "live"
 * means. An empty answer is a real answer (a market nobody has configured), not
 * an error: a storefront that cannot render a menu renders no menu, and 404ing
 * would make an unconfigured market look like a broken deployment.
 */
export async function readPublishedNavigation(
  db: DatabaseOrTransaction,
  params: NavigationReadParams,
): Promise<NavigationResponse> {
  const trees = await findLiveNavigationTrees(db, params);
  if (trees.length === 0) {
    const empty = {
      market: params.market,
      requestedLocale: params.locale,
      trees: [],
      withheldNodeCount: 0,
    };
    return { ...empty, etag: navigationEtag(empty) };
  }

  const nodes = await listNavigationNodes(
    db,
    trees.map((tree) => tree.id),
  );
  const context = await buildProjectionContext(db, nodes, params.locale, params.at);

  let withheldNodeCount = 0;
  const views: NavigationTreeView[] = [];
  for (const tree of trees) {
    const projection = projectNavigationNodes(
      nodes.filter((node) => node.treeId === tree.id),
      context,
    );
    withheldNodeCount += projection.withheld.length;
    views.push(toTreeView(tree, projection.nodes));
  }

  const body = {
    market: params.market,
    requestedLocale: params.locale,
    trees: views,
    withheldNodeCount,
  };
  return { ...body, etag: navigationEtag(body) };
}

/**
 * The operator preview: one tree, whatever its lifecycle, plus the reasons.
 *
 * The locale defaults to the TREE's own, because a tree is authored for one
 * `(market, locale)` and previewing it in another would exercise a fallback
 * chain no shopper of that tree will ever take. It is overridable precisely so
 * an operator can check what a fallback produces.
 */
export async function previewNavigationTree(
  db: DatabaseOrTransaction,
  params: { readonly treeId: string; readonly locale?: string; readonly at: Date },
): Promise<NavigationPreviewResponse | undefined> {
  const tree = await findNavigationTreeById(db, params.treeId);
  if (tree === undefined) return undefined;

  const nodes = await listNavigationNodes(db, [tree.id]);
  const locale = params.locale ?? tree.locale;
  const context = await buildProjectionContext(db, nodes, locale, params.at);
  const projection = projectNavigationNodes(nodes, context);
  const view = toTreeView(tree, projection.nodes);

  return {
    tree: view,
    lifecycle: tree.lifecycle as NavigationTreeLifecycle,
    internalLabel: tree.internalLabel,
    withheld: projection.withheld,
    etag: navigationEtag(view),
  };
}
