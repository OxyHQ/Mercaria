/**
 * The navigation domain against a REAL Postgres server (#367 step 7, ADR 0007
 * D3/D4).
 *
 * Everything here is a property the DATABASE holds and a mocked repository
 * cannot: eight triggers, the seven-biconditional target CHECK, the two partial
 * position indexes, and the publication freeze. A mocked `insert` accepts any
 * statement, including one the server rejects outright — which is the class of
 * bug this file exists to catch, and this is the first run in which these tables
 * exist at all.
 *
 * The two cases worth reading, because they are the ones a plausible schema gets
 * wrong:
 *
 *  - **Two ROOT nodes at position 0.** Postgres treats NULLs as distinct, so a
 *    single `unique(tree_id, parent_id, position)` admits them and the menu's
 *    order becomes whatever the planner returned that day. Two partial indexes
 *    are what refuse it, and the test drives BOTH branches.
 *  - **A `brand` node whose only pointer is a `collection_id`.** The
 *    single-expression spelling of the target CHECK admits exactly that row.
 *    Seven separate biconditionals are what refuse it.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every key this file writes carries a per-run suffix and
 * teardown deletes exactly what it created. Nothing here reads an aggregate over
 * a table another file writes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { withTriggerToggleLock } from './trigger-toggle-lock.js';
import { deleteTestStores } from './store-teardown.js';
import { categories } from '../schema/catalog.js';
import { collections } from '../schema/merchandising.js';
import { stores } from '../schema/stores.js';
import {
  navigationNodeLocalizations,
  navigationNodes,
  navigationSavedQueries,
  navigationSavedQueryAttributeFilters,
  navigationTrees,
} from '../schema/navigation.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

const treeIds: string[] = [];
const categoryIds: string[] = [];
const collectionIds: string[] = [];
const storeIds: string[] = [];
const savedQueryIds: string[] = [];

/** A lowercase machine key this file owns — it must clear the key CHECKs. */
function key(name: string): string {
  return `nav-${name}-${RUN}`.toLowerCase();
}

async function makeCategory(name: string, isActive = true): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({
      key: key(name),
      name: `Nav ${name}`,
      slug: key(name),
      lifecycle: isActive ? 'published' : 'suppressed',
      isActive,
    })
    .returning({ id: categories.id });
  categoryIds.push(row.id);
  return row.id;
}

async function makeCollection(name: string, isPublished = true): Promise<string> {
  const [store] = await db
    .insert(stores)
    .values({
      name: `Nav store ${name} ${RUN}`,
      handle: key(`store-${name}`),
      description: 'A store this file owns',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  storeIds.push(store.id);
  const [row] = await db
    .insert(collections)
    .values({ storeId: store.id, title: `Nav ${name}`, handle: key(name), type: 'manual', isPublished })
    .returning({ id: collections.id });
  collectionIds.push(row.id);
  return row.id;
}

/**
 * A market nobody else in this file uses.
 *
 * At most ONE tree may be live per `(market, locale, surface)` — the whole point
 * of the exclusion trigger — so a fixture that defaulted every tree to one
 * market would make each publishing test depend on which test published first.
 * That is a fixture collision wearing a schema failure's clothes, and it is what
 * the first run of this file actually hit. A per-tree market removes the
 * contention; the exclusion tests then opt IN to a shared one explicitly.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let marketCounter = 0;
function freshMarket(): string {
  const index = marketCounter++;
  return `${ALPHABET[Math.floor(index / 26) % 26]}${ALPHABET[index % 26]}`;
}

/** A DRAFT tree this file owns, in a market of its own unless told otherwise. */
async function makeTree(
  name: string,
  overrides: Partial<typeof navigationTrees.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(navigationTrees)
    .values({
      key: key(name),
      version: 1,
      market: freshMarket(),
      locale: 'es-es',
      surface: 'header_menu',
      internalLabel: `Nav ${name}`,
      lifecycle: 'draft',
      ...overrides,
    })
    .returning({ id: navigationTrees.id });
  treeIds.push(row.id);
  return row.id;
}

/** A node with a category target, which every test that is not about targets uses. */
async function makeNode(
  treeId: string,
  categoryId: string,
  overrides: Partial<typeof navigationNodes.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(navigationNodes)
    .values({
      treeId,
      key: key(`node-${Math.random().toString(36).slice(2, 8)}`),
      position: 0,
      targetKind: 'category',
      categoryId,
      ...overrides,
    })
    .returning({ id: navigationNodes.id });
  return row.id;
}

async function label(nodeId: string, locale = 'es-es', overrides = {}): Promise<void> {
  await db.insert(navigationNodeLocalizations).values({
    nodeId,
    locale,
    label: `Etiqueta ${locale}`,
    status: 'approved',
    provenance: 'mercaria',
    reviewedAt: new Date(),
    reviewedByOxyUserId: `oxy-${RUN}`,
    ...overrides,
  });
}

/** Publish a tree, bypassing the service so the TRIGGERS are what is under test. */
async function publish(treeId: string, window: { from?: Date; to?: Date } = {}): Promise<void> {
  await db
    .update(navigationTrees)
    .set({
      lifecycle: 'published',
      publishedAt: new Date(),
      publishedByOxyUserId: `oxy-${RUN}`,
      ...(window.from === undefined ? {} : { effectiveFrom: window.from }),
      ...(window.to === undefined ? {} : { effectiveTo: window.to }),
    })
    .where(eq(navigationTrees.id, treeId));
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (!db) return;
  // A published tree refuses BOTH the update back to `draft` and the DELETE —
  // that is the freeze this file tests, and it means teardown cannot undo its
  // own fixtures without the house's trigger-toggle window. ONE table, one
  // disable, the delete, the enable: `advisory-lock-census.test.ts` fails the
  // build on a window naming a second table, and nodes and labels CASCADE from
  // the tree rather than being deleted here for that reason.
  if (treeIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table navigation_trees disable trigger mercaria_navigation_published_tree_immutable`,
      );
      await tx.delete(navigationTrees).where(inArray(navigationTrees.id, treeIds));
      await tx.execute(
        sql`alter table navigation_trees enable trigger mercaria_navigation_published_tree_immutable`,
      );
    });
  }
  if (savedQueryIds.length > 0) {
    await db
      .delete(navigationSavedQueries)
      .where(inArray(navigationSavedQueries.id, savedQueryIds));
  }
  if (collectionIds.length > 0) {
    await db.delete(collections).where(inArray(collections.id, collectionIds));
  }
  // Through the shared helper, never a direct delete: a canonical link minted by
  // the backfill would refuse one, and the census fails the build on any fixture
  // that reaches for `delete(stores)` itself.
  await deleteTestStores(db, storeIds);
  if (categoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  }
  await closePostgres();
});

describe('a node targets exactly one thing (the seven-biconditional CHECK)', () => {
  it('accepts each of the seven kinds with its own pointer', async () => {
    const treeId = await makeTree('targets');
    const categoryId = await makeCategory('targets-cat');
    const collectionId = await makeCollection('targets-col');
    const [saved] = await db
      .insert(navigationSavedQueries)
      .values({ key: key('sq-targets'), internalLabel: 'Saved' })
      .returning({ id: navigationSavedQueries.id });
    savedQueryIds.push(saved.id);

    const accepted = [
      { targetKind: 'category' as const, categoryId },
      { targetKind: 'collection' as const, collectionId },
      { targetKind: 'saved_query' as const, savedQueryId: saved.id },
      { targetKind: 'product_type' as const, productTypeKey: 'smartphone' },
      { targetKind: 'campaign' as const, campaignUrl: 'https://example.test/promo' },
    ];
    for (const [index, target] of accepted.entries()) {
      await db.insert(navigationNodes).values({
        treeId,
        key: key(`ok-${index}`),
        position: index,
        ...target,
      });
    }
    const rows = await db.select().from(navigationNodes).where(eq(navigationNodes.treeId, treeId));
    expect(rows).toHaveLength(accepted.length);
  });

  it('REFUSES a brand node whose only pointer is a collection — the case one expression admits', async () => {
    const treeId = await makeTree('mismatch');
    const collectionId = await makeCollection('mismatch-col');
    await expect(
      db.insert(navigationNodes).values({
        treeId,
        key: key('mismatch'),
        position: 0,
        targetKind: 'brand',
        collectionId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES two pointers at once, and a kind with no pointer at all', async () => {
    const treeId = await makeTree('two-pointers');
    const categoryId = await makeCategory('two-cat');
    const collectionId = await makeCollection('two-col');
    await expect(
      db.insert(navigationNodes).values({
        treeId,
        key: key('two'),
        position: 0,
        targetKind: 'category',
        categoryId,
        collectionId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insert(navigationNodes)
        .values({ treeId, key: key('none'), position: 1, targetKind: 'category' }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a campaign destination that is not https', async () => {
    const treeId = await makeTree('scheme');
    await expect(
      db.insert(navigationNodes).values({
        treeId,
        key: key('scheme'),
        position: 0,
        targetKind: 'campaign',
        campaignUrl: 'http://example.test/promo',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('sibling order is unique — and NULL parents are the case that gets missed', () => {
  it('REFUSES two ROOT nodes at the same position', async () => {
    const treeId = await makeTree('roots');
    const categoryId = await makeCategory('roots-cat');
    await makeNode(treeId, categoryId, { key: key('root-a'), position: 0 });
    await expect(
      makeNode(treeId, categoryId, { key: key('root-b'), position: 0 }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('REFUSES two CHILDREN of one parent at the same position', async () => {
    const treeId = await makeTree('children');
    const categoryId = await makeCategory('children-cat');
    const parentId = await makeNode(treeId, categoryId, { key: key('parent'), position: 0 });
    await makeNode(treeId, categoryId, { key: key('child-a'), position: 0, parentId });
    await expect(
      makeNode(treeId, categoryId, { key: key('child-b'), position: 0, parentId }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('ALLOWS the same position under different parents — the index is per parent', async () => {
    const treeId = await makeTree('siblings');
    const categoryId = await makeCategory('siblings-cat');
    const parentA = await makeNode(treeId, categoryId, { key: key('pa'), position: 0 });
    const parentB = await makeNode(treeId, categoryId, { key: key('pb'), position: 1 });
    await makeNode(treeId, categoryId, { key: key('ca'), position: 0, parentId: parentA });
    await makeNode(treeId, categoryId, { key: key('cb'), position: 0, parentId: parentB });
    const rows = await db
      .select()
      .from(navigationNodes)
      .where(and(eq(navigationNodes.treeId, treeId), eq(navigationNodes.position, 0)));
    expect(rows).toHaveLength(3);
  });
});

describe('a tree is a TREE (mercaria_navigation_node_acyclic)', () => {
  it('REFUSES a node that is its own parent', async () => {
    const treeId = await makeTree('self');
    const categoryId = await makeCategory('self-cat');
    const nodeId = await makeNode(treeId, categoryId, { key: key('self'), position: 0 });
    await expect(
      db
        .update(navigationNodes)
        .set({ parentId: nodeId })
        .where(eq(navigationNodes.id, nodeId)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a two-node cycle', async () => {
    const treeId = await makeTree('cycle');
    const categoryId = await makeCategory('cycle-cat');
    const a = await makeNode(treeId, categoryId, { key: key('cyc-a'), position: 0 });
    const b = await makeNode(treeId, categoryId, { key: key('cyc-b'), position: 1, parentId: a });
    await expect(
      db.update(navigationNodes).set({ parentId: b }).where(eq(navigationNodes.id, a)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a parent in a DIFFERENT tree, which no foreign key can see', async () => {
    const treeA = await makeTree('cross-a');
    const treeB = await makeTree('cross-b');
    const categoryId = await makeCategory('cross-cat');
    const foreignParent = await makeNode(treeA, categoryId, { key: key('foreign'), position: 0 });
    await expect(
      makeNode(treeB, categoryId, { key: key('adopted'), position: 0, parentId: foreignParent }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a chain deeper than the bound, and ACCEPTS one at the bound', async () => {
    const treeId = await makeTree('depth');
    const categoryId = await makeCategory('depth-cat');
    let parentId: string | undefined;
    // Depths 0..5 are six levels and are all legal.
    for (let depth = 0; depth < 6; depth += 1) {
      parentId = await makeNode(treeId, categoryId, {
        key: key(`depth-${depth}`),
        position: depth,
        ...(parentId === undefined ? {} : { parentId }),
      });
    }
    await expect(
      makeNode(treeId, categoryId, { key: key('depth-6'), position: 6, parentId }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a re-parent that would push an existing SUBTREE past the bound', async () => {
    // The half that is easy to miss: checking only the ancestors above the moved
    // node admits a deep subtree grafted onto a deep branch.
    const treeId = await makeTree('graft');
    const categoryId = await makeCategory('graft-cat');
    let deepBranch: string | undefined;
    for (let depth = 0; depth < 4; depth += 1) {
      deepBranch = await makeNode(treeId, categoryId, {
        key: key(`branch-${depth}`),
        position: depth,
        ...(deepBranch === undefined ? {} : { parentId: deepBranch }),
      });
    }
    const subtreeRoot = await makeNode(treeId, categoryId, { key: key('sub-0'), position: 10 });
    let child = subtreeRoot;
    for (let depth = 1; depth < 4; depth += 1) {
      child = await makeNode(treeId, categoryId, {
        key: key(`sub-${depth}`),
        position: depth,
        parentId: child,
      });
    }
    await expect(
      db
        .update(navigationNodes)
        .set({ parentId: deepBranch })
        .where(eq(navigationNodes.id, subtreeRoot)),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('publication freezes the tree and its content', () => {
  it('freezes the key, the scope and the version', async () => {
    const treeId = await makeTree('frozen-identity');
    await expect(
      db.update(navigationTrees).set({ key: key('renamed') }).where(eq(navigationTrees.id, treeId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.update(navigationTrees).set({ market: 'FR' }).where(eq(navigationTrees.id, treeId)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a node change on a published tree, and PERMITS a visibility change', async () => {
    const treeId = await makeTree('frozen-nodes');
    const categoryId = await makeCategory('frozen-cat');
    const nodeId = await makeNode(treeId, categoryId, { key: key('frozen-node'), position: 0 });
    await label(nodeId);
    await publish(treeId);

    await expect(
      db.update(navigationNodes).set({ position: 5 }).where(eq(navigationNodes.id, nodeId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(navigationNodes).values({
        treeId,
        key: key('late'),
        position: 9,
        targetKind: 'category',
        categoryId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.delete(navigationNodes).where(eq(navigationNodes.id, nodeId)),
    ).rejects.toSatisfy(isCheckViolation);

    // The ONE exception: the incident lever.
    await db
      .update(navigationNodes)
      .set({ visibility: 'hidden' })
      .where(eq(navigationNodes.id, nodeId));
    const [row] = await db
      .select({ visibility: navigationNodes.visibility })
      .from(navigationNodes)
      .where(eq(navigationNodes.id, nodeId));
    expect(row.visibility).toBe('hidden');
  });

  it('refuses a LABEL change on a published tree', async () => {
    const treeId = await makeTree('frozen-labels');
    const categoryId = await makeCategory('frozen-label-cat');
    const nodeId = await makeNode(treeId, categoryId, { key: key('label-node'), position: 0 });
    await label(nodeId);
    await publish(treeId);
    await expect(
      db
        .update(navigationNodeLocalizations)
        .set({ label: 'Cambiado' })
        .where(eq(navigationNodeLocalizations.nodeId, nodeId)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses un-publishing and refuses DELETE of a published tree', async () => {
    const treeId = await makeTree('unpublish');
    await publish(treeId);
    await expect(
      db
        .update(navigationTrees)
        .set({ lifecycle: 'draft', publishedAt: null, publishedByOxyUserId: null })
        .where(eq(navigationTrees.id, treeId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.delete(navigationTrees).where(eq(navigationTrees.id, treeId)),
    ).rejects.toSatisfy(isCheckViolation);
    // …and ENDING it is still permitted, which is the whole exception.
    await db
      .update(navigationTrees)
      .set({ effectiveTo: new Date(Date.now() + 86_400_000) })
      .where(eq(navigationTrees.id, treeId));
  });
});

describe('at most one live tree per (market, locale, surface)', () => {
  it('REFUSES a second published tree over an overlapping window', async () => {
    const market = freshMarket();
    const first = await makeTree('overlap-a', { key: key('overlap-a'), market });
    const second = await makeTree('overlap-b', { key: key('overlap-b'), market });
    await publish(first);
    await expect(publish(second)).rejects.toSatisfy(isCheckViolation);
  });

  it('ACCEPTS a successor scheduled to begin exactly where the incumbent ends', async () => {
    const cut = new Date(Date.now() + 3_600_000);
    const market = freshMarket();
    const incumbent = await makeTree('sched-a', {
      key: key('sched-a'),
      market,
      surface: 'footer_menu',
    });
    const successor = await makeTree('sched-b', {
      key: key('sched-b'),
      market,
      surface: 'footer_menu',
    });
    await publish(incumbent, { to: cut });
    // Half-open: [from, to) — so a successor starting at the cut does not overlap.
    await publish(successor, { from: cut });
    const rows = await db
      .select({ id: navigationTrees.id })
      .from(navigationTrees)
      .where(
        and(
          inArray(navigationTrees.id, [incumbent, successor]),
          eq(navigationTrees.lifecycle, 'published'),
        ),
      );
    expect(rows).toHaveLength(2);
  });

  it('ACCEPTS the same window on a DIFFERENT surface', async () => {
    // Same market and locale, DIFFERENT surface: the exclusion is per surface,
    // so a header menu and a campaign strip are both live at once.
    const market = freshMarket();
    const header = await makeTree('surf-a', {
      key: key('surf-a'),
      market,
      surface: 'category_rail',
    });
    const footer = await makeTree('surf-b', {
      key: key('surf-b'),
      market,
      surface: 'campaign_banner',
    });
    await publish(header);
    await publish(footer);
    const rows = await db
      .select({ id: navigationTrees.id })
      .from(navigationTrees)
      .where(
        and(
          inArray(navigationTrees.id, [header, footer]),
          eq(navigationTrees.lifecycle, 'published'),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});

describe('machine translation cannot overwrite human work (ADR 0007 D4)', () => {
  it('REFUSES a machine update onto an approved label, and PERMITS marking it stale', async () => {
    const treeId = await makeTree('d4');
    const categoryId = await makeCategory('d4-cat');
    const nodeId = await makeNode(treeId, categoryId, { key: key('d4-node'), position: 0 });
    await label(nodeId);

    await expect(
      db
        .update(navigationNodeLocalizations)
        .set({ label: 'Traducción automática', provenance: 'machine' })
        .where(eq(navigationNodeLocalizations.nodeId, nodeId)),
    ).rejects.toSatisfy(isCheckViolation);

    // D4 requires a source change to mark dependents STALE rather than blank
    // them, so the same row may still change status without changing the text.
    await db
      .update(navigationNodeLocalizations)
      .set({ status: 'stale' })
      .where(eq(navigationNodeLocalizations.nodeId, nodeId));
    const [row] = await db
      .select({ status: navigationNodeLocalizations.status, label: navigationNodeLocalizations.label })
      .from(navigationNodeLocalizations)
      .where(eq(navigationNodeLocalizations.nodeId, nodeId));
    expect(row.status).toBe('stale');
    expect(row.label).toBe('Etiqueta es-es');
  });

  it('REFUSES a reviewed status with no reviewer, and an empty label', async () => {
    const treeId = await makeTree('d4-shape');
    const categoryId = await makeCategory('d4-shape-cat');
    const nodeId = await makeNode(treeId, categoryId, { key: key('d4-shape-node'), position: 0 });
    await expect(
      db.insert(navigationNodeLocalizations).values({
        nodeId,
        locale: 'es-es',
        label: 'Sin revisor',
        status: 'approved',
        provenance: 'mercaria',
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(navigationNodeLocalizations).values({
        nodeId,
        locale: 'fr',
        label: '   ',
        status: 'machine_translated',
        provenance: 'machine',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('a stable key is frozen, and a saved query holds a real filter', () => {
  it('REFUSES renaming a saved query key', async () => {
    const [row] = await db
      .insert(navigationSavedQueries)
      .values({ key: key('sq-frozen'), internalLabel: 'Frozen' })
      .returning({ id: navigationSavedQueries.id });
    savedQueryIds.push(row.id);
    await expect(
      db
        .update(navigationSavedQueries)
        .set({ key: key('sq-renamed') })
        .where(eq(navigationSavedQueries.id, row.id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a price bound whose two ends disagree on currency, and one with no currency', async () => {
    await expect(
      db.insert(navigationSavedQueries).values({
        key: key('sq-fx'),
        internalLabel: 'Mixed',
        priceMinAmount: 100,
        priceMinCurrency: 'EUR',
        priceMaxAmount: 900,
        priceMaxCurrency: 'USD',
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insert(navigationSavedQueries)
        .values({ key: key('sq-half'), internalLabel: 'Half', priceMinAmount: 100 }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES an attribute filter with no values — `cardinality`, not `array_length`', async () => {
    const [row] = await db
      .insert(navigationSavedQueries)
      .values({ key: key('sq-attr'), internalLabel: 'Attrs' })
      .returning({ id: navigationSavedQueries.id });
    savedQueryIds.push(row.id);
    // `array_length('{}', 1)` is NULL and a CHECK reads NULL as satisfied, so
    // the obvious spelling ADMITS this row. That it is refused is the test.
    await expect(
      db.insert(navigationSavedQueryAttributeFilters).values({
        savedQueryId: row.id,
        attributeKey: 'color',
        values: [],
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('the tree row itself', () => {
  it('REFUSES a draft carrying a publication instant, and a published one without', async () => {
    await expect(
      db.insert(navigationTrees).values({
        key: key('bad-draft'),
        version: 1,
        market: 'ES',
        locale: 'es-es',
        surface: 'header_menu',
        internalLabel: 'Bad draft',
        lifecycle: 'draft',
        publishedAt: new Date(),
        publishedByOxyUserId: `oxy-${RUN}`,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(navigationTrees).values({
        key: key('bad-published'),
        version: 1,
        market: 'ES',
        locale: 'es-es',
        surface: 'header_menu',
        internalLabel: 'Bad published',
        lifecycle: 'published',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a market or locale in the wrong shape', async () => {
    for (const overrides of [{ market: 'es' }, { locale: 'es-ES' }, { locale: 'Español' }]) {
      await expect(
        db.insert(navigationTrees).values({
          key: key(`shape-${Math.random().toString(36).slice(2, 8)}`),
          version: 1,
          market: freshMarket(),
          locale: 'es-es',
          surface: 'header_menu',
          internalLabel: 'Shape',
          ...overrides,
        }),
      ).rejects.toSatisfy(isCheckViolation);
    }
  });

  it('REFUSES a window that ends before it begins', async () => {
    const now = Date.now();
    await expect(
      db.insert(navigationTrees).values({
        key: key('bad-window'),
        version: 1,
        market: 'ES',
        locale: 'es-es',
        surface: 'header_menu',
        internalLabel: 'Bad window',
        effectiveFrom: new Date(now + 3_600_000),
        effectiveTo: new Date(now),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('the migration applied what it claims', () => {
  it('created all eight triggers and all nine functions', async () => {
    // The vacuity floor for this whole file: every refusal above would also pass
    // if the trigger were missing and the CHECK alone were doing the work, so
    // the population is asserted directly.
    const triggers = await db.execute<{ tgname: string }>(sql`
      select tgname from pg_trigger
      where not tgisinternal and tgname like 'mercaria_navigation%'
      order by tgname
    `);
    expect(triggers.map((row) => row.tgname)).toEqual([
      'mercaria_navigation_freeze_saved_query_key',
      'mercaria_navigation_freeze_tree_identity',
      'mercaria_navigation_localization_review_protected',
      'mercaria_navigation_node_acyclic',
      'mercaria_navigation_published_labels_frozen',
      'mercaria_navigation_published_nodes_frozen',
      'mercaria_navigation_published_tree_immutable',
      'mercaria_navigation_tree_window_exclusion',
    ]);

    const functions = await db.execute<{ proname: string }>(sql`
      select proname from pg_proc where proname like 'mercaria_navigation%'
    `);
    expect(functions).toHaveLength(9);
  });

  it('created both partial position indexes, with their predicates', async () => {
    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where tablename = 'navigation_nodes' and indexname like '%position%'
      order by indexname
    `);
    expect(indexes.map((row) => row.indexname)).toEqual([
      'navigation_nodes_child_position_key',
      'navigation_nodes_root_position_key',
    ]);
    // The predicates are the whole point: without them one index would admit
    // two roots at position 0.
    expect(indexes[0].indexdef).toContain('WHERE (parent_id IS NOT NULL)');
    expect(indexes[1].indexdef).toContain('WHERE (parent_id IS NULL)');
  });
});
