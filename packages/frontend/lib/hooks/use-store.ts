import { useQuery } from '@tanstack/react-query';
import type { Collection, PaginatedResponse, Review } from '@mercaria/shared-types';
import {
  fetchStore,
  fetchStoreCollections,
  fetchStoreCollection,
  type StoreDetailResponse,
  type StoreCollectionResponse,
} from '../api/stores';
import { fetchStoreReviews } from '../api/reviews';
import { queryKeys } from './query-keys';

/** Two minutes — store pages are relatively stable. */
const STALE_TIME = 1000 * 60 * 2;

/** Fetch a store's landing page: merchant summary + first listing page. */
export function useStore(handle: string) {
  return useQuery<StoreDetailResponse>({
    queryKey: queryKeys.stores.detail(handle),
    queryFn: () => fetchStore(handle),
    enabled: !!handle,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** Fetch all collections for a store. */
export function useStoreCollections(handle: string) {
  return useQuery<Collection[]>({
    queryKey: queryKeys.stores.collections(handle),
    queryFn: () => fetchStoreCollections(handle),
    enabled: !!handle,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** Fetch a single collection with its listings. */
export function useStoreCollection(handle: string, collectionHandle: string) {
  return useQuery<StoreCollectionResponse>({
    queryKey: queryKeys.stores.collection(handle, collectionHandle),
    queryFn: () => fetchStoreCollection(handle, collectionHandle),
    enabled: !!handle && !!collectionHandle,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** Reviews shown per page in the store reviews sheet. */
const STORE_REVIEWS_PAGE_LIMIT = 20;

/**
 * A page of a store's PRODUCT reviews, backed by `GET /stores/:handle/reviews`.
 * Returns the paginated envelope (each `Review` hydrated with `product` context)
 * so the store menu sheet's Reviews page can render product-thumbnail cards.
 */
export function useStoreReviews(handle: string, page = 1, limit = STORE_REVIEWS_PAGE_LIMIT) {
  return useQuery<PaginatedResponse<Review>>({
    queryKey: queryKeys.stores.reviews(handle, page),
    queryFn: () => fetchStoreReviews(handle, { page, limit }),
    enabled: !!handle,
    staleTime: STALE_TIME,
    retry: 2,
  });
}
