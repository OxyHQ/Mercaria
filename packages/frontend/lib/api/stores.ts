import {
  MAX_LISTINGS_BY_ID,
  type ApiResponse,
  type Collection,
  type Listing,
  type StoreSummary,
  type Pagination,
  type StorefrontMerchandisedPage,
  type StorefrontMerchandising,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Store storefront API client.
 *
 * All responses are wrapped in `ApiResponse<T>` and unwrapped here, throwing on
 * failure the same way `feed.ts` does.
 */

/** Public store detail: the merchant summary + first page of listings. */
export interface StoreDetailResponse {
  store: StoreSummary;
  listings: Listing[];
  pagination: Pagination;
}

/** A collection's metadata + the listings it contains for a given page. */
export interface StoreCollectionResponse {
  collection: Collection;
  products: Listing[];
  pagination: Pagination;
}

/** Fetch a store by handle, optionally paginating its listing grid. */
export async function fetchStore(
  handle: string,
  params?: { page?: number; limit?: number },
): Promise<StoreDetailResponse> {
  const { data } = await apiClient.get<ApiResponse<StoreDetailResponse>>(`/stores/${handle}`, {
    params,
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load store');
  }
  return data.data;
}

/** Fetch all collections for a store. */
export async function fetchStoreCollections(handle: string): Promise<Collection[]> {
  const { data } = await apiClient.get<ApiResponse<Collection[]>>(`/stores/${handle}/collections`);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load collections');
  }
  return data.data;
}

/** Fetch a single store collection with its listings. */
export async function fetchStoreCollection(
  handle: string,
  collectionHandle: string,
  params?: { page?: number; limit?: number },
): Promise<StoreCollectionResponse> {
  const { data } = await apiClient.get<ApiResponse<StoreCollectionResponse>>(
    `/stores/${handle}/collections/${collectionHandle}`,
    { params },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load collection');
  }
  return data.data;
}

/**
 * What the store's own merchandising rules apply to its page right now (a paid
 * Mercaria plan tool). Empty — and the page renders its ordinary order — when
 * the store has no live rule or its plan no longer includes the tool.
 */
export async function fetchStoreMerchandising(handle: string): Promise<StorefrontMerchandising> {
  const { data } = await apiClient.get<ApiResponse<StorefrontMerchandising>>(
    `/stores/${handle}/merchandising`,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load store merchandising');
  }
  return data.data;
}

/** One page of the grid's listing ids in the store's own merchandised order. */
export async function fetchStoreMerchandisedPage(
  handle: string,
  params: { collectionId?: string; page: number; limit: number },
): Promise<StorefrontMerchandisedPage> {
  const { data } = await apiClient.get<ApiResponse<StorefrontMerchandisedPage>>(
    `/stores/${handle}/merchandising/listings`,
    { params },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load store merchandising');
  }
  return data.data;
}

/**
 * This store's active listings by id, hydrated, in the order given (at most
 * `MAX_LISTINGS_BY_ID`). The endpoint decides no order of its own.
 */
export async function fetchStoreListingsByIds(
  handle: string,
  ids: readonly string[],
): Promise<Listing[]> {
  if (ids.length === 0) return [];
  const { data } = await apiClient.get<ApiResponse<{ listings: Listing[] }>>(
    `/stores/${handle}/listings`,
    { params: { ids: ids.slice(0, MAX_LISTINGS_BY_ID).join(',') } },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load listings');
  }
  return data.data.listings;
}
