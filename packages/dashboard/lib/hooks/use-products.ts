import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  Listing,
  InventoryLevelDTO,
  CreateStoreProductInput,
  UpdateListingInput,
  CreateStoreProductVariantInput,
} from "@mercaria/shared-types";
import {
  fetchProducts,
  fetchProduct,
  createProduct,
  updateProduct,
  archiveProduct,
  releaseProductPins,
  createVariant,
  updateVariant,
  deleteVariant,
  setVariantInventory,
  fetchVariantLevels,
  setVariantLevelInventory,
  type UpdateVariantInput,
} from "../api/products";
import { queryKeys } from "../queryKeys";

const PAGE_LIMIT = 20;

/** Paginated product list for a store (search filtered client-side on title). */
export function useProducts(storeId: string, page: number, search: string) {
  return useQuery<PaginatedResponse<Listing>>({
    queryKey: queryKeys.products.list(storeId, page, search),
    queryFn: () => fetchProducts(storeId, { page, limit: PAGE_LIMIT }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** A single product. */
export function useProduct(storeId: string, productId: string) {
  return useQuery<Listing>({
    queryKey: queryKeys.products.detail(storeId, productId),
    queryFn: () => fetchProduct(storeId, productId),
    enabled: Boolean(storeId) && Boolean(productId),
  });
}

/** Multi-location inventory levels for a variant. */
export function useVariantLevels(storeId: string, productId: string, variantId: string) {
  return useQuery<InventoryLevelDTO[]>({
    queryKey: queryKeys.products.levels(storeId, productId, variantId),
    queryFn: () => fetchVariantLevels(storeId, productId, variantId),
    enabled: Boolean(storeId) && Boolean(productId) && Boolean(variantId),
  });
}

/** Invalidate every cached query for a store's products. */
function invalidateProducts(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
) {
  queryClient.invalidateQueries({ queryKey: ["stores", storeId, "products"] });
}

/** Create a product. */
export function useCreateProduct(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStoreProductInput) => createProduct(storeId, input),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Update a product. */
export function useUpdateProduct(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateListingInput) => updateProduct(storeId, productId, input),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Archive (soft-delete) a product. */
export function useArchiveProduct(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) => archiveProduct(storeId, productId),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/**
 * Release some of a connector-sourced product's pinned fields (#427).
 *
 * Idempotent on the server — a key that is no longer held is removed from
 * nothing — so a double tap, a retry and a second dashboard all converge, and
 * this needs no optimistic state to protect. The invalidation is the shared one,
 * because the pin set rides on the product itself.
 */
export function useReleaseProductPins(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fields: string[]) => releaseProductPins(storeId, productId, fields),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Add a variant to a product. */
export function useCreateVariant(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStoreProductVariantInput) =>
      createVariant(storeId, productId, input),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Update a variant. */
export function useUpdateVariant(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ variantId, input }: { variantId: string; input: UpdateVariantInput }) =>
      updateVariant(storeId, productId, variantId, input),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Remove a variant. */
export function useDeleteVariant(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variantId: string) => deleteVariant(storeId, productId, variantId),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Set a variant's available count at the default location. */
export function useSetVariantInventory(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ variantId, available }: { variantId: string; available: number }) =>
      setVariantInventory(storeId, productId, variantId, available),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Set a variant's available count at a specific location. */
export function useSetVariantLevelInventory(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      variantId,
      locationId,
      available,
    }: {
      variantId: string;
      locationId: string;
      available: number;
    }) => setVariantLevelInventory(storeId, productId, variantId, locationId, available),
    onSuccess: (_data, variables) => {
      invalidateProducts(queryClient, storeId);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.levels(storeId, productId, variables.variantId),
      });
    },
  });
}
