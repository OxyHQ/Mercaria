import type {
  ApiResponse,
  PaginatedResponse,
  Listing,
  CategoryNode,
  ProductVariantDTO,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

/** Query parameters accepted by the catalog browse (`GET /listings`). */
export interface CatalogParams {
  /** The store whose catalog to ring up against. */
  storeId: string;
  /** Full-text search term (matches title/sku/barcode server-side). */
  q?: string;
  /** Restrict to a single category slug. */
  category?: string;
  /** Restrict to listings with available stock. */
  inStock?: boolean;
}

/** A resolved code lookup: the listing and the matching variant for a SKU/barcode. */
export interface CodeMatch {
  listing: Listing;
  variant: ProductVariantDTO;
}

/**
 * GET /listings — the store's catalog page for the register grid. `/listings` is
 * PUBLIC (optionalAuth); the bearer token is attached by the interceptor but is
 * harmless. The offset path returns the canonical `PaginatedResponse<Listing>`.
 */
export async function fetchCatalog(
  params: CatalogParams,
): Promise<PaginatedResponse<Listing>> {
  const query: Record<string, string | boolean> = { storeId: params.storeId };
  if (params.q) query.q = params.q;
  if (params.category) query.category = params.category;
  if (params.inStock !== undefined) query.inStock = params.inStock;

  const { data } = await apiClient.get<PaginatedResponse<Listing>>("/listings", {
    params: query,
  });
  return data;
}

/** GET /listings/:id — the full hydrated listing. */
export async function fetchListing(id: string): Promise<Listing> {
  const { data } = await apiClient.get<ApiResponse<Listing>>(`/listings/${id}`);
  return unwrap(data);
}

/** GET /categories — the category taxonomy tree. */
export async function fetchCategories(): Promise<CategoryNode[]> {
  const { data } = await apiClient.get<ApiResponse<CategoryNode[]>>("/categories");
  return unwrap(data);
}

/**
 * Resolve a scanned/typed SKU or barcode to a listing + variant. Searches the
 * store's catalog with the code as the `q` term (the backend search matches
 * sku/barcode/title), then returns the FIRST listing whose variant has an EXACT
 * `sku` or `barcode` match. Returns `null` when no exact match exists.
 */
export async function lookupByCode(
  storeId: string,
  code: string,
): Promise<CodeMatch | null> {
  const trimmed = code.trim();
  if (trimmed === "") return null;

  const { data } = await fetchCatalog({ storeId, q: trimmed });
  for (const listing of data) {
    const variant = listing.variants.find(
      (v) => v.sku === trimmed || v.barcode === trimmed,
    );
    if (variant) {
      return { listing, variant };
    }
  }
  return null;
}
