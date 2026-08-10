import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  MerchantCatalogPage,
  MerchantOfferPage,
  MerchantPage,
} from "@mercaria/shared-types";
import {
  fetchMerchantCatalog,
  fetchMerchantOffers,
  fetchMerchantPage,
  type MerchantBrowseParams,
} from "../api/merchants";
import { queryKeys } from "./query-keys";

/** Two minutes — a merchant's identity is stable within a browsing session. */
const STALE_TIME = 1000 * 60 * 2;

/**
 * A merchant's page.
 *
 * A 404 is a legitimate outcome and NOT retried past the first attempt: the
 * server answers a suppressed merchant and one that never existed identically,
 * so retrying cannot turn either into a page and only delays the empty state.
 */
export function useMerchantPage(idOrSlug: string | undefined) {
  return useQuery<MerchantPage>({
    queryKey: queryKeys.merchants.page(idOrSlug ?? ""),
    queryFn: () => fetchMerchantPage(idOrSlug ?? ""),
    enabled: Boolean(idOrSlug),
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/**
 * A merchant's deduplicated catalogue, paged by KEYSET.
 *
 * The browse parameters are part of the query KEY, which is what makes changing
 * a channel or a market a new list rather than a filtered view of the old one —
 * the cursor of one scope is meaningless in another and the server refuses to
 * apply it across a change of scope.
 */
export function useMerchantCatalog(
  idOrSlug: string | undefined,
  params: MerchantBrowseParams,
  enabled = true,
) {
  return useInfiniteQuery<
    MerchantCatalogPage,
    Error,
    MerchantCatalogPage[],
    readonly unknown[],
    string | undefined
  >({
    queryKey: queryKeys.merchants.catalog(idOrSlug ?? "", params),
    enabled: Boolean(idOrSlug) && enabled,
    staleTime: STALE_TIME,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      fetchMerchantCatalog(idOrSlug ?? "", {
        ...params,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages,
  });
}

/** The OFFER-level view of the same scope — one row per offer, not per product. */
export function useMerchantOffers(
  idOrSlug: string | undefined,
  params: MerchantBrowseParams,
  enabled = true,
) {
  return useInfiniteQuery<
    MerchantOfferPage,
    Error,
    MerchantOfferPage[],
    readonly unknown[],
    string | undefined
  >({
    queryKey: queryKeys.merchants.offers(idOrSlug ?? "", params),
    enabled: Boolean(idOrSlug) && enabled,
    staleTime: STALE_TIME,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      fetchMerchantOffers(idOrSlug ?? "", {
        ...params,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages,
  });
}
