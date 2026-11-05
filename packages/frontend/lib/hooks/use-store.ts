import { useQuery } from '@tanstack/react-query';
import type {
  Collection,
  Listing,
  PaginatedResponse,
  Review,
  StorefrontMerchandising,
} from '@mercaria/shared-types';
import {
  fetchStore,
  fetchStoreListingsByIds,
  fetchStoreMerchandisedPage,
  fetchStoreMerchandising,
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
export function useStoreReviews(
  handle: string,
  page = 1,
  limit = STORE_REVIEWS_PAGE_LIMIT,
  query = '',
) {
  return useQuery<PaginatedResponse<Review>>({
    queryKey: queryKeys.stores.reviews(handle, page, limit, query),
    queryFn: () => fetchStoreReviews(handle, { page, limit, query }),
    enabled: !!handle,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/**
 * What the store's own merchandising rules apply to its page right now.
 *
 * A failure is not an error the page shows: it answers `undefined`, and the
 * page renders the order every store gets.
 */
export function useStoreMerchandising(handle: string) {
  return useQuery<StorefrontMerchandising>({
    queryKey: queryKeys.stores.merchandising(handle),
    queryFn: () => fetchStoreMerchandising(handle),
    enabled: !!handle,
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/**
 * One page of the grid in the store's merchandised order, hydrated — or `null`
 * when no rule applies to that grid any more (the page then falls back).
 */
export function useStoreMerchandisedListings(
  handle: string,
  params: { collectionId?: string; page: number; limit: number },
  enabled: boolean,
) {
  return useQuery<PaginatedResponse<Listing> | null>({
    queryKey: queryKeys.stores.merchandisedPage(
      handle,
      params.collectionId,
      params.page,
      params.limit,
    ),
    queryFn: async () => {
      const page = await fetchStoreMerchandisedPage(handle, params);
      if (!page.applied) return null;
      const byId = new Map(
        (await fetchStoreListingsByIds(handle, page.listingIds)).map((l) => [l.id, l]),
      );
      return {
        data: page.listingIds.flatMap((id) => {
          const listing = byId.get(id);
          return listing ? [listing] : [];
        }),
        pagination: {
          page: page.page,
          limit: page.limit,
          total: page.total,
          pages: Math.max(1, Math.ceil(page.total / page.limit)),
          hasNextPage: page.hasNextPage,
          hasPreviousPage: page.page > 1,
        },
      };
    },
    enabled: enabled && !!handle,
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/** A spotlight shelf's listings, hydrated in the shelf's order. */
export function useStoreListingsByIds(handle: string, ids: readonly string[]) {
  return useQuery<Listing[]>({
    queryKey: queryKeys.stores.listingsByIds(handle, ids),
    queryFn: () => fetchStoreListingsByIds(handle, ids),
    enabled: !!handle && ids.length > 0,
    staleTime: STALE_TIME,
    retry: 1,
  });
}
