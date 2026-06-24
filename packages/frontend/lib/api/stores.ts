import type {
  ApiResponse,
  Collection,
  Listing,
  MerchantSummary,
  Pagination,
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
  store: MerchantSummary;
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
  const { data } = await apiClient.get<ApiResponse<StoreDetailResponse>>(
    `/stores/${handle}`,
    { params },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load store');
  }
  return data.data;
}

/** Fetch all collections for a store. */
export async function fetchStoreCollections(handle: string): Promise<Collection[]> {
  const { data } = await apiClient.get<ApiResponse<Collection[]>>(
    `/stores/${handle}/collections`,
  );
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
    throw new Error(
      data.error ?? data.message ?? 'Failed to load collection',
    );
  }
  return data.data;
}
