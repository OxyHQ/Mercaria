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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { inventoryLevels, listings } from '../schema/catalog.js';
import { collections, listingCollections } from '../schema/merchandising.js';
import { favorites } from '../schema/buyers.js';
import { stores } from '../schema/stores.js';
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
  findVariantsByListing,
  insertVariants,
  recomputeVariantRollup,
  reserveVariantScalar,
} from '../catalog/variantRepository.js';
import { insertLevels, reserveAtLocation, setLevelAvailable } from '../catalog/inventoryLevelRepository.js';
import {
  findCollectionProductsPage,
  insertCollection,
  reconcileAutomatedMembership,
  replaceManualMembership,
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
      title: 'Realdb product',
      description: '',
      condition: 'new',
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
    await db.delete(stores).where(eq(stores.id, storeId));
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

  it('matches a tag VERBATIM only — tags are neither stemmed nor case-folded', async () => {
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

    // Tags reach the generated `tsvector` through `array_to_tsvector`, which is
    // IMMUTABLE — the requirement a generated column imposes — and which stores
    // each element as a lexeme VERBATIM. `to_tsvector('english', …)`, used for the
    // title and description, stems and lower-cases instead. Measured on
    // PostgreSQL 17: `array_to_tsvector(array['handmade','Bikes'])` is
    // `'Bikes' 'handmade'`, while `to_tsvector('english','handmade Bikes')` is
    // `'bike':2 'handmad':1`.
    //
    // So a tag matches only when the query's LEXEME is already the tag itself.
    expect(await matching('leather')).toEqual([tagged]);

    // And these do not, which is the half worth pinning: `handmade` stems to
    // `handmad` and `Bikes` never lower-cases, so neither tag is reachable by the
    // word a buyer would actually type. Mongo's `$text` index DID stem array
    // elements, so this is a real narrowing of tag search, not a nicety.
    //
    // Closing it needs a schema change, not a service one: `array_to_string` is
    // STABLE (verified via `pg_proc.provolatile`) and `tags::text` is rejected
    // outright with `generation expression is not immutable`, so the only route
    // is a custom `IMMUTABLE` wrapper function plus a migration that rewrites
    // `listings.search_vector`. Deliberately left for the schema owner.
    expect(await matching('handmade')).toEqual([]);
    expect(await matching('bikes')).toEqual([]);
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
});
