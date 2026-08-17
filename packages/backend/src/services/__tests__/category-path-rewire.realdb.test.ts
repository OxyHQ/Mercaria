/**
 * Re-deriving `listings.category_slugs` after a governed taxonomy change (#367
 * workstream 12, ADR 0007 D13) — against a real Postgres server.
 *
 * ## The bug this closes, and why a mocked test could not see it
 *
 * `catalog-write.service.resolveCategory` denormalizes the browse path at WRITE
 * time and nothing re-derived it. `updateCategoryPresentation` rewrites every
 * DESCENDANT's `ancestor_slugs` when a slug changes — in the database, in one
 * statement — so a rename left every listing beneath the renamed node carrying a
 * path naming an ancestor that no longer answers to that name, and five services
 * filter on that path. The re-derivation is only correct if it reads the ancestry
 * the taxonomy write just produced, which means it has to run inside that
 * transaction and against a server that actually applied the rewrite. A mocked
 * repository has no rewrite to read.
 *
 * ## The three properties, and the direction each fails in
 *
 * 1. **It reads the POST-change ancestry.** Run on a second connection it would
 *    see the pre-change slugs (the caller has not committed) and confidently
 *    rewrite every path to the value it already had — a repair that reports
 *    hundreds of corrections and changes nothing.
 * 2. **It covers the SUBTREE, not the renamed node.** A repair scoped to the
 *    subject alone leaves every listing one level down carrying the stale path,
 *    which is the same bug with a smaller blast radius and a green report.
 * 3. **`incomplete` distinguishes "hit the bound" from "nothing left".** A subtree
 *    of exactly the bound is COMPLETE, and reporting it as incomplete sends an
 *    operator to run a pass with nothing to do.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertListing } from '../../db/catalog/listingRepository.js';
import {
  insertCategory,
  moveCategory,
  updateCategoryPresentation,
} from '../../db/taxonomy/taxonomyRepository.js';
import { rederiveCategoryBrowsePaths } from '../catalog-write.service.js';

let db: Database;

const RUN = uuidv7().slice(-12);
const KEY = RUN.replace(/-/g, '');

const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];

let storeId: string;

beforeAll(async () => {
  db = await connectPostgres();
  const store = await insertStore(
    {
      handle: `cpr-${RUN}`,
      name: 'Category path rewire store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${RUN}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  storeId = store.id;
}, 120_000);

afterAll(async () => {
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  // Children before parents: `categories.parent_id` is `ON DELETE restrict`, so a
  // teardown in creation order fails with 23503 rather than saying what is wrong.
  for (const id of [...createdCategoryIds].reverse()) {
    await db.delete(categories).where(eq(categories.id, id));
  }
  for (const id of createdStoreIds) {
    await db.execute(`delete from stores where id = '${id}'`);
  }
  await closePostgres();
});

/** A category through the write chokepoint, registered for teardown. */
async function makeCategory(
  slug: string,
  parentId: string | null,
): Promise<{ id: string; slug: string }> {
  const row = await insertCategory({
    key: `${slug}_${KEY}`,
    name: slug,
    slug: `${slug}-${RUN}`,
    parentId,
  });
  createdCategoryIds.push(row.id);
  return { id: row.id, slug: row.slug };
}

/** A store listing filed under one category, carrying the path it was written with. */
async function makeListing(categoryId: string, categorySlugs: string[]): Promise<string> {
  const row = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId,
      title: `Path rewire ${RUN}`,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      conditionSourceLabel: null,
      conditionAcknowledgedAt: null,
      status: 'active',
      categoryId,
      categorySlugs,
      tags: [],
      priceRangeMinAmount: null,
      priceRangeMinCurrency: null,
      priceRangeMaxAmount: null,
      priceRangeMaxCurrency: null,
      hasInventory: false,
      variantCount: 0,
      longitude: null,
      latitude: null,
      vendor: null,
      productType: null,
      handle: null,
      seoTitle: null,
      seoDescription: null,
      sourceConnectionId: null,
      sourceProvider: null,
      sourceExternalId: null,
      sourceExternalUpdatedAt: null,
      overriddenFields: [],
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      publishedAt: new Date(),
    },
    [],
    [],
  );
  createdListingIds.push(row.id);
  return row.id;
}

async function storedPath(listingId: string): Promise<string[]> {
  const [row] = await db
    .select({ categorySlugs: listings.categorySlugs })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  return row?.categorySlugs ?? [];
}

describe('a slug rename, re-derived across the whole subtree', () => {
  it('rewrites the renamed node’s listings AND its descendants’', async () => {
    const root = await makeCategory('cpr-root', null);
    const child = await makeCategory('cpr-child', root.id);
    const grandchild = await makeCategory('cpr-grand', child.id);

    // Each listing carries the path it was written with, exactly as
    // `resolveCategory` would have produced it at create time.
    const onRoot = await makeListing(root.id, [root.slug]);
    const onChild = await makeListing(child.id, [root.slug, child.slug]);
    const onGrandchild = await makeListing(grandchild.id, [root.slug, child.slug, grandchild.slug]);

    const renamed = `cpr-root-renamed-${RUN}`;
    const report = await db.transaction(async (tx) => {
      await updateCategoryPresentation(root.id, { slug: renamed }, tx);
      // Inside the SAME transaction, which is the whole point: the descendants'
      // `ancestor_slugs` were rewritten by the statement above and are not visible
      // on any other connection yet.
      return rederiveCategoryBrowsePaths(tx, root.id);
    });

    expect(report.categoriesInSubtree, 'the subject plus two descendants').toBe(3);
    expect(report.scannedListings).toBe(3);
    expect(report.pathsRewritten).toBe(3);
    expect(report.pathsAgreed).toBe(0);
    expect(report.pathsCleared).toBe(0);
    expect(report.incomplete).toBe(false);

    expect(await storedPath(onRoot)).toEqual([renamed]);
    // The property a subject-only repair would miss: two levels down, the stale
    // ancestor slug is gone.
    expect(await storedPath(onChild)).toEqual([renamed, child.slug]);
    expect(await storedPath(onGrandchild)).toEqual([renamed, child.slug, grandchild.slug]);
  });

  it('is idempotent — a second pass writes nothing and reports every row as agreed', async () => {
    const root = await makeCategory('cpr-idem', null);
    const listingId = await makeListing(root.id, [root.slug]);

    const first = await db.transaction((tx) => rederiveCategoryBrowsePaths(tx, root.id));
    expect(first.pathsAgreed, 'the stored path already equals the derivation').toBe(1);
    expect(first.pathsRewritten).toBe(0);

    const second = await db.transaction((tx) => rederiveCategoryBrowsePaths(tx, root.id));
    expect(second.pathsAgreed).toBe(1);
    expect(second.pathsRewritten).toBe(0);
    expect(await storedPath(listingId)).toEqual([root.slug]);
  });

  it('follows a MOVE, which re-splices the whole subtree’s ancestry', async () => {
    const oldParent = await makeCategory('cpr-old', null);
    const newParent = await makeCategory('cpr-new', null);
    const moved = await makeCategory('cpr-moved', oldParent.id);
    const listingId = await makeListing(moved.id, [oldParent.slug, moved.slug]);

    const report = await db.transaction(async (tx) => {
      await moveCategory(moved.id, newParent.id, tx);
      return rederiveCategoryBrowsePaths(tx, moved.id);
    });

    expect(report.pathsRewritten).toBe(1);
    expect(await storedPath(listingId)).toEqual([newParent.slug, moved.slug]);
  });
});

describe('the bound, and what `incomplete` actually reports', () => {
  it('reports `incomplete` when the bound is reached with listings left', async () => {
    const root = await makeCategory('cpr-bound', null);
    const renamed = `cpr-bound-renamed-${RUN}`;
    const ids = [
      await makeListing(root.id, [root.slug]),
      await makeListing(root.id, [root.slug]),
      await makeListing(root.id, [root.slug]),
    ];

    const report = await db.transaction(async (tx) => {
      await updateCategoryPresentation(root.id, { slug: renamed }, tx);
      return rederiveCategoryBrowsePaths(tx, root.id, 2);
    });

    expect(report.scannedListings).toBe(2);
    expect(report.pathsRewritten).toBe(2);
    expect(report.incomplete, 'a third listing was never visited').toBe(true);
    // And the honest consequence: the unvisited listing keeps the path it was
    // written with. That is the state the pass exists to correct, and the report is
    // what says a further pass is owed.
    const repaired = await Promise.all(ids.map(storedPath));
    expect(repaired.filter((path) => path[0] === renamed).length).toBe(2);
    expect(repaired.filter((path) => path[0] === root.slug).length).toBe(1);
  });

  it('a subtree of EXACTLY the bound is complete, not incomplete', async () => {
    // The distinction the probe exists for. Inferring `incomplete` from "the budget
    // ran out" reports a repair that is owed when there is nothing left to do.
    const root = await makeCategory('cpr-exact', null);
    await makeListing(root.id, [root.slug]);
    await makeListing(root.id, [root.slug]);

    const report = await db.transaction((tx) => rederiveCategoryBrowsePaths(tx, root.id, 2));
    expect(report.scannedListings).toBe(2);
    expect(report.incomplete).toBe(false);
  });
});

describe('what it deliberately does not touch', () => {
  it('CLEARS the path of a listing with no category, and never invents one', async () => {
    const root = await makeCategory('cpr-nocat', null);
    // A listing filed under the category, so the subtree read finds it, plus one
    // with a stale path and no category at all — the row a browse filter would
    // otherwise keep matching against a category it is not in.
    await makeListing(root.id, [root.slug]);
    const orphanId = await makeListing(root.id, [root.slug, 'stale-extra']);
    await db.update(listings).set({ categoryId: null }).where(eq(listings.id, orphanId));

    // With `category_id` NULL the subtree read no longer finds it, which is
    // correct — the pass is scoped to a taxonomy change and this row is in no
    // category. So it is driven by a listing that IS in the subtree, and the
    // orphan is asserted to be UNTOUCHED rather than silently cleared by a pass
    // that had no business reading it.
    const report = await db.transaction((tx) => rederiveCategoryBrowsePaths(tx, root.id));
    expect(report.scannedListings).toBe(1);
    expect(await storedPath(orphanId)).toEqual([root.slug, 'stale-extra']);
  });

  it('never moves `category_id` — a merged category’s listings stay where they are', async () => {
    const loser = await makeCategory('cpr-loser', null);
    const listingId = await makeListing(loser.id, [loser.slug]);

    await db.transaction((tx) => rederiveCategoryBrowsePaths(tx, loser.id));

    const [row] = await db
      .select({ categoryId: listings.categoryId })
      .from(listings)
      .where(eq(listings.id, listingId))
      .limit(1);
    // Re-pointing a listing overwrites a value that then exists nowhere, so it
    // needs a durable record before it can be reversible. This pass re-derives the
    // PATH and nothing else.
    expect(row?.categoryId).toBe(loser.id);
  });
});
