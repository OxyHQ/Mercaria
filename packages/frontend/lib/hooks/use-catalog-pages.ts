import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import type {
  BrandPage,
  CatalogCorrectionField,
  CatalogCorrectionReceipt,
  CatalogCorrectionSubject,
  CatalogProductBrowsePage,
  ProductFamilyPage,
} from '@mercaria/shared-types';
import {
  fetchBrandPage,
  fetchBrandProducts,
  fetchProductFamilyPage,
  fetchProductFamilyProducts,
  submitCatalogCorrection,
  type CatalogBrowseParams,
} from '../api/catalog-pages';
import { queryKeys } from './query-keys';

/** Two minutes — catalogue identity is stable within a browsing session. */
const STALE_TIME = 1000 * 60 * 2;

/** How many products one page of a grid carries. */
const BROWSE_PAGE_SIZE = 24;

/**
 * A brand page.
 *
 * A 404 is a legitimate outcome and is NOT retried past the first attempt: an
 * unknown handle, an ambiguous alias and a deleted brand all answer the same
 * way, and retrying cannot turn any of them into a page.
 */
export function useBrandPage(handle: string | undefined, market?: string) {
  return useQuery<BrandPage>({
    queryKey: queryKeys.catalogPages.brand(handle ?? '', market ?? ''),
    queryFn: () => fetchBrandPage(handle ?? '', market),
    enabled: Boolean(handle),
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/**
 * A brand's products, paged by KEYSET.
 *
 * The server's own opaque cursor, never a page number: a catalogue changes
 * while somebody is scrolling, and an offset silently skips or repeats rows
 * exactly when it does. `getNextPageParam` returning `undefined` is what stops
 * the list — a count the client kept in step would be a second answer to how
 * long the list is.
 */
export function useBrandProducts(handle: string | undefined, params?: CatalogBrowseParams) {
  return useInfiniteQuery<
    CatalogProductBrowsePage,
    Error,
    CatalogProductBrowsePage[],
    readonly unknown[],
    string | undefined
  >({
    queryKey: queryKeys.catalogPages.brandProducts(handle ?? '', JSON.stringify(params ?? {})),
    enabled: Boolean(handle),
    staleTime: STALE_TIME,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      fetchBrandProducts(handle ?? '', {
        ...params,
        limit: BROWSE_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages,
  });
}

/** A product-family page. */
export function useProductFamilyPage(
  handle: string | undefined,
  params?: { market?: string; currency?: string },
) {
  return useQuery<ProductFamilyPage>({
    queryKey: queryKeys.catalogPages.family(handle ?? '', JSON.stringify(params ?? {})),
    queryFn: () => fetchProductFamilyPage(handle ?? '', params),
    enabled: Boolean(handle),
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/** A family's generations, paged by KEYSET. */
export function useProductFamilyProducts(
  handle: string | undefined,
  params?: CatalogBrowseParams,
) {
  return useInfiniteQuery<
    CatalogProductBrowsePage,
    Error,
    CatalogProductBrowsePage[],
    readonly unknown[],
    string | undefined
  >({
    queryKey: queryKeys.catalogPages.familyProducts(handle ?? '', JSON.stringify(params ?? {})),
    enabled: Boolean(handle),
    staleTime: STALE_TIME,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      fetchProductFamilyProducts(handle ?? '', {
        ...params,
        limit: BROWSE_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages,
  });
}

/**
 * File a correction against a published fact.
 *
 * Deliberately invalidates NOTHING. A correction changes no page — it opens a
 * queue item for a person — and refetching the page afterwards would suggest
 * to the submitter that something might have changed.
 */
export function useCatalogCorrection() {
  return useMutation<
    CatalogCorrectionReceipt,
    Error,
    { subject: CatalogCorrectionSubject; handle: string; field: CatalogCorrectionField }
  >({
    mutationFn: submitCatalogCorrection,
  });
}
