import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  Listing,
  CategoryNode,
} from "@mercaria/shared-types";
import { fetchCatalog, fetchCategories } from "../api/catalog";
import { queryKeys } from "../queryKeys";

/** Filters applied to the register catalog grid. */
export interface CatalogFilters {
  /** Full-text search term. */
  q: string;
  /** Selected category slug (empty string = all). */
  category: string;
  /** Whether to restrict to in-stock listings. */
  inStock: boolean;
}

/** The store's catalog page, scoped + filtered for the register grid. */
export function useCatalog(storeId: string, filters: CatalogFilters) {
  return useQuery<PaginatedResponse<Listing>>({
    queryKey: queryKeys.catalog.list(
      storeId,
      filters.q,
      filters.category,
      filters.inStock,
    ),
    queryFn: () =>
      fetchCatalog({
        storeId,
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        inStock: filters.inStock,
      }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** The category taxonomy tree (for the register category filter). */
export function useCategories() {
  return useQuery<CategoryNode[]>({
    queryKey: queryKeys.categories,
    queryFn: fetchCategories,
  });
}
