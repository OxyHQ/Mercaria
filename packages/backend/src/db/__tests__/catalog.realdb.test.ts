/**
 * The catalogue repositories, against a REAL Postgres database.
 *
 * The service-level suites mock these functions, which is right for what they
 * test — which status a seller may set, whether a rule set is disjunctive — and
 * blind to everything below. A mocked repository accepts any argument and
 * returns whatever the test says, so a guard that is not a guard, an aggregate
 * that skips its update, an `ILIKE` needle that matches the whole catalogue and
 * a keyset page that never advances all look identical to a passing suite.
 *
 * Every block here covers something only a server can answer:
 *
 *  - the inventory guard is a real conditional write, so exactly ONE of two
 *    concurrent reserves past the stock may win;
 *  - `recomputeListingFacets` writes NULLs when a listing loses its last
 *    variant — the empty-aggregate case that returns NO ROW under a `FROM`
 *    clause and would silently skip the update;
 *  - the rule translator's `ILIKE` needles are escaped, which a `%` and a `_` in
 *    the value are the only way to observe;
 *  - the keyset page advances across ids of BOTH shapes at an identical
 *    `published_at`, which is the whole reason the tie-breaker is there;
 *  - `favorite_count` clamps at zero without losing a concurrent increment;
 *  - a combined text + geo query really ANDs, checked with a term that matches
 *    NOTHING so a filter that silently dropped the text would fail.
 */

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { inventoryLevels, listings, productVariants } from '../schema/catalog.js';
import { collections, listingCollections } from '../schema/merchandising.js';
import { favorites } from '../schema/buyers.js';
import { deleteTestStores } from './store-teardown.js';
import { insertStore } from '../stores/storeRepository.js';
import { insertLocation } from '../stores/locationRepository.js';
import {
  adjustFavoriteCount,
  findListingById,
  insertListing,
  recomputeListingFacets,
  searchListingsKeyset,
  searchListingsPage,
  findStoreListingIdsMatching,
} from '../catalog/listingRepository.js';
import {
  countVariants,
  deleteVariant,
  findVariantBySourceInventoryItemId,
  findVariantsByListing,
  findVariantsByListingAndSku,
  insertVariants,
  recomputeVariantRollup,
  reserveVariantScalar,
  updateVariant as updateVariantColumns,
} from '../catalog/variantRepository.js';
import { upsertConnection } from '../connectors/connectionRepository.js';
import { insertLevels, reserveAtLocation, setLevelAvailable } from '../catalog/inventoryLevelRepository.js';
import {
  findCollectionProductsPage,
  insertCollection,
  reconcileAutomatedMembership,
  replaceManualMembership,
  setListingAutomatedMemberships,
} from '../merchandising/collectionRepository.js';
import { escapeLikeNeedle, translateRules } from '../merchandising/collectionRules.js';
import {
  deleteFavorite,
  findFavoriteListingIdsPage,
  findSavedListingIds,
  insertFavorite,
} from '../buyers/favoriteRepository.js';

let db: Database;

/** Store ids created by a test, dropped afterwards so the shared database stays clean. */
const createdStoreIds: string[] = [];

/** A 24-character ObjectId-shaped hex id — the shape every PRE-CUTOVER row carries. */
function legacyHexId(): string {
  return uuidv7().replace(/-/g, '').slice(0, 24);
}

/** Create a store through the repository and register it for cleanup. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `catalog-${suffix}`,
      name: 'Catalog realdb store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A store-owned listing with no variants yet. */
async function makeListing(
  storeId: string,
  overrides: Partial<Parameters<typeof insertListing>[0]> = {},
): Promise<string> {
  const row = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId,
      productTypeDefinitionId: null,
      title: 'Realdb product',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      conditionSourceLabel: null,
      conditionAcknowledgedAt: null,
      status: 'active',
      categoryId: null,
      categorySlugs: [],
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
      ...overrides,
    },
    [],
    [],
  );
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // `listings.store_id` is RESTRICT, so the listings — and their cascading
    // variants, levels, memberships and favorites — go before the store does.
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(collections).where(eq(collections.storeId, storeId));
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the guarded stock decrement', () => {
  it('lets exactly ONE of two concurrent reserves past the stock win', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const location = await insertLocation(storeId, {
      name: 'Main',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const [variant] = await insertVariants(listingId, [
      {
        title: 'Default Title',
        priceAmount: 1000,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 3,
        position: 0,
        optionValues: [],
      },
    ]);
    await insertLevels([
      { variantId: variant.id, listingId, locationId: location.id, available: 3 },
    ]);

    // Three units in stock, two buyers each wanting two. Under a read-then-write
    // both would read 3, both would decide 3 >= 2, and both would write — ending
    // at -1. The guard is a single conditional statement, so the second one's
    // predicate is re-checked against the first one's write.
    const [first, second] = await Promise.all([
      reserveAtLocation(variant.id, location.id, 2),
      reserveAtLocation(variant.id, location.id, 2),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);

    const [level] = await db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.variantId, variant.id));
    expect(level.available).toBe(1);
    expect(level.committed).toBe(2);
  });

  it('refuses a scalar reserve past the stock and reports it by rowcount', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const [variant] = await insertVariants(listingId, [
      {
        title: 'Default Title',
        priceAmount: 500,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 1,
        position: 0,
        optionValues: [],
      },
    ]);

    expect(await reserveVariantScalar(variant.id, 2)).toBe(false);
    expect(await reserveVariantScalar(variant.id, 1)).toBe(true);
    expect(await reserveVariantScalar(variant.id, 1)).toBe(false);

    const [row] = await findVariantsByListing(listingId);
    expect(row.inventoryAvailable).toBe(0);
    expect(row.inventoryCommitted).toBe(1);
  });

  it('rolls the scalar up from the levels — a NON-VACUOUS correlated aggregate', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const first = await insertLocation(storeId, {
      name: 'A',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const second = await insertLocation(storeId, {
      name: 'B',
      type: 'warehouse',
      isDefault: false,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const [variant] = await insertVariants(listingId, [
      {
        title: 'Default Title',
        priceAmount: 500,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 0,
        position: 0,
        optionValues: [],
      },
    ]);
    await insertLevels([
      { variantId: variant.id, listingId, locationId: first.id, available: 4, committed: 1 },
      { variantId: variant.id, listingId, locationId: second.id, available: 6, committed: 2 },
    ]);

    await recomputeVariantRollup(variant.id);
    const [rolled] = await findVariantsByListing(listingId);
    // POSITIVE before the mutation: a bare-column correlation returns 0 with no
    // error, and a test that only checked the post-mutation value would pass
    // against exactly that bug.
    expect(rolled.inventoryAvailable).toBe(10);
    expect(rolled.inventoryCommitted).toBe(3);

    await setLevelAvailable({ variantId: variant.id, listingId, locationId: second.id, available: 1 });
    await recomputeVariantRollup(variant.id);
    const [after] = await findVariantsByListing(listingId);
    expect(after.inventoryAvailable).toBe(5);
    // `setLevelAvailable` must PRESERVE an existing row's `committed`.
    expect(after.inventoryCommitted).toBe(3);
  });
});

describe('recomputeListingFacets', () => {
  it('clears the price range when the last variant goes — the empty-aggregate case', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const [cheap, dear] = await insertVariants(listingId, [
      {
        title: 'Cheap',
        priceAmount: 1000,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 5,
        position: 0,
        optionValues: [],
      },
      {
        title: 'Dear',
        priceAmount: 9000,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 0,
        position: 1,
        optionValues: [],
      },
    ]);

    await recomputeListingFacets(listingId);
    const populated = await findListingById(listingId);
    expect(populated?.variantCount).toBe(2);
    expect(populated?.priceRangeMinAmount).toBe(1000);
    expect(populated?.priceRangeMaxAmount).toBe(9000);
    expect(populated?.priceRangeMinCurrency).toBe('FAIR');
    expect(populated?.hasInventory).toBe(true);

    await deleteVariant(listingId, cheap.id);
    await deleteVariant(listingId, dear.id);
    expect(await countVariants(listingId)).toBe(0);

    // The trap: an aggregate over an empty set returns one row of NULLs from a
    // plain `select` but NO ROW from a `FROM` clause. Written as a single
    // `UPDATE … FROM (…)` this update would match nothing and leave the OLD
    // price range on a listing that no longer has one.
    await recomputeListingFacets(listingId);
    const emptied = await findListingById(listingId);
    expect(emptied?.variantCount).toBe(0);
    expect(emptied?.priceRangeMinAmount).toBeNull();
    expect(emptied?.priceRangeMaxAmount).toBeNull();
    expect(emptied?.priceRangeMinCurrency).toBeNull();
    expect(emptied?.hasInventory).toBe(false);
  });

  it('keeps an UNTRACKED variant in stock however little it has', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    await insertVariants(listingId, [
      {
        title: 'Made to order',
        priceAmount: 2500,
        priceCurrency: 'FAIR',
        inventoryTracked: false,
        inventoryAvailable: 0,
        position: 0,
        optionValues: [],
      },
    ]);

    // `!tracked || available > 0`. Dropping the first half unlists every
    // made-to-order product, silently.
    await recomputeListingFacets(listingId);
    expect((await findListingById(listingId))?.hasInventory).toBe(true);
  });
});

describe('the automated-rule translator', () => {
  /** Match a store's active listings against a translated rule set. */
  async function matching(
    storeId: string,
    rules: Parameters<typeof translateRules>[0],
    disjunctive = false,
  ): Promise<string[]> {
    return findStoreListingIdsMatching(storeId, translateRules(rules, disjunctive));
  }

  it('escapes % and _ in an ILIKE needle', async () => {
    const storeId = await makeStore();
    const literal = await makeListing(storeId, { productType: 'sale_50%' });
    const decoy = await makeListing(storeId, { productType: 'saleXYZ50pct' });

    // Unescaped, `sale_50%` is the pattern "sale, any character, 50, anything",
    // which matches the decoy too. Escaped, it matches only the literal value.
    const contains = await matching(storeId, [
      { field: 'productType', operator: 'contains', value: 'sale_50%' },
    ]);
    expect(contains).toEqual([literal]);
    expect(contains).not.toContain(decoy);

    // The escape itself, stated directly so a change to the helper is visible.
    expect(escapeLikeNeedle('sale_50%')).toBe('sale\\_50\\%');
    expect(escapeLikeNeedle('back\\slash')).toBe('back\\\\slash');
  });

  it('covers every supported operator against real rows', async () => {
    const storeId = await makeStore();
    const acme = await makeListing(storeId, {
      title: 'Acme Bicycle',
      vendor: 'Acme',
      productType: 'Bicycle',
      tags: ['road', 'carbon'],
      categorySlugs: ['sports', 'cycling'],
      priceRangeMinAmount: 5000,
      priceRangeMinCurrency: 'FAIR',
      priceRangeMaxAmount: 5000,
      priceRangeMaxCurrency: 'FAIR',
      hasInventory: true,
    });
    const unbranded = await makeListing(storeId, {
      title: 'Plain Trailer',
      vendor: null,
      productType: 'Trailer',
      tags: ['utility'],
      categorySlugs: ['sports'],
      priceRangeMinAmount: 20000,
      priceRangeMinCurrency: 'FAIR',
      priceRangeMaxAmount: 20000,
      priceRangeMaxCurrency: 'FAIR',
      hasInventory: false,
    });

    expect(await matching(storeId, [{ field: 'vendor', operator: 'equals', value: 'Acme' }])).toEqual([acme]);
    // `not_equals` must include the row whose vendor is NULL — Mongo's `$ne`
    // matched an absent field, and a bare `<>` evaluates to NULL and drops it.
    expect(
      await matching(storeId, [{ field: 'vendor', operator: 'not_equals', value: 'Acme' }]),
    ).toEqual([unbranded]);
    expect(
      await matching(storeId, [{ field: 'title', operator: 'starts_with', value: 'acme' }]),
    ).toEqual([acme]);
    expect(
      await matching(storeId, [{ field: 'title', operator: 'ends_with', value: 'TRAILER' }]),
    ).toEqual([unbranded]);
    expect(await matching(storeId, [{ field: 'tag', operator: 'equals', value: 'road' }])).toEqual([acme]);
    expect(
      await matching(storeId, [{ field: 'tag', operator: 'not_equals', value: 'road' }]),
    ).toEqual([unbranded]);
    expect(
      await matching(storeId, [{ field: 'categorySlug', operator: 'contains', value: 'sports' }]),
    ).toHaveLength(2);
    expect(await matching(storeId, [{ field: 'price', operator: 'gt', value: '10000' }])).toEqual([unbranded]);
    expect(await matching(storeId, [{ field: 'price', operator: 'lte', value: '5000' }])).toEqual([acme]);
    expect(await matching(storeId, [{ field: 'inventory', operator: 'gt', value: '0' }])).toEqual([acme]);
    expect(await matching(storeId, [{ field: 'inventory', operator: 'equals', value: '0' }])).toEqual([unbranded]);

    // AND narrows, OR widens — the same two rules, both ways round.
    const both = [
      { field: 'vendor' as const, operator: 'equals' as const, value: 'Acme' },
      { field: 'price' as const, operator: 'gt' as const, value: '10000' },
    ];
    expect(await matching(storeId, both, false)).toEqual([]);
    expect((await matching(storeId, both, true)).sort()).toEqual([acme, unbranded].sort());
  });

  it('resolves compareAtPrice through a CORRELATED subquery, non-vacuously', async () => {
    const storeId = await makeStore();
    const discounted = await makeListing(storeId, { title: 'Discounted' });
    const plain = await makeListing(storeId, { title: 'Plain' });
    await insertVariants(discounted, [
      {
        title: 'Default Title',
        priceAmount: 4000,
        priceCurrency: 'FAIR',
        compareAtPriceAmount: 9000,
        compareAtPriceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 2,
        position: 0,
        optionValues: [],
      },
    ]);
    await insertVariants(plain, [
      {
        title: 'Default Title',
        priceAmount: 4000,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 2,
        position: 0,
        optionValues: [],
      },
    ]);

    // A bare-column correlation compares `product_variants.listing_id` to
    // `product_variants.id`, matches nothing, and returns `[]` with no error.
    // Asserting a POSITIVE result is what distinguishes the two.
    expect(
      await matching(storeId, [{ field: 'compareAtPrice', operator: 'gt', value: '5000' }]),
    ).toEqual([discounted]);
    expect(
      await matching(storeId, [{ field: 'compareAtPrice', operator: 'lt', value: '5000' }]),
    ).toEqual([]);
  });

  it('matches NOTHING when no condition survives translation', async () => {
    const storeId = await makeStore();
    await makeListing(storeId, { title: 'Anything' });

    // `gt` on a text field is unsupported and skipped; a rule set with nothing
    // left must not degrade into "no filter", which would publish the entire
    // store into the collection.
    expect(await matching(storeId, [{ field: 'title', operator: 'gt', value: 'x' }])).toEqual([]);
    expect(await matching(storeId, [])).toEqual([]);
  });
});

describe('keyset pagination', () => {
  it('advances across ids of BOTH shapes at an identical published_at', async () => {
    const storeId = await makeStore();
    // One instant shared by every row, so the ONLY thing that can order them —
    // and the only thing that can stop the page repeating forever — is the id
    // tie-breaker. Half the ids are ObjectId-shaped, as every pre-cutover row is.
    const publishedAt = new Date('2026-03-01T12:00:00.000Z');
    const ids = [legacyHexId(), uuidv7(), legacyHexId(), uuidv7(), legacyHexId()];
    for (const id of ids) {
      await makeListing(storeId, { id, publishedAt });
    }

    const seen: string[] = [];
    let cursor: { publishedAt: Date | null; id: string } | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof searchListingsKeyset>> = await searchListingsKeyset(
        { storeId },
        cursor,
        2,
      );
      seen.push(...page.rows.map((row) => row.id));
      if (!page.hasMore) break;
      const last = page.rows[page.rows.length - 1];
      cursor = { publishedAt: last.publishedAt, id: last.id };
    }

    // Every row exactly once: a boundary that compared only `published_at` would
    // either repeat the first page forever or skip the rest of the tie group.
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());

    // Descending by id — checked against the DATABASE's own ordering, not a
    // JavaScript `.sort()`.
    //
    // Postgres compares `text` under the database COLLATION, which ignores the
    // hyphen at the primary level, while JavaScript sorts by code point where
    // `-` (0x2D) precedes every digit. On these exact rows the two disagree:
    // Postgres ranks `019fe0de-aa16-7bc6…` ABOVE `019fe0deaa167b72…`, and
    // JavaScript ranks it below. That does not threaten the pagination — the
    // ORDER BY and the `<` boundary are the same comparison, so they agree with
    // each other — but any attempt to reproduce the page order in JavaScript
    // will be wrong, which is why this assertion asks the server.
    const ordered = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.storeId, storeId))
      .orderBy(sql`${listings.publishedAt} desc nulls last`, sql`${listings.id} desc nulls last`);
    expect(seen).toEqual(ordered.map((row) => row.id));
  });

  it('reaches a listing with a NULL published_at, which sorts last', async () => {
    const storeId = await makeStore();
    const published = await makeListing(storeId, {
      publishedAt: new Date('2026-03-02T00:00:00.000Z'),
    });
    const unpublished = await makeListing(storeId, { publishedAt: null });

    const first = await searchListingsKeyset({ storeId }, null, 1);
    expect(first.rows.map((row) => row.id)).toEqual([published]);
    expect(first.hasMore).toBe(true);

    // The branch a two-way boundary drops: from a non-null cursor,
    // `published_at < $1` is NULL for this row, which is not TRUE, so it would
    // never appear on any page.
    const second = await searchListingsKeyset(
      { storeId },
      { publishedAt: first.rows[0].publishedAt, id: first.rows[0].id },
      1,
    );
    expect(second.rows.map((row) => row.id)).toEqual([unpublished]);
    expect(second.hasMore).toBe(false);
  });
});

describe('text and geo search', () => {
  it('COMBINES a full-text term with a radius instead of letting geo win', async () => {
    const storeId = await makeStore();
    // Barcelona. The Sagrada Família and a point ~2 km away; Madrid is ~505 km off.
    const nearbyBike = await makeListing(storeId, {
      title: 'Vintage bicycle',
      description: 'A restored road bicycle',
      longitude: 2.1744,
      latitude: 41.4036,
    });
    await makeListing(storeId, {
      title: 'Vintage lamp',
      description: 'A brass reading lamp',
      longitude: 2.18,
      latitude: 41.4,
    });
    await makeListing(storeId, {
      title: 'Vintage bicycle',
      description: 'A restored road bicycle',
      longitude: -3.7038,
      latitude: 40.4168,
    });

    const near = { lng: 2.1744, lat: 41.4036, radiusM: 5000 };

    // Under Mongo this query was impossible: `$near` and `$text` cannot be
    // combined, so `search.service` dropped the term and returned every listing
    // in the radius — the lamp included.
    const combined = await searchListingsPage({ text: 'bicycle', near, storeId }, 'newest', 1, 10);
    expect(combined.rows.map((row) => row.id)).toEqual([nearbyBike]);
    expect(combined.total).toBe(1);

    // Non-vacuity: the same radius with a term nothing matches must return ZERO
    // rows. A filter that silently ignored the text would return two here.
    const noMatch = await searchListingsPage(
      { text: 'submarine', near, storeId },
      'newest',
      1,
      10,
    );
    expect(noMatch.rows).toEqual([]);
    expect(noMatch.total).toBe(0);

    // And the radius really is a filter: widened to cover Madrid, the far bike
    // joins the result.
    const wide = await searchListingsPage(
      { text: 'bicycle', near: { ...near, radiusM: 600_000 }, storeId },
      'newest',
      1,
      10,
    );
    expect(wide.total).toBe(2);
  });

  it('stems and case-folds a tag, exactly as it does the title and description', async () => {
    const storeId = await makeStore();
    const tagged = await makeListing(storeId, {
      title: 'Unremarkable item',
      description: 'Nothing to see',
      tags: ['leather', 'handmade', 'Bikes'],
    });
    await makeListing(storeId, { title: 'Another item', description: 'Nothing here either' });

    const matching = async (term: string): Promise<string[]> => {
      const page = await searchListingsPage({ text: term, storeId }, 'newest', 1, 10);
      return page.rows.map((row) => row.id);
    };

    // A tag whose lexeme is already the word typed — the case that worked even
    // under `array_to_tsvector`, kept so a regression cannot pass by breaking
    // everything equally.
    expect(await matching('leather')).toEqual([tagged]);

    // The two that `array_to_tsvector` could not serve, and the reason
    // `0003_tag_search_stemming` exists: it stored each element VERBATIM, so
    // `handmade` (which the QUERY stems to `handmad`) and `Bikes` (which never
    // lower-cased) were both unreachable by the word a buyer would type. Mongo's
    // `$text` index stemmed array elements, so this asserts the port matches it
    // rather than a new nicety.
    expect(await matching('handmade')).toEqual([tagged]);
    expect(await matching('bikes')).toEqual([tagged]);

    // Stemming is real and not merely lower-casing: `handmad` is the stem, and a
    // term that only shares a prefix must NOT match.
    expect(await matching('hand')).toEqual([]);
  });

  it('keeps the search-vector GIN index that the column rewrite dropped', async () => {
    // `0003_tag_search_stemming` re-creates the generated column, and `DROP
    // COLUMN` takes its index with it. `drizzle-kit generate` did not re-emit the
    // index — its definition is textually unchanged, so the diff had nothing to
    // say and the snapshot still records one the database would not have. The
    // recreate is hand-written in that migration, and this is what notices if it
    // is ever lost: without it every `@@` query above still passes, on a
    // sequential scan.
    const [row] = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where tablename = 'listings' and indexname = 'listings_search_vector_idx'`,
    );
    expect(row, 'listings_search_vector_idx does not exist').toBeDefined();
    expect(row?.indexdef).toContain('USING gin');
    expect(row?.indexdef).toContain('search_vector');
  });
});

describe('favorites', () => {
  it('clamps favorite_count at zero without losing a concurrent increment', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);

    await adjustFavoriteCount(listingId, -1);
    expect((await findListingById(listingId))?.favoriteCount).toBe(0);

    // The Mongo form was `updateOne({_id, favoriteCount: {$gt: 0}}, {$inc: -1})`.
    // At a count of zero that guard makes the WHOLE update a no-op, so a
    // legitimate +1 arriving in the same moment is lost. `greatest(0, …)`
    // applies every delta and refuses only to go negative.
    await Promise.all([adjustFavoriteCount(listingId, 1), adjustFavoriteCount(listingId, -1)]);
    const afterRace = (await findListingById(listingId))?.favoriteCount ?? -1;
    expect(afterRace).toBeGreaterThanOrEqual(0);

    await db.update(listings).set({ favoriteCount: 0 }).where(eq(listings.id, listingId));
    await adjustFavoriteCount(listingId, 1);
    expect((await findListingById(listingId))?.favoriteCount).toBe(1);
  });

  it('reports whether the row really changed, so the counter cannot drift', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const oxyUserId = `buyer-${uuidv7()}`;

    expect(await insertFavorite(oxyUserId, listingId)).toBe(true);
    // The second save is a no-op the unique index absorbs; `false` is what stops
    // the caller counting it twice.
    expect(await insertFavorite(oxyUserId, listingId)).toBe(false);
    expect(await deleteFavorite(oxyUserId, listingId)).toBe(true);
    expect(await deleteFavorite(oxyUserId, listingId)).toBe(false);

    await insertFavorite(oxyUserId, listingId);
    expect(await findSavedListingIds(oxyUserId, [listingId])).toEqual(new Set([listingId]));
    const page = await findFavoriteListingIdsPage(oxyUserId, 1, 10);
    expect(page.listingIds).toEqual([listingId]);
    expect(page.total).toBe(1);

    await db.delete(favorites).where(eq(favorites.listingId, listingId));
  });
});

describe('collection membership', () => {
  it('keeps the hand-picked order and pages it IN SQL', async () => {
    const storeId = await makeStore();
    const first = await makeListing(storeId, { title: 'First' });
    const second = await makeListing(storeId, { title: 'Second' });
    const third = await makeListing(storeId, { title: 'Third' });

    const collection = await insertCollection(
      storeId,
      {
        title: 'Picked',
        handle: `picked-${uuidv7()}`,
        type: 'manual',
        sortOrder: 'manual',
        isPublished: true,
      },
      [],
    );

    await replaceManualMembership(collection.id, [third, first, second]);
    const page = await findCollectionProductsPage(collection.id, 'manual', true, 1, 2);
    expect(page.rows.map((row) => row.id)).toEqual([third, first]);
    expect(page.total).toBe(3);

    // Reordering must be visible: a set-diff that left surviving rows untouched
    // would keep their old positions and this would not move.
    await replaceManualMembership(collection.id, [second, third, first]);
    const reordered = await findCollectionProductsPage(collection.id, 'manual', true, 1, 3);
    expect(reordered.rows.map((row) => row.id)).toEqual([second, third, first]);
  });

  it('set-diffs an automated membership and clears a stale manual position', async () => {
    const storeId = await makeStore();
    const a = await makeListing(storeId, { title: 'A' });
    const b = await makeListing(storeId, { title: 'B' });
    const c = await makeListing(storeId, { title: 'C' });

    const collection = await insertCollection(
      storeId,
      {
        title: 'Derived',
        handle: `derived-${uuidv7()}`,
        type: 'manual',
        sortOrder: 'manual',
        isPublished: true,
      },
      [],
    );

    // It starts life MANUAL, so its rows carry positions.
    await replaceManualMembership(collection.id, [a, b]);
    const [before] = await db
      .select({ withPosition: sql<number>`count(*) filter (where position is not null)::int` })
      .from(listingCollections)
      .where(eq(listingCollections.collectionId, collection.id));
    expect(before.withPosition).toBe(2);

    // Flipped to automated, the derived membership must not keep a hand-picked
    // order — NULL is what "derived from rules" means in this table.
    await reconcileAutomatedMembership(collection.id, [b, c]);
    const page = await findCollectionProductsPage(collection.id, 'created_desc', false, 1, 10);
    expect(page.rows.map((row) => row.id).sort()).toEqual([b, c].sort());
    expect(page.total).toBe(2);

    const [after] = await db
      .select({ withPosition: sql<number>`count(*) filter (where position is not null)::int` })
      .from(listingCollections)
      .where(eq(listingCollections.collectionId, collection.id));
    expect(after.withPosition).toBe(0);

    // Idempotent: reconciling to the same set again changes nothing.
    await reconcileAutomatedMembership(collection.id, [b, c]);
    expect((await findCollectionProductsPage(collection.id, 'created_desc', false, 1, 10)).total).toBe(2);
  });

  it('NEVER deletes a hand-picked membership, whatever scope the caller passes', async () => {
    const storeId = await makeStore();
    const handPicked = await makeListing(storeId, { title: 'Hand-picked' });
    const derived = await makeListing(storeId, { title: 'Derived' });

    const collection = await insertCollection(
      storeId,
      {
        title: 'Merchant picks',
        handle: `picks-${uuidv7()}`,
        type: 'manual',
        sortOrder: 'manual',
        isPublished: true,
      },
      [],
    );

    // The merchant hand-picks one product into a MANUAL collection.
    await replaceManualMembership(collection.id, [handPicked]);

    // The connector then reconciles against that SAME collection, because
    // `connector-sync.applyCollectionMapping` passes the codomain of the
    // merchant's own `collectionMapping` — an arbitrary set that can name a
    // manual collection — and this sync saw no external ref for it.
    await setListingAutomatedMemberships(handPicked, [collection.id], []);

    // The hand-picked row and its position must both survive. Without the
    // `position is null` guard on the delete this is a silent, permanent loss of
    // the merchant's own curation, triggered by an ordinary re-sync.
    const [surviving] = await db
      .select()
      .from(listingCollections)
      .where(eq(listingCollections.collectionId, collection.id));
    expect(surviving?.listingId).toBe(handPicked);
    expect(surviving?.position).toBe(0);

    // And the guard is not simply refusing everything: a DERIVED row in the same
    // collection is still removed when it stops matching.
    await setListingAutomatedMemberships(derived, [collection.id], [collection.id]);
    expect(
      await db
        .select()
        .from(listingCollections)
        .where(eq(listingCollections.collectionId, collection.id)),
    ).toHaveLength(2);

    await setListingAutomatedMemberships(derived, [collection.id], []);
    const remaining = await db
      .select()
      .from(listingCollections)
      .where(eq(listingCollections.collectionId, collection.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].listingId).toBe(handPicked);
  });
});

describe('stable variant identity (#259)', () => {
  /** A connected `pull` connection for `storeId`, to stamp variants against. */
  async function makeConnection(storeId: string, provider: 'shopify' | 'woocommerce' = 'woocommerce') {
    return upsertConnection(storeId, provider, {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
      shopDomain: `shop-${uuidv7()}.example.test`,
      shopCurrency: 'USD',
      scopes: [],
    });
  }

  /** A store listing carrying `count` bare variants. */
  async function makeVariants(storeId: string, count: number) {
    const listingId = await makeListing(storeId);
    const variants = await insertVariants(
      listingId,
      Array.from({ length: count }, (_, i) => ({
        title: `V${i}`,
        optionValues: [],
        priceAmount: 1000,
        priceCurrency: 'FAIR' as const,
        inventoryTracked: true,
        inventoryAvailable: 1,
        position: i,
      })),
    );
    return { listingId, variants };
  }

  it('the partial unique index EXISTS after migration', async () => {
    // The one thing a functional test can never detect. Every case below would
    // still pass on the SERVICE's refusal alone, while the database went on
    // accepting exactly the row the refusal exists to make impossible — and the
    // service is not the only writer (`psql`, a backfill, a future importer).
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where tablename = 'product_variants'
            and indexname = 'product_variants_source_external_variant_key'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/);
    expect(rows[0].indexdef).toMatch(/source_connection_id/);
    expect(rows[0].indexdef).toMatch(/source_external_variant_id IS NOT NULL/);
  });

  it('REFUSES two variants of one connection stamped with the same external variation id', async () => {
    // The state `convergeVariants` used to create on an ordinary SKU rename:
    // the incoming variant matched nothing, was CREATED, and was stamped with the
    // external id the original still carried — two local rows claiming one
    // platform variation, each unselling the other on alternate syncs.
    //
    // It is also the risk the position-matched `stampVariantSources` carries: it
    // pairs local variants to normalized ones by INDEX, so any drift between the
    // two orders now raises here instead of mis-stamping in silence.
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const { listingId, variants } = await makeVariants(storeId, 2);

    await updateVariantColumns(
      listingId,
      variants[0].id,
      { sourceConnectionId: conn.id, sourceProvider: 'woocommerce', sourceExternalVariantId: '3001' },
      undefined,
    );

    let caught: unknown;
    try {
      await updateVariantColumns(
        listingId,
        variants[1].id,
        { sourceConnectionId: conn.id, sourceProvider: 'woocommerce', sourceExternalVariantId: '3001' },
        undefined,
      );
    } catch (error) {
      caught = error;
    }

    expect(isUniqueViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('product_variants_source_external_variant_key');
  });

  it('ACCEPTS the same external variation id on a DIFFERENT connection', async () => {
    // The key is per CONNECTION, and it has to be: two connected shops number
    // their variations in their own key spaces and collide constantly. Without
    // this control the case above would also pass on an index over the id alone.
    const storeId = await makeStore();
    const woo = await makeConnection(storeId, 'woocommerce');
    const shopify = await makeConnection(storeId, 'shopify');
    const { listingId, variants } = await makeVariants(storeId, 2);

    await updateVariantColumns(
      listingId,
      variants[0].id,
      { sourceConnectionId: woo.id, sourceProvider: 'woocommerce', sourceExternalVariantId: '3001' },
      undefined,
    );
    const second = await updateVariantColumns(
      listingId,
      variants[1].id,
      { sourceConnectionId: shopify.id, sourceProvider: 'shopify', sourceExternalVariantId: '3001' },
      undefined,
    );

    expect(second?.sourceExternalVariantId).toBe('3001');
  });

  it("ACCEPTS a simple product's PRODUCT-id stamp beside a variable product's VARIATION-id stamp", async () => {
    // WooCommerce stamps a SIMPLE product's variant with the PRODUCT id and a
    // variable product's with the VARIATION id, into one key space per
    // connection. That they cannot collide is a claim about WordPress — products
    // and variations are both rows of `posts`, which numbers them from one
    // sequence — and it is a claim this index would punish if it were wrong, so
    // it is worth a fixture rather than a sentence.
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const { listingId: simpleListing, variants: simpleVariants } = await makeVariants(storeId, 1);
    const { listingId: variableListing, variants: variableVariants } = await makeVariants(storeId, 1);

    await updateVariantColumns(
      simpleListing,
      simpleVariants[0].id,
      { sourceConnectionId: conn.id, sourceProvider: 'woocommerce', sourceExternalVariantId: '111' },
      undefined,
    );
    const variable = await updateVariantColumns(
      variableListing,
      variableVariants[0].id,
      { sourceConnectionId: conn.id, sourceProvider: 'woocommerce', sourceExternalVariantId: '3001' },
      undefined,
    );

    expect(variable?.sourceExternalVariantId).toBe('3001');
  });

  it('ACCEPTS any number of UNSTAMPED variants — the index is PARTIAL', async () => {
    // Every P2P listing and every hand-created store product is unstamped, and a
    // unique over a nullable pair would be fine in Postgres (NULLs are distinct)
    // — but the predicate is what says so out loud, and this is what would fail
    // if somebody "tidied" it away and the pair were ever compared as equal.
    const storeId = await makeStore();
    const { listingId } = await makeVariants(storeId, 3);

    expect(await findVariantsByListing(listingId)).toHaveLength(3);
  });
});

/**
 * Migration 0071's collapse of PRE-EXISTING violators, against a real server.
 *
 * `CREATE UNIQUE INDEX` FAILS at apply time over rows that already violate it,
 * and by the migration's own reasoning those rows are exactly what the bug
 * produced: pre-#259 `convergeVariants` created a second variant on a SKU rename
 * and stamped it with the external id the original still held. So the collapse
 * is not defensive tidying — it is the difference between a deploy that applies
 * and one that aborts halfway through a release.
 *
 * The statements are READ OUT OF THE MIGRATION FILE rather than retyped: a probe
 * that retypes them measures the retyping, and would go on passing after somebody
 * regenerated the file and lost the hand-written half (which `db:generate` drops
 * every time).
 *
 * They run against a TEMP table shadowing `product_variants`, and that is a
 * deliberate trade rather than a shortcut. Seeding a violator into the REAL table
 * needs the index dropped first, and `DROP INDEX` holds ACCESS EXCLUSIVE on
 * `product_variants` for the whole transaction — on a shared test database that
 * is a lock convoy in front of every sibling file touching a variant, which is
 * the failure mode `ebay-ingestion.realdb.test.ts` already records for
 * `DISABLE TRIGGER`. Neither statement reads a column outside the four below.
 * That the migration applies against the REAL schema is established separately
 * and more strongly: every realdb suite in this repo runs on a throwaway database
 * built by the real migrator, and the index-existence case above reads the result.
 */
describe("migration 0071's collapse of pre-existing violators", () => {
  /** The two halves of the migration, as SHIPPED, with the comments stripped. */
  function migrationStatements(): { collapse: string; createIndex: string } {
    const sql = readFileSync('drizzle/0071_lively_joseph.sql', 'utf8');
    const [collapse, createIndex] = sql
      .split('--> statement-breakpoint')
      .map((half) =>
        half
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      );
    // A floor on the extraction itself: a split that matched nothing would hand
    // both assertions an empty string, and an empty string runs without error.
    expect(collapse.startsWith('UPDATE "product_variants"')).toBe(true);
    expect(createIndex.startsWith('CREATE UNIQUE INDEX')).toBe(true);
    return { collapse, createIndex };
  }

  /**
   * Stand the four columns both statements read up as a TEMP table shadowing
   * `product_variants`, seeded with the violating shape, and hand `body` the
   * migration's own statements.
   */
  async function withSeededViolators(
    body: (
      tx: Parameters<Parameters<Database['transaction']>[0]>[0],
      statements: { collapse: string; createIndex: string },
    ) => Promise<void>,
  ): Promise<void> {
    const statements = migrationStatements();
    await db
      .transaction(async (tx) => {
        // `LIKE … INCLUDING DEFAULTS` rather than a hand-picked column list, so
        // the shadow carries the REAL column set and a repository function can be
        // run against it. Indexes and CHECKs are deliberately NOT copied: the
        // unique is what these cases create themselves, and the currency CHECKs
        // have nothing to do with provenance. Foreign keys are never copied by
        // `LIKE`, which is what lets the seed name listings and connections that
        // do not exist.
        await tx.execute(sql`
          create temp table "product_variants"
            (like public."product_variants" including defaults) on commit drop
        `);
        // Three rows of one connection claiming variation 3001 — the shape the
        // OLD matcher produced on a SKU rename — and every one of them carrying
        // the same INVENTORY-ITEM id too, because `stampVariantSource` writes the
        // four provenance columns together from one normalized variant.
        await tx.execute(sql`
          insert into "product_variants"
            ("id", "listing_id", "position", "source_connection_id", "source_provider",
             "source_external_variant_id", "source_external_inventory_item_id")
          values
            ('a', 'listing-1', 0, 'conn-1', 'woocommerce', '3001', 'item-3001'),
            ('b', 'listing-1', 1, 'conn-1', 'woocommerce', '3001', 'item-3001'),
            ('c', 'listing-1', 2, 'conn-1', 'woocommerce', '3001', 'item-3001'),
            ('d', 'listing-2', 0, 'conn-2', 'woocommerce', '3001', 'item-3001'),
            ('e', 'listing-3', 0, null, null, '3001', 'item-3001'),
            ('f', 'listing-3', 1, null, null, '3001', 'item-3001'),
            ('g', 'listing-3', 2, null, null, null, null)
        `);
        await body(tx, statements);
        throw new Error('ROLLBACK');
      })
      .catch((error: Error) => {
        if (error.message !== 'ROLLBACK') throw error;
      });
  }

  it('the SEED really violates — without the collapse the index REFUSES', async () => {
    // The positive control, and the one this whole block rests on: "the migration
    // applied" is equally true of a fixture that never created a duplicate, and a
    // seed that stopped violating (a typo in an id, a column renamed) would leave
    // the case below passing while measuring nothing at all.
    await withSeededViolators(async (tx, { createIndex }) => {
      let caught: unknown;
      try {
        await tx.execute(sql.raw(createIndex));
      } catch (error) {
        caught = error;
      }
      expect(isUniqueViolation(caught)).toBe(true);
      expect(constraintNameOf(caught)).toBe('product_variants_source_external_variant_key');
    });
  });

  it('CONVERGES rather than aborting: the collapse runs, then the index is created', async () => {
    await withSeededViolators(async (tx, { collapse, createIndex }) => {
      await tx.execute(sql.raw(collapse));
      // The statement the whole migration exists to reach. It ABORTS the deploy
      // if the collapse did not do its job.
      await tx.execute(sql.raw(createIndex));

      const rows = await tx.execute<{ id: string; v: string | null }>(
        sql`select "id", "source_external_variant_id" as v from "product_variants" order by "id"`,
      );
      expect(rows.filter((row) => row.v !== null).map((row) => row.id)).toEqual([
        // The survivor of the violating group is the row that has held the
        // identity longest — lowest position, then lowest id.
        'a',
        // A DIFFERENT connection keeps its stamp: the key is per connection, and
        // two shops number their variations in their own key spaces.
        'd',
        // NULL connection ids are excluded deliberately — they can never collide
        // under a partial unique over both columns, so nulling them would destroy
        // provenance to satisfy a constraint that was never going to fire.
        'e',
        'f',
      ]);
      // The losers are UNSTAMPED, not deleted. A variant id cascades into carts,
      // saves, offers and the canonical links (#220's reasoning), and unstamped is
      // precisely the state `convergeVariants`' legacy tier re-matches and
      // re-stamps on the next sync.
      const rowsById = new Map(rows.map((row) => [row.id, row.v]));
      expect(rowsById.get('b')).toBeNull();
      expect(rowsById.get('c')).toBeNull();
      expect(rows).toHaveLength(7);
    });
  });

  it('leaves ONE variant carrying the collapsed INVENTORY-ITEM id, not three', async () => {
    // The half-stamped loser, which is the failure clearing only the variant id
    // would have left behind. Nothing constrains
    // `(source_connection_id, source_external_inventory_item_id)` — the index
    // above is over the VARIANT id — and both of its readers pick arbitrarily
    // among matches: `findVariantBySourceInventoryItemId` is `limit(1)` with no
    // ORDER BY, and `syncInventory` builds a Map whose last writer wins over an
    // unordered read. So a shop left half-collapsed routes stock onto a variant
    // that no longer converges and that nothing sells, silently, about half the
    // time — the #259 failure arriving through the repair for it.
    //
    // The COUNT is the assertion that means something. Asserting only that the
    // lookup returns the survivor would pass one time in three against the
    // broken collapse, because the lookup has no ORDER BY to be wrong about.
    await withSeededViolators(async (tx, { collapse }) => {
      const before = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from "product_variants"
            where "source_connection_id" = 'conn-1'
              and "source_external_inventory_item_id" = 'item-3001'`,
      );
      expect(before[0].n, 'the premise: the seed really duplicates the item id').toBe(3);

      await tx.execute(sql.raw(collapse));

      const after = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from "product_variants"
            where "source_connection_id" = 'conn-1'
              and "source_external_inventory_item_id" = 'item-3001'`,
      );
      expect(after[0].n).toBe(1);
      // And it is the SURVIVOR the live reader resolves to — the repository
      // function itself, against the shadow, rather than a re-spelling of its
      // WHERE clause that could agree with a query nobody runs.
      const resolved = await findVariantBySourceInventoryItemId('conn-1', 'item-3001', tx);
      expect(resolved?.id).toBe('a');
      // The OTHER connection is untouched, for the reason the variant-id key is
      // per connection: two shops number their inventory items independently.
      const sibling = await findVariantBySourceInventoryItemId('conn-2', 'item-3001', tx);
      expect(sibling?.id).toBe('d');
    });
  });
});

/**
 * #296 — a merchant SKU and a seller's observed barcode are unique at NO grain.
 *
 * The genesis migration carried `product_variants_sku_key` and
 * `product_variants_barcode_key`, both UNIQUE over the whole table, ported
 * straight from Mongo's `sparse: true, unique: true`. The barcode one made the
 * premise the canonical catalogue rests on unreachable — two merchants selling
 * one trade item share a GTIN by definition, so the second merchant to list a
 * product simply could not list it. The SKU one refused a catalogue Shopify
 * permits outright.
 *
 * Every case here writes through `insertVariants`, the repository the whole
 * catalogue funnels through, and reads the rows BACK: a case that only asserted
 * "no error was thrown" would pass identically against a writer that quietly
 * stored NULL for both columns, which is the same green a working index would
 * have produced for the row it refused.
 */
describe('SKU and barcode identity (#296)', () => {
  const SHARED_SKU = 'SHARED-SKU';
  const SHARED_BARCODE = '5901234123457';

  /** One variant carrying the shared SKU and the shared barcode. */
  function sharedIdentityVariant(title: string) {
    return {
      title,
      sku: SHARED_SKU,
      barcode: SHARED_BARCODE,
      optionValues: [],
      priceAmount: 1000,
      priceCurrency: 'FAIR' as const,
      inventoryTracked: true,
      inventoryAvailable: 1,
      position: 0,
    };
  }

  /** Read the two identity columns back off the stored rows. */
  async function storedIdentity(variantIds: readonly string[]) {
    const rows = await db
      .select({ id: productVariants.id, sku: productVariants.sku, barcode: productVariants.barcode })
      .from(productVariants)
      .where(inArray(productVariants.id, [...variantIds]));
    return rows;
  }

  it('lets TWO STORES list one trade item — the whole premise of the comparison surface', async () => {
    // The case the issue is named for. Under the dropped barcode unique the
    // second store's insert raised 23505 and its product could not exist, so
    // "several merchants offering one product" — what `offers`, the canonical
    // graph and every price comparison are FOR — was a state the storage forbade.
    const firstStore = await makeStore();
    const secondStore = await makeStore();
    const [first] = await insertVariants(await makeListing(firstStore), [
      sharedIdentityVariant('First merchant'),
    ]);
    const [second] = await insertVariants(await makeListing(secondStore), [
      sharedIdentityVariant('Second merchant'),
    ]);

    const stored = await storedIdentity([first.id, second.id]);
    expect(stored).toHaveLength(2);
    // BOTH columns, read back: the vacuity floor. `insertVariants` writes NULL
    // for an empty string, so a fixture that lost its values would otherwise
    // report this property from two rows that assert no identity at all.
    expect(stored.every((row) => row.sku === SHARED_SKU)).toBe(true);
    expect(stored.every((row) => row.barcode === SHARED_BARCODE)).toBe(true);
  });

  it('lets ONE STORE list one trade item twice, in two listings', async () => {
    // A store re-listing the same item — a second condition, a second
    // fulfilment arrangement, a duplicate a merchant will merge later. The
    // table-wide unique refused this too, and a per-store one would have as well.
    const storeId = await makeStore();
    const [first] = await insertVariants(await makeListing(storeId), [
      sharedIdentityVariant('Listing A'),
    ]);
    const [second] = await insertVariants(await makeListing(storeId), [
      sharedIdentityVariant('Listing B'),
    ]);

    const stored = await storedIdentity([first.id, second.id]);
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.sku === SHARED_SKU)).toBe(true);
    expect(stored.every((row) => row.barcode === SHARED_BARCODE)).toBe(true);
  });

  it('lets ONE LISTING carry two variants sharing a SKU — the Shopify catalogue', async () => {
    // Why the SKU index was NOT narrowed to `(listing_id, sku)`. Shopify
    // enforces no SKU uniqueness at all, so one product legitimately carries two
    // variants with one SKU and a connector has to import it; WooCommerce
    // enforces it site-wide. The platforms disagree, and a constraint that has
    // to be wrong sometimes is worse than one that does not exist.
    //
    // This is also the state `matchIncomingVariant` and `resolveInventoryVariant`
    // refuse to guess between — the check the index was standing in for, moved
    // to where it can name what it found.
    const listingId = await makeListing(await makeStore());
    const written = await insertVariants(listingId, [
      sharedIdentityVariant('Small'),
      { ...sharedIdentityVariant('Large'), position: 1 },
    ]);

    const stored = await storedIdentity(written.map((row) => row.id));
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.sku === SHARED_SKU)).toBe(true);

    // And the reader that used to be able to assume one answer now returns both,
    // which is what makes the refusal above possible rather than merely intended.
    const candidates = await findVariantsByListingAndSku(listingId, SHARED_SKU);
    expect(candidates.map((row) => row.id).sort()).toEqual(
      written.map((row) => row.id).sort(),
    );
  });

  it('writes an EMPTY sku and barcode as NULL, and lets many NULLs coexist', async () => {
    // `nullIfEmpty` (`db/catalog/variantRepository.ts`), pinned against a real
    // server for the first time — and the drop is why it needed to be.
    //
    // `schema.realdb.test.ts` used to carry a "permits many NULL skus" case
    // beside the SKU unique. It inserted rows with the `sku` key ABSENT, so it
    // exercised the INDEX's NULL-distinctness and never `nullIfEmpty` at all;
    // once the index went, that case would have asserted nothing about anything.
    // This is the half of it that was always real, moved to the repository that
    // owns the rule and made to go through it.
    //
    // The rule OUTLIVED the constraint that made it urgent, and got worse rather
    // than moot. Under the unique, `''` was a VALUE and the second unlabelled
    // variant collided loudly. With no unique, `''` is a SKU that every
    // unlabelled variant SHARES — so `findVariantsByListingAndSku` would report a
    // whole listing as ambiguous, and the barcode readers would take it for an
    // identifier the seller never asserted.
    const listingId = await makeListing(await makeStore());
    const written = await insertVariants(listingId, [
      { ...sharedIdentityVariant('Empty'), sku: '', barcode: '' },
      { ...sharedIdentityVariant('Absent'), sku: undefined, barcode: undefined, position: 1 },
    ]);

    const stored = await storedIdentity(written.map((row) => row.id));
    expect(stored).toHaveLength(2);
    // NULL and not `''` — asserted with `toBeNull`, because `expect('').toBeFalsy()`
    // would pass against exactly the value this refuses to store.
    expect(stored.every((row) => row.sku === null)).toBe(true);
    expect(stored.every((row) => row.barcode === null)).toBe(true);

    // And both coexist, which is the surviving half of the retired case: two
    // unlabelled variants of one listing are the ordinary state, and `''` would
    // have made them two variants sharing a SKU.
    const candidates = await findVariantsByListingAndSku(listingId, '');
    expect(candidates).toHaveLength(0);
  });

  it('has neither index in the DATABASE, and CAN see one that is there', async () => {
    // The one thing a functional test can never detect — the mirror of the #259
    // case above. Every case here would pass unchanged against a schema file that
    // dropped the declarations while the migration left the indexes standing,
    // because these fixtures are small enough that a stale index refuses nothing
    // they happen to write.
    //
    // The POSITIVE CONTROL is in the same statement: `absent` and `present` come
    // from one scan of `pg_indexes`, so "we found no such index" cannot be what a
    // query reading nothing at all reports.
    const rows = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes
          where tablename = 'product_variants'
            and indexname in (
              'product_variants_sku_key',
              'product_variants_barcode_key',
              'product_variants_source_external_variant_key'
            )`,
    );
    const found = rows.map((row) => row.indexname);

    expect(found).not.toContain('product_variants_sku_key');
    expect(found).not.toContain('product_variants_barcode_key');
    expect(found).toContain('product_variants_source_external_variant_key');
  });
});
