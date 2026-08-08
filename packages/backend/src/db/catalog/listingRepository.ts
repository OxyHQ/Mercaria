/**
 * `listings` and its child tables — `listing_images`, `listing_options`, the
 * `listing_collections` membership read, and the browse/search queries.
 *
 * One Mongoose document became four tables, so this module is where "a listing"
 * is reassembled. Two shapes leave it, and the split is deliberate:
 *
 *  - {@link ListingRecord} — the base row, nothing joined. This is what search,
 *    browse and collection paging return, because those read hundreds of rows
 *    and none of them need an image.
 *  - {@link ListingChildren} — images, options and collection ids for a BATCH of
 *    listings, loaded in three queries no matter how many listings there are.
 *    Hydration asks for this once per page.
 *
 * Nothing above this layer writes a child table directly: an image list or an
 * option list is replaced WHOLESALE through {@link replaceListingImages} /
 * {@link replaceListingOptions}, which is what the Mongoose sub-document
 * assignment did, and doing it any other way leaves the old rows behind.
 *
 * ## The ORDER BY is written out rather than built with `desc()`
 *
 * `listings_status_published_at_id_idx` was emitted by drizzle-kit as
 * `("status", "published_at" DESC NULLS LAST, "id" DESC NULLS LAST)`, but
 * drizzle's `desc(column)` renders a bare `desc` — and a bare `DESC` in
 * Postgres means NULLS **FIRST**. The two do not match, so a feed ordered with
 * `desc()` cannot use that index for its ordering AND puts unpublished rows at
 * the head of "newest first". `NEWEST_FIRST` states `desc nulls last`
 * explicitly, which matches the index and matches Mongo (a descending Mongo
 * sort puts missing values last).
 */

import {
  and,
  arrayContains,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { qualified } from '@oxyhq/db';
import type {
  CurrencyCode,
  ListingCondition,
  ListingOwnerType,
  ListingQuery,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingImages, listingOptions, listings, productVariants } from '../schema/catalog.js';
import { listingCollections } from '../schema/merchandising.js';

/** One row of `listings` — no children joined. */
export type ListingRecord = InferSelectModel<typeof listings>;

/** One row of `listing_images`. */
export type ListingImageRecord = InferSelectModel<typeof listingImages>;

/** One row of `listing_options`. */
export type ListingOptionRecord = InferSelectModel<typeof listingOptions>;

/** The child rows of a BATCH of listings, keyed by listing id. */
export interface ListingChildren {
  readonly images: Map<string, ListingImageRecord[]>;
  readonly options: Map<string, ListingOptionRecord[]>;
  readonly collectionIds: Map<string, string[]>;
}

/** An image as a caller supplies it — the shape `imageFileIds` expands into. */
export interface ListingImageInput {
  fileId: string;
  alt?: string;
  position: number;
}

/** A selectable option as a caller supplies it. */
export interface ListingOptionInput {
  name: string;
  values: string[];
  position: number;
}

/**
 * The newest-first feed order. See the module header — `desc nulls last` is the
 * index's ordering and `desc()` is not.
 */
const NEWEST_FIRST: SQL[] = [
  sql`${listings.publishedAt} desc nulls last`,
  sql`${listings.id} desc nulls last`,
];

/** Group rows by a listing id, preserving the order the query returned them in. */
function groupByListing<T extends { listingId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.listingId);
    if (bucket) bucket.push(row);
    else grouped.set(row.listingId, [row]);
  }
  return grouped;
}

/** One listing, or `null`. */
export async function findListingById(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord | null> {
  const [row] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
  return row ?? null;
}

/** Whether a listing exists. The cheap presence check, with no row materialized. */
export async function listingExists(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Several listings by id, in the ORDER THE CALLER ASKED FOR.
 *
 * The order is restored in memory rather than in SQL, because the caller's order
 * is not a property of the data: the favorites list wants recency of SAVING, and
 * a `where id in (…)` returns whatever the planner finds first. Ids naming a
 * listing that no longer exists are dropped, which is the behaviour the
 * favorites path already relied on.
 */
export async function findListingsByIds(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  if (listingIds.length === 0) return [];

  const rows = await db.select().from(listings).where(inArray(listings.id, [...listingIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return listingIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Images, options and collection memberships for a batch of listings.
 *
 * Three queries for the whole page — the N+1 this replaces would have been three
 * per listing. Each is ordered by `position` so the caller never re-sorts, and
 * `listing_collections.position` is NULL for a rules-derived membership, which
 * sorts last under Postgres's default `NULLS LAST` on an ascending order.
 */
export async function findListingChildren(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingChildren> {
  if (listingIds.length === 0) {
    return { images: new Map(), options: new Map(), collectionIds: new Map() };
  }
  const ids = [...listingIds];

  const [imageRows, optionRows, membershipRows] = await Promise.all([
    db
      .select()
      .from(listingImages)
      .where(inArray(listingImages.listingId, ids))
      .orderBy(asc(listingImages.position)),
    db
      .select()
      .from(listingOptions)
      .where(inArray(listingOptions.listingId, ids))
      .orderBy(asc(listingOptions.position)),
    db
      .select({
        listingId: listingCollections.listingId,
        collectionId: listingCollections.collectionId,
      })
      .from(listingCollections)
      .where(inArray(listingCollections.listingId, ids))
      .orderBy(asc(listingCollections.position)),
  ]);

  const collectionIds = new Map<string, string[]>();
  for (const row of membershipRows) {
    const bucket = collectionIds.get(row.listingId);
    if (bucket) bucket.push(row.collectionId);
    else collectionIds.set(row.listingId, [row.collectionId]);
  }

  return {
    images: groupByListing(imageRows),
    options: groupByListing(optionRows),
    collectionIds,
  };
}

/** Replace a listing's whole image list. */
export async function replaceListingImages(
  listingId: string,
  images: readonly ListingImageInput[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(listingImages).where(eq(listingImages.listingId, listingId));
  if (images.length === 0) return;
  await db.insert(listingImages).values(
    images.map((image) => ({
      listingId,
      fileId: image.fileId,
      alt: image.alt ?? null,
      position: image.position,
    })),
  );
}

/** Replace a listing's whole option list. */
export async function replaceListingOptions(
  listingId: string,
  options: readonly ListingOptionInput[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(listingOptions).where(eq(listingOptions.listingId, listingId));
  if (options.length === 0) return;
  await db.insert(listingOptions).values(
    options.map((option) => ({
      listingId,
      name: option.name,
      values: [...option.values],
      position: option.position,
    })),
  );
}

/** The columns a caller supplies when creating a listing. */
export type NewListing = Omit<
  ListingRecord,
  'id' | 'createdAt' | 'updatedAt' | 'geo' | 'searchVector'
> &
  Partial<Pick<ListingRecord, 'id'>>;

/**
 * Create a listing with its images and options, atomically.
 *
 * One transaction because a listing whose images landed and whose options did
 * not is a product page that renders wrong, with nothing to indicate why.
 */
export async function insertListing(
  values: NewListing,
  images: readonly ListingImageInput[],
  options: readonly ListingOptionInput[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<ListingRecord> => {
    const [row] = await tx.insert(listings).values(values).returning();
    await replaceListingImages(row.id, images, tx);
    await replaceListingOptions(row.id, options, tx);
    return row;
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Patch a listing's own columns. Returns `null` when there is no such listing. */
export async function updateListingColumns(
  listingId: string,
  patch: Partial<ListingRecord>,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord | null> {
  const [row] = await db
    .update(listings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(listings.id, listingId))
    .returning();
  return row ?? null;
}

/**
 * Recompute a listing's denormalized facets from its variants.
 *
 * The Mongo version read every variant row into the process and reduced it in
 * JavaScript. Here the reduction is an AGGREGATE — the rows never leave the
 * database — and the result is written back in a second statement.
 *
 * Two statements rather than one `UPDATE … FROM (…)` deliberately: the update
 * has to write NULLs into the price range when a listing has no variants at all,
 * and an aggregate over an empty set returns one row of NULLs from a plain
 * `select` but NO row from a `FROM` clause, which would silently skip the update
 * and leave the previous price range on a listing that no longer has one. The
 * race profile is identical to the Mongo version this replaces.
 *
 * Two details of the aggregate are load-bearing:
 *
 *  - **`has_inventory` is true for an UNTRACKED variant regardless of stock**,
 *    matching `!v.inventory.tracked || v.inventory.available > 0`. Dropping the
 *    first half silently unlists every made-to-order product.
 *  - **The price range takes its currency from the LOWEST-priced variant.** The
 *    Mongo version read `variants[0].price.currency` and assumed one currency
 *    per listing; this is the same answer for that case and a defined one for a
 *    listing whose variants disagree.
 */
export async function recomputeListingFacets(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const [facets] = await db
    .select({
      variantCount: sql<number>`count(*)::int`,
      minAmount: sql<number | null>`min(${productVariants.priceAmount})`,
      maxAmount: sql<number | null>`max(${productVariants.priceAmount})`,
      // Typed as `CurrencyCode` rather than `string`: the column it is read from
      // carries a CHECK against `ALL_CURRENCY_CODES`, so the aggregate cannot
      // return anything else, and the write below targets a narrowed column.
      currency: sql<CurrencyCode | null>`(array_agg(
        ${productVariants.priceCurrency} order by ${productVariants.priceAmount} asc nulls last
      ))[1]`,
      hasInventory: sql<boolean | null>`bool_or(
        not ${productVariants.inventoryTracked} or ${productVariants.inventoryAvailable} > 0
      )`,
    })
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId));

  // A currency without an amount would violate the `listings_price_range_*`
  // pairing in spirit and render as a price of nothing; both halves move together.
  const hasRange = facets?.minAmount !== null && facets?.currency !== null;

  await db
    .update(listings)
    .set({
      variantCount: facets?.variantCount ?? 0,
      priceRangeMinAmount: hasRange ? facets.minAmount : null,
      priceRangeMaxAmount: hasRange ? facets.maxAmount : null,
      priceRangeMinCurrency: hasRange ? facets.currency : null,
      priceRangeMaxCurrency: hasRange ? facets.currency : null,
      hasInventory: facets?.hasInventory ?? false,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, listingId));
}

/**
 * Move a listing's `favorite_count` by `delta`, clamped at zero.
 *
 * The clamp is `greatest(0, …)` in SQL rather than a guarded `where count > 0`,
 * which is what Mongo used: the guard makes the whole update a no-op when the
 * count is already 0, so a legitimate INCREMENT arriving at the same moment is
 * lost. Clamping applies the delta and refuses only to go negative.
 */
export async function adjustFavoriteCount(
  listingId: string,
  delta: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(listings)
    .set({
      favoriteCount: sql`greatest(0, ${listings.favoriteCount} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, listingId));
}

/** Move a listing's rating aggregate — the review service's write-back. */
export async function setListingRating(
  listingId: string,
  rating: number,
  reviewCount: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(listings)
    .set({ rating, reviewCount, updatedAt: new Date() })
    .where(eq(listings.id, listingId));
}

/** Store-owned, ACTIVE listing ids of a store — the set collection rules reconcile over. */
export async function findActiveStoreListingIds(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.storeId, storeId),
        eq(listings.ownerType, 'store'),
        eq(listings.status, 'active'),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Whether the given ids are all ACTIVE store-owned listings of `storeId`.
 *
 * Returns the ids that are NOT, which is what the caller reports back — a
 * collection cannot hold another store's product, and `listing_collections` has
 * a real foreign key now, so an unchecked id is a 23503 rather than the silent
 * no-match Mongo produced.
 */
export async function findUnknownStoreListingIds(
  storeId: string,
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (listingIds.length === 0) return [];
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        inArray(listings.id, [...listingIds]),
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
      ),
    );
  const known = new Set(rows.map((row) => row.id));
  return listingIds.filter((id) => !known.has(id));
}

/**
 * A page of a store's ACTIVE listings, newest first — the public store page.
 *
 * Returns the total alongside the page because the caller renders a pager;
 * `count(*) over ()` would compute it in the same scan, but it is a second
 * query here so the page can use the keyset index unencumbered.
 */
export async function findActiveStoreListingsPage(
  storeId: string,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listings.storeId, storeId),
    eq(listings.ownerType, 'store'),
    eq(listings.status, 'active'),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(...NEWEST_FIRST)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * A page of one seller's listings in ANY status, newest first — the seller's own
 * "my listings" screen, which must show drafts and archived items too.
 */
export async function findListingsPageForSeller(
  oxyUserId: string,
  status: ListingRecord['status'] | undefined,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listings.ownerType, 'user'),
    eq(listings.oxyUserId, oxyUserId),
    ...(status ? [eq(listings.status, status)] : []),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(sql`${listings.createdAt} desc`, sql`${listings.id} desc`)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * A page of a store's listings in ANY status — the dashboard product list.
 *
 * Separate from {@link findActiveStoreListingsPage} because the storefront must
 * never see a draft and the dashboard must always see one; folding them into a
 * single function with an optional status is how a public read eventually ships
 * with the filter omitted.
 */
export async function findStoreListingsPageForAdmin(
  storeId: string,
  filters: { status?: ListingRecord['status']; search?: string },
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listings.ownerType, 'store'),
    eq(listings.storeId, storeId),
    ...(filters.status ? [eq(listings.status, filters.status)] : []),
    ...(filters.search && filters.search.trim().length > 0
      ? [textMatch(filters.search.trim())]
      : []),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(sql`${listings.createdAt} desc`, sql`${listings.id} desc`)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * The full-text predicate, against the GENERATED `search_vector` column.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it is the only built-in
 * parser that never raises on user input (a lone `"` or `|` is a syntax error to
 * `to_tsquery`), and it gives buyers the quoting and `-exclusion` they already
 * expect from a search box. `plainto_tsquery` is also safe but ANDs every word
 * with no way to phrase-match, which the Mongo `$text` index did support.
 */
function textMatch(text: string): SQL {
  return sql`${listings.searchVector} @@ websearch_to_tsquery('english', ${text})`;
}

/** Everything a browse/search request can narrow by. */
export interface ListingSearchFilters {
  ownerType?: ListingOwnerType;
  storeId?: string;
  categorySlug?: string;
  condition?: ListingCondition;
  vendor?: string;
  productType?: string;
  collectionId?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  text?: string;
  near?: { lng: number; lat: number; radiusM: number };
}

/**
 * Translate the filters into predicates over `listings`.
 *
 * **Text and geo are now COMBINABLE.** Mongo could not run `$text` and `$near`
 * in one query, so `search.service` silently dropped the free-text term whenever
 * a `near` filter was present — a buyer searching "bike" within 5 km got every
 * listing within 5 km. A GIN `tsvector` match and a GiST `ST_DWithin` are
 * ordinary predicates here and simply AND together.
 *
 * `ST_DWithin` rather than ordering by distance: the Mongo `$near` both filtered
 * by `$maxDistance` and sorted by distance. The sort is dropped on purpose —
 * `sort` is an explicit request parameter, and a `near` filter silently
 * overriding it is the same class of surprise as geo silently overriding text.
 */
function buildSearchWhere(filters: ListingSearchFilters): SQL | undefined {
  const predicates: SQL[] = [eq(listings.status, 'active')];

  if (filters.ownerType) predicates.push(eq(listings.ownerType, filters.ownerType));
  if (filters.storeId) predicates.push(eq(listings.storeId, filters.storeId));
  if (filters.condition) predicates.push(eq(listings.condition, filters.condition));
  if (filters.vendor) predicates.push(eq(listings.vendor, filters.vendor));
  if (filters.productType) predicates.push(eq(listings.productType, filters.productType));
  if (filters.inStock) predicates.push(eq(listings.hasInventory, true));

  if (filters.categorySlug) {
    // Array CONTAINMENT so the GIN index on `category_slugs` serves it; `= any`
    // would work and could not use that index. `arrayContains` rather than a
    // hand-written `@> ${[value]}`: postgres.js EXPANDS a JavaScript array into
    // one bind parameter per element, so the hand-written form binds a bare
    // scalar against a `text[]` and fails at execution.
    predicates.push(arrayContains(listings.categorySlugs, [filters.categorySlug]));
  }

  if (filters.collectionId) {
    // UNCORRELATED on purpose: the sub-select names only `listing_collections`
    // columns, so there is no outer reference to qualify and no bare-column trap
    // to fall into. The `listing_collections_collection_id_position_idx` index
    // serves it directly.
    predicates.push(
      sql`${listings.id} in (
        select ${listingCollections.listingId}
        from ${listingCollections}
        where ${listingCollections.collectionId} = ${filters.collectionId}
      )`,
    );
  }

  if (typeof filters.minPrice === 'number') {
    predicates.push(gte(listings.priceRangeMinAmount, filters.minPrice));
  }
  if (typeof filters.maxPrice === 'number') {
    predicates.push(lte(listings.priceRangeMinAmount, filters.maxPrice));
  }

  if (filters.text && filters.text.trim().length > 0) {
    predicates.push(textMatch(filters.text.trim()));
  }

  if (filters.near) {
    predicates.push(
      sql`${listings.geo} is not null and st_dwithin(
        ${listings.geo},
        st_makepoint(${filters.near.lng}, ${filters.near.lat})::geography,
        ${filters.near.radiusM}
      )`,
    );
  }

  return and(...predicates);
}

/**
 * The ORDER BY for a browse sort.
 *
 * **A listing with no price range now sorts LAST in both price directions.**
 * Mongo's ascending sort put missing values FIRST, so `price_asc` led with every
 * listing that had no price at all; `price_desc` put them last. One consistent
 * rule replaces the two, and `asc nulls last` is Postgres's own default, which is
 * what `listings_status_price_published_at_idx` was built with.
 */
function buildSearchOrder(sort: ListingQuery['sort']): SQL[] {
  switch (sort) {
    case 'price_asc':
      return [
        sql`${listings.priceRangeMinAmount} asc nulls last`,
        sql`${listings.id} desc nulls last`,
      ];
    case 'price_desc':
      return [
        sql`${listings.priceRangeMinAmount} desc nulls last`,
        sql`${listings.id} desc nulls last`,
      ];
    default:
      return NEWEST_FIRST;
  }
}

/** Offset-paginated browse: one page plus the total for the pager. */
export async function searchListingsPage(
  filters: ListingSearchFilters,
  sort: ListingQuery['sort'],
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = buildSearchWhere(filters);

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(...buildSearchOrder(sort))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/** The boundary a keyset page resumes from. */
export interface ListingCursor {
  /** NULL for a listing that was never published — those sort after every other. */
  publishedAt: Date | null;
  id: string;
}

/**
 * Keyset-paginated browse over `(published_at desc nulls last, id desc)`.
 *
 * The boundary has THREE branches, not two, because the sort key is nullable:
 * a NULL `published_at` sorts after every non-null one, so from a non-null
 * cursor every NULL row is still ahead. Collapsing that into
 * `published_at < $1 or (published_at = $1 and id < $2)` silently drops every
 * unpublished row from the tail of the feed — both comparisons are NULL, which
 * is not TRUE.
 *
 * Reads `limit + 1` rows to answer `hasMore` without a second count.
 */
export async function searchListingsKeyset(
  filters: ListingSearchFilters,
  cursor: ListingCursor | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; hasMore: boolean }> {
  const predicates: SQL[] = [];
  const base = buildSearchWhere(filters);
  if (base) predicates.push(base);

  if (cursor) {
    // `lt`/`eq` and NOT a hand-written `sql\`${col} < ${date}\``: interpolating a
    // value into a raw `sql` template binds it WITHOUT the column's mapper, so a
    // `mode: 'date'` timestamptz arrives at postgres.js as a JavaScript `Date`
    // and the driver throws `ERR_INVALID_ARG_TYPE`. That is the write-side face
    // of the mapper-bypass trap `CONVENTIONS.md` describes for `db.execute`.
    const boundary =
      cursor.publishedAt === null
        ? and(isNull(listings.publishedAt), lt(listings.id, cursor.id))
        : or(
            isNull(listings.publishedAt),
            lt(listings.publishedAt, cursor.publishedAt),
            and(eq(listings.publishedAt, cursor.publishedAt), lt(listings.id, cursor.id)),
          );
    if (boundary) predicates.push(boundary);
  }

  const rows = await db
    .select()
    .from(listings)
    .where(and(...predicates))
    .orderBy(...NEWEST_FIRST)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Listing ids of a store that satisfy an automated collection's rule predicate.
 *
 * The predicate is built by `collectionRules.ts` and is always scoped here to
 * the store's own ACTIVE store-owned listings, so a rule can never reach another
 * merchant's catalogue however it was written.
 */
export async function findStoreListingIdsMatching(
  storeId: string,
  predicate: SQL,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
        eq(listings.status, 'active'),
        predicate,
      ),
    );
  return rows.map((row) => row.id);
}

/** Whether ONE listing satisfies a rule predicate — the per-product recompute. */
export async function listingMatchesRules(
  listingId: string,
  storeId: string,
  predicate: SQL,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.id, listingId),
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
        eq(listings.status, 'active'),
        predicate,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether the listing has ANY variant matching a variant-level predicate.
 *
 * `compare_at_price` lives on `product_variants` and is not denormalized onto
 * the listing, so a collection rule on it is an EXISTS over the child table.
 * Every reference to the OUTER table inside it goes through `qualified()`: a
 * drizzle column interpolated into `sql` renders BARE when its table is not in
 * that sub-statement's own FROM, so `where ${productVariants.listingId} =
 * ${listings.id}` becomes `where "listing_id" = "id"` — both resolving against
 * `product_variants`, comparing two of ITS columns, matching nothing, with no
 * error at all.
 */
export function variantExistsPredicate(variantPredicate: SQL): SQL {
  return sql`exists (
    select 1 from ${productVariants}
    where ${qualified(productVariants.listingId)} = ${qualified(listings.id)}
      and ${variantPredicate}
  )`;
}
