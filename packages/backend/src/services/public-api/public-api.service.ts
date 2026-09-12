/**
 * The public integration surface's reads (#1017): what another Oxy application
 * may learn from Mercaria through `/public/v1`, and the status rules that decide
 * whether it learns anything at all.
 *
 * ## The status semantics are the contract's point
 *
 * A consumer holds a persisted REFERENCE (`MercariaProductRef` and friends) and
 * hydrates it every time it renders. So the one distinction it cannot live
 * without is "this never existed" versus "this existed and is gone", and that
 * distinction is decided HERE, once per entity kind:
 *
 * | entity | 200 | 410 `GONE` | 404 `NOT_FOUND` |
 * |---|---|---|---|
 * | product | `active`, `sold` | `archived`, `restricted`, a draft that WAS published, or its store not `active` | no row, a malformed id, a draft never published |
 * | store | `active` | `suspended`, `closed` | no row, a malformed id or handle |
 * | collection | published, store `active` | unpublished after being published, or its store not `active` | no row, a malformed id, never published |
 *
 * "Was published" is `listings.published_at` — the FIRST activation, written by
 * one repository — and `collections.published_at`, stamped on first publish and
 * never cleared by unpublishing. A never-published draft answers 404 EVEN inside
 * a suspended store: it never publicly existed, so no reference to it can have
 * been legitimately minted.
 *
 * A 410 carries no entity data and does not say WHY. Whether a listing was
 * archived by its seller or withdrawn by a moderation jury is not a fact another
 * application may read.
 *
 * ## Lists only ever contain publicly live products
 *
 * Every list reads `status = 'active'` (the search and collection reads already
 * do), and the search additionally drops a store-owned listing whose store is not
 * `active` — `liveStoresOnly`, which the storefront browse deliberately does not
 * set. A list scoped to a store or a collection first applies that entity's own
 * gate, so a list over a suspended store is a 410, not an empty page.
 */

import { isLiveEntityId } from '@oxy.so/db';
import type {
  ListingQuery,
  MercariaCollection,
  MercariaPage,
  MercariaProduct,
  MercariaProductSort,
  MercariaProductSummary,
  MercariaStore,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { gone, notFound } from '../../lib/errors/error-codes.js';
import {
  findListingById,
  searchListingsSlice,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import {
  findCollectionProductsSlice,
  findCollectionRowById,
  findPublishedCollectionsSlice,
  type CollectionRow,
} from '../../db/merchandising/collectionRepository.js';
import {
  findStoreRow,
  findStoreRowByHandle,
  findStoresByIds,
  type StoreRow,
} from '../../db/stores/storeRepository.js';
import { hydrateListings, resolveMedia } from '../catalog-hydration.service.js';
import { toFilters } from '../search.service.js';
import { resolveStoreRatingSource } from '../reviews/review-aggregate.service.js';
import {
  clampPublicPageLimit,
  nextPublicCursor,
  publicCursorFingerprint,
  resolvePublicCursorOffset,
  type PublicCursorKind,
} from './cursor.js';
import {
  projectCollection,
  projectProduct,
  projectProductSummary,
  projectStore,
} from './projection.js';

/** The messages. Deliberately generic: a 410 never says why. */
const PRODUCT_NOT_FOUND = 'Product not found';
const PRODUCT_GONE = 'This product is no longer available';
const STORE_NOT_FOUND = 'Store not found';
const STORE_GONE = 'This store is no longer available';
const COLLECTION_NOT_FOUND = 'Collection not found';
const COLLECTION_GONE = 'This collection is no longer available';

/** A page request: the offset-bearing cursor as sent, and the page size. */
export interface PublicPageParams {
  readonly limit: number;
  readonly cursor?: string;
}

/** A product list request. `sort` is already defaulted by the schema. */
export interface PublicProductListParams extends PublicPageParams {
  readonly q?: string;
  readonly locale?: string;
  readonly inStock?: boolean;
  readonly sort: MercariaProductSort;
}

/** The global product search: a product list optionally scoped by store or collection. */
export interface PublicProductSearchParams extends PublicProductListParams {
  readonly storeId?: string;
  readonly collectionId?: string;
}

/** The web origin every URL is built against, read once per call. */
function webOrigin(): string {
  return config.web.origin;
}

// ── Gates ───────────────────────────────────────────────────────────────────

/** A store that may be read publicly, or the 404/410 that says why not. */
async function publicStoreById(storeId: string): Promise<StoreRow> {
  if (!isLiveEntityId(storeId)) throw notFound(STORE_NOT_FOUND);
  const store = await findStoreRow(storeId);
  if (!store) throw notFound(STORE_NOT_FOUND);
  if (store.status !== 'active') throw gone(STORE_GONE);
  return store;
}

/** A collection that may be read publicly, with its store, or the 404/410. */
async function publicCollectionById(
  collectionId: string,
): Promise<{ collection: CollectionRow; store: StoreRow }> {
  if (!isLiveEntityId(collectionId)) throw notFound(COLLECTION_NOT_FOUND);
  const collection = await findCollectionRowById(collectionId);
  if (!collection) throw notFound(COLLECTION_NOT_FOUND);
  // Never published: no reference to it can have been legitimately minted.
  if (!collection.isPublished && collection.publishedAt === null) {
    throw notFound(COLLECTION_NOT_FOUND);
  }
  const store = await findStoreRow(collection.storeId);
  if (!store || store.status !== 'active') throw gone(COLLECTION_GONE);
  if (!collection.isPublished) throw gone(COLLECTION_GONE);
  return { collection, store };
}

// ── Product lists ───────────────────────────────────────────────────────────

/**
 * The listing search's sort for a public one.
 *
 * `relevance` has no ranking of its own in the listing search: a text match is a
 * predicate there, and the matches are ordered newest-first — which is what
 * `GET /listings?q=` has always served. Mapping it onto that order keeps ONE
 * answer to "what does this search return first"; `docs/public-api.md` says the
 * order behind `relevance` is not part of the contract.
 */
function listingSort(sort: MercariaProductSort): ListingQuery['sort'] {
  switch (sort) {
    case 'price_asc':
      return 'price_asc';
    case 'price_desc':
      return 'price_desc';
    default:
      return 'newest';
  }
}

/**
 * Project a page of listing rows into product cards.
 *
 * Hydrated WITHOUT a viewer: a card carries no `viewer`, so loading the caller's
 * favourites for it would be a query whose answer nothing serializes.
 */
async function summarize(rows: ListingRecord[]): Promise<MercariaProductSummary[]> {
  if (rows.length === 0) return [];
  const storeIds = [
    ...new Set(rows.flatMap((row) => (row.ownerType === 'store' && row.storeId ? [row.storeId] : []))),
  ];
  const [hydrated, storeRows] = await Promise.all([
    hydrateListings(rows),
    findStoresByIds(storeIds),
  ]);
  const storeById = new Map(storeRows.map((store) => [store.id, store]));
  const origin = webOrigin();
  // `hydrateListings` preserves input order, so row `i` is listing `i`.
  return hydrated.map((listing, index) => {
    const storeId = rows[index]?.storeId;
    return projectProductSummary(
      listing,
      storeId ? storeById.get(storeId) : undefined,
      origin,
      resolveMedia,
    );
  });
}

/** The shared body of every searched product list. */
async function searchProductPage(
  kind: PublicCursorKind,
  params: PublicProductSearchParams,
): Promise<MercariaPage<MercariaProductSummary>> {
  const fingerprint = publicCursorFingerprint(kind, {
    q: params.q,
    locale: params.q === undefined ? undefined : params.locale,
    storeId: params.storeId,
    collectionId: params.collectionId,
    inStock: params.inStock === true ? true : undefined,
    sort: params.sort,
  });
  const offset = resolvePublicCursorOffset(params.cursor, kind, fingerprint);

  const query: ListingQuery = { sort: listingSort(params.sort) };
  if (params.q !== undefined) query.q = params.q;
  if (params.q !== undefined && params.locale !== undefined) query.locale = params.locale;
  if (params.storeId !== undefined) query.storeId = params.storeId;
  if (params.collectionId !== undefined) query.collectionId = params.collectionId;
  if (params.inStock === true) query.inStock = true;

  const limit = clampPublicPageLimit(offset, params.limit);
  const { rows, hasMore } = await searchListingsSlice(
    { ...toFilters(query), liveStoresOnly: true },
    query.sort,
    offset,
    limit,
  );
  return {
    items: await summarize(rows),
    nextCursor: nextPublicCursor(kind, fingerprint, offset, rows.length, hasMore),
  };
}

/**
 * `GET /public/v1/products` — search every publicly live product.
 *
 * A `storeId` or `collectionId` filter applies that entity's gate FIRST, so a
 * filter naming a suspended store is a 410 and one naming an unpublished
 * collection is a 404/410 — never an empty page, and never a way to list the
 * members of a collection its merchant has not published.
 */
export async function searchPublicProducts(
  params: PublicProductSearchParams,
): Promise<MercariaPage<MercariaProductSummary>> {
  if (params.storeId !== undefined) await publicStoreById(params.storeId);
  if (params.collectionId !== undefined) await publicCollectionById(params.collectionId);
  return searchProductPage('products', params);
}

/** `GET /public/v1/stores/:id/products` — one live store's live products. */
export async function listPublicStoreProducts(
  storeId: string,
  params: PublicProductListParams,
): Promise<MercariaPage<MercariaProductSummary>> {
  const store = await publicStoreById(storeId);
  return searchProductPage('store-products', { ...params, storeId: store.id });
}

/** `GET /public/v1/collections/:id/products` — in the collection's OWN sort order. */
export async function listPublicCollectionProducts(
  collectionId: string,
  params: PublicPageParams,
): Promise<MercariaPage<MercariaProductSummary>> {
  const { collection } = await publicCollectionById(collectionId);
  const kind: PublicCursorKind = 'collection-products';
  const fingerprint = publicCursorFingerprint(kind, { collectionId: collection.id });
  const offset = resolvePublicCursorOffset(params.cursor, kind, fingerprint);
  const { rows, hasMore } = await findCollectionProductsSlice(
    collection.id,
    collection.sortOrder,
    collection.type === 'manual',
    offset,
    clampPublicPageLimit(offset, params.limit),
  );
  return {
    items: await summarize(rows),
    nextCursor: nextPublicCursor(kind, fingerprint, offset, rows.length, hasMore),
  };
}

// ── Detail reads ────────────────────────────────────────────────────────────

/**
 * `GET /public/v1/products/:id`.
 *
 * `viewerId` is the verified Oxy caller, when the request carried a valid
 * session; it decides whether `viewer` is present at all.
 */
export async function getPublicProduct(
  productId: string,
  viewerId: string | undefined,
): Promise<MercariaProduct> {
  if (!isLiveEntityId(productId)) throw notFound(PRODUCT_NOT_FOUND);
  const row = await findListingById(productId);
  if (!row) throw notFound(PRODUCT_NOT_FOUND);
  if (row.status === 'draft' && row.publishedAt === null) throw notFound(PRODUCT_NOT_FOUND);

  let store: StoreRow | undefined;
  if (row.ownerType === 'store') {
    store = (row.storeId ? await findStoreRow(row.storeId) : null) ?? undefined;
    if (!store || store.status !== 'active') throw gone(PRODUCT_GONE);
  }
  if (row.status !== 'active' && row.status !== 'sold') throw gone(PRODUCT_GONE);

  const [listing] = await hydrateListings([row], viewerId ? { viewerId } : {});
  if (!listing) throw notFound(PRODUCT_NOT_FOUND);
  return projectProduct(
    listing,
    store,
    webOrigin(),
    resolveMedia,
    viewerId ? listing.saved : undefined,
  );
}

/** Project a live store, with the rating its public page shows. */
async function storeWithRating(store: StoreRow): Promise<MercariaStore> {
  // `resolveStoreRatingSource` — the ONE place a store's public rating is
  // chosen (merchant aggregate when linked, its own legacy figures otherwise),
  // so this surface can never show a number the store page does not.
  const source = await resolveStoreRatingSource(store.id);
  return projectStore(
    store,
    source ?? { rating: store.rating, reviewCount: store.reviewCount },
    webOrigin(),
    resolveMedia,
  );
}

/** `GET /public/v1/stores/:id`. */
export async function getPublicStore(storeId: string): Promise<MercariaStore> {
  return storeWithRating(await publicStoreById(storeId));
}

/** `GET /public/v1/stores/lookup?handle=` — the same rules, by CURRENT handle. */
export async function lookupPublicStore(handle: string): Promise<MercariaStore> {
  const store = await findStoreRowByHandle(handle);
  if (!store) throw notFound(STORE_NOT_FOUND);
  if (store.status !== 'active') throw gone(STORE_GONE);
  return storeWithRating(store);
}

/** `GET /public/v1/stores/:id/collections` — PUBLISHED collections only. */
export async function listPublicStoreCollections(
  storeId: string,
  params: PublicPageParams,
): Promise<MercariaPage<MercariaCollection>> {
  const store = await publicStoreById(storeId);
  const kind: PublicCursorKind = 'store-collections';
  const fingerprint = publicCursorFingerprint(kind, { storeId: store.id });
  const offset = resolvePublicCursorOffset(params.cursor, kind, fingerprint);
  const { rows, hasMore } = await findPublishedCollectionsSlice(
    store.id,
    offset,
    clampPublicPageLimit(offset, params.limit),
  );
  const origin = webOrigin();
  return {
    items: rows.map((row) => projectCollection(row, store.handle, origin, resolveMedia)),
    nextCursor: nextPublicCursor(kind, fingerprint, offset, rows.length, hasMore),
  };
}

/** `GET /public/v1/collections/:id`. */
export async function getPublicCollection(collectionId: string): Promise<MercariaCollection> {
  const { collection, store } = await publicCollectionById(collectionId);
  return projectCollection(collection, store.handle, webOrigin(), resolveMedia);
}
