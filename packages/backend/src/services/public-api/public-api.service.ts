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
 * | entity | 200 | 410 `gone` | 404 `not_found` |
 * |---|---|---|---|
 * | product | `active`, `sold` | `archived`, `restricted`, a draft that WAS published, or its store not `active` | no row, a malformed id, a draft never published |
 * | store | `active` | `suspended`, `closed` | no row, a malformed id or handle |
 * | collection | published, store `active` | unpublished after being published, or its store not `active` | no row, a malformed id, never published |
 * | location | published, active, unrestricted, store `active`, its GoWay place names it back | withdrawn or back to draft after publishing, restricted, deactivated, its store not `active`, or its place no longer vouches for it | no row, a malformed id, never published |
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
 *
 * ## A location is public only while its GoWay place says so (ADR 0013)
 *
 * The trust rule — the place exists, is active and names THIS location back at
 * a claimant's tier — is applied on every location read against the cached
 * place (`services/goway/`), exactly as nearby discovery applies it. A place
 * that stopped vouching makes the location a 410 and takes it out of every
 * list. GoWay unable to answer, with nothing recent cached, is a 503 and never
 * a 410: a consumer may discard a reference on `gone`, and an outage is not a
 * fact about the location. A list only asks GoWay when Mercaria has a row to
 * ask about, so a place with no Mercaria location never depends on GoWay.
 */

import { isLiveEntityId } from '@oxy.so/db';
import type { ListingQuery } from '@mercaria/shared-types';
import type {
  MercariaCollection,
  MercariaLocation,
  MercariaLocationProduct,
  MercariaPage,
  MercariaProduct,
  MercariaProductSort,
  MercariaProductSummary,
  MercariaPublicCursorKind,
  MercariaStore,
} from '@mercaria/contracts';
import { config } from '../../config/index.js';
import { gone, notFound, serviceUnavailable } from './errors.js';
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
  findStoreById,
  findStoreByHandle,
  findStoresByIds,
  type StoreRow,
} from '../../db/stores/storeRepository.js';
import {
  findLocationStockLevels,
  findPublicLocationById,
  findPublishedLocationsSlice,
  type LocationStockLevel,
  type PublicLocationRow,
  type PublishedLocationScope,
} from '../../db/pickup/publicLocationRepository.js';
import { readPlace, readPlaces } from '../goway/places.js';
import { placeLinkBroken, placeLinkGaps, type PlaceLookup } from '../goway/place-facts.js';
import { locationCollectionBlockers } from '../pickup/eligibility.js';
import { hydrateListings, resolveMedia } from '../catalog-hydration.service.js';
import { toFilters } from '../search.service.js';
import { resolveStoreRatingSource } from '../reviews/review-aggregate.service.js';
import {
  clampPublicPageLimit,
  nextPublicCursor,
  publicCursorFingerprint,
  resolvePublicCursorOffset,
} from './cursor.js';
import {
  projectCollection,
  projectLocation,
  projectLocationProduct,
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
const LOCATION_NOT_FOUND = 'Location not found';
const LOCATION_GONE = 'This location is no longer available';
const PLACES_UNAVAILABLE =
  'Locations cannot be checked right now, because GoWay (which says where they are) did not answer. ' +
  'Try again in a minute.';

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
  const store = await findStoreById(storeId);
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
  const store = await findStoreById(collection.storeId);
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
  kind: MercariaPublicCursorKind,
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
  const kind: MercariaPublicCursorKind = 'collection-products';
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
    store = (row.storeId ? await findStoreById(row.storeId) : null) ?? undefined;
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
  const store = await findStoreByHandle(handle);
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
  const kind: MercariaPublicCursorKind = 'store-collections';
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

// ── Locations ───────────────────────────────────────────────────────────────

/** What the trust rule says about one location: the place it may be read from, and its discoverability. */
interface VouchedLocation {
  readonly goWayPlaceId: string;
  readonly discoverable: boolean;
}

/**
 * Apply the trust rule to a location whose publication, activity and store
 * already passed their gates: `null` when its place does not vouch for it.
 *
 * `discoverable` is the location half of #93's collection conjunction
 * (`locationCollectionBlockers`) — collection offered and not paused, the place
 * complete enough to take one — the same answer nearby discovery acts on. The
 * store is live by construction here, which every caller has already checked.
 *
 * @throws `service_unavailable` when GoWay could not be asked and nothing
 *   recent is cached.
 */
function vouchedLocation(row: PublicLocationRow, lookup: PlaceLookup | null): VouchedLocation | null {
  const gaps = placeLinkGaps({ locationId: row.locationId, goWayPlaceId: row.goWayPlaceId, lookup });
  if (gaps.includes('goway_unavailable')) throw serviceUnavailable(PLACES_UNAVAILABLE);
  if (row.goWayPlaceId === null || placeLinkBroken(gaps)) return null;
  const blockers = locationCollectionBlockers({
    publicationState: row.publicationState,
    pickupOffered: row.pickupOffered,
    pickupPaused: row.pickupPaused,
    restricted: row.restricted,
    placeLinkGaps: gaps,
    locationActive: row.locationActive,
    storeActive: true,
  });
  return { goWayPlaceId: row.goWayPlaceId, discoverable: blockers.length === 0 };
}

/** A location that may be read publicly, with its store and its verdict, or the 404/410/503. */
async function publicLocationById(
  locationId: string,
): Promise<{ row: PublicLocationRow; store: StoreRow; vouched: VouchedLocation }> {
  if (!isLiveEntityId(locationId)) throw notFound(LOCATION_NOT_FOUND);
  const row = await findPublicLocationById(locationId);
  // Never published: no reference to it can have been legitimately minted. A
  // location published now counts even without the stamp (one published by an
  // image that predates `published_at`).
  if (!row || (row.publishedAt === null && row.publicationState !== 'published')) {
    throw notFound(LOCATION_NOT_FOUND);
  }
  const store = await findStoreById(row.storeId);
  if (!store || store.status !== 'active') throw gone(LOCATION_GONE);
  if (row.publicationState !== 'published' || row.restricted || !row.locationActive) throw gone(LOCATION_GONE);
  const vouched = vouchedLocation(row, row.goWayPlaceId === null ? null : await readPlace(row.goWayPlaceId));
  if (vouched === null) throw gone(LOCATION_GONE);
  return { row, store, vouched };
}

/**
 * One page of published locations in a scope, each kept only while its place
 * vouches for it. GoWay is asked once per distinct place on the page, and not
 * at all for an empty one.
 */
async function publicLocationPage(
  kind: MercariaPublicCursorKind,
  scope: PublishedLocationScope,
  params: PublicPageParams,
): Promise<MercariaPage<MercariaLocation>> {
  const fingerprint = publicCursorFingerprint(kind, { ...scope });
  const offset = resolvePublicCursorOffset(params.cursor, kind, fingerprint);
  const { rows, hasMore } = await findPublishedLocationsSlice(scope, offset, clampPublicPageLimit(offset, params.limit));
  const [lookups, storeRows] = await Promise.all([
    readPlaces(rows.flatMap((row) => (row.goWayPlaceId === null ? [] : [row.goWayPlaceId]))),
    findStoresByIds([...new Set(rows.map((row) => row.storeId))]),
  ]);
  const storeById = new Map(storeRows.map((store) => [store.id, store]));
  const origin = webOrigin();
  // A row whose place no longer vouches for it is left out, so a page may come
  // back shorter than `limit` with a next cursor — the offset counts rows.
  const items = rows.flatMap((row) => {
    const store = storeById.get(row.storeId);
    const vouched = vouchedLocation(row, row.goWayPlaceId === null ? null : (lookups.get(row.goWayPlaceId) ?? null));
    return store === undefined || vouched === null
      ? []
      : [projectLocation(row, vouched.goWayPlaceId, store, vouched.discoverable, origin, resolveMedia)];
  });
  return { items, nextCursor: nextPublicCursor(kind, fingerprint, offset, rows.length, hasMore) };
}

/**
 * `GET /public/v1/locations?goWayPlaceId=` — the shop fronts trading from one
 * GoWay place. A place names one location back at its strongest tier, so this
 * is at most one item today; it is a page so a shared place (a mall) changes
 * nothing for a consumer. A place nobody trades from is an empty page.
 */
export async function listPublicLocations(
  goWayPlaceId: string,
  params: PublicPageParams,
): Promise<MercariaPage<MercariaLocation>> {
  return publicLocationPage('locations', { goWayPlaceId }, params);
}

/** `GET /public/v1/stores/:id/locations` — one live store's public shop fronts. */
export async function listPublicStoreLocations(
  storeId: string,
  params: PublicPageParams,
): Promise<MercariaPage<MercariaLocation>> {
  const store = await publicStoreById(storeId);
  return publicLocationPage('store-locations', { storeId: store.id }, params);
}

/** `GET /public/v1/locations/:id`. */
export async function getPublicLocation(locationId: string): Promise<MercariaLocation> {
  const { row, store, vouched } = await publicLocationById(locationId);
  return projectLocation(row, vouched.goWayPlaceId, store, vouched.discoverable, webOrigin(), resolveMedia);
}

/**
 * `GET /public/v1/locations/:id/products` — the store's publicly live products
 * stocked at this location, each with its bounded availability there.
 *
 * "Stocked" is a level row at the location; `inStock=true` narrows to a
 * positive count inside the location's own freshness window — the SQL half of
 * `inventoryBlockers`, which then decides each product's word.
 */
export async function listPublicLocationProducts(
  locationId: string,
  params: PublicProductListParams,
): Promise<MercariaPage<MercariaLocationProduct>> {
  const { row } = await publicLocationById(locationId);
  const kind: MercariaPublicCursorKind = 'location-products';
  const fingerprint = publicCursorFingerprint(kind, {
    locationId: row.locationId,
    q: params.q,
    locale: params.q === undefined ? undefined : params.locale,
    inStock: params.inStock === true ? true : undefined,
    sort: params.sort,
  });
  const offset = resolvePublicCursorOffset(params.cursor, kind, fingerprint);

  const at = new Date();
  const query: ListingQuery = { sort: listingSort(params.sort) };
  if (params.q !== undefined) query.q = params.q;
  if (params.q !== undefined && params.locale !== undefined) query.locale = params.locale;
  const freshSince = new Date(at.getTime() - row.stockConfirmationIntervalSeconds * 1_000);
  const { rows, hasMore } = await searchListingsSlice(
    {
      ...toFilters(query),
      storeId: row.storeId,
      liveStoresOnly: true,
      stockedAt: { locationId: row.locationId, ...(params.inStock === true ? { freshSince } : {}) },
    },
    query.sort,
    offset,
    clampPublicPageLimit(offset, params.limit),
  );
  const [summaries, levels] = await Promise.all([
    summarize(rows),
    findLocationStockLevels(row.locationId, rows.map((listing) => listing.id)),
  ]);
  const levelsByListing = new Map<string, LocationStockLevel[]>();
  for (const level of levels) {
    levelsByListing.set(level.listingId, [...(levelsByListing.get(level.listingId) ?? []), level]);
  }
  // `summarize` preserves row order. A level deleted between the two reads
  // leaves its product out rather than failing the page.
  const items = summaries.flatMap((summary, index) => {
    const stock = levelsByListing.get(rows[index]?.id ?? '') ?? [];
    return stock.length === 0 ? [] : [projectLocationProduct(summary, stock, row, at)];
  });
  return { items, nextCursor: nextPublicCursor(kind, fingerprint, offset, rows.length, hasMore) };
}
