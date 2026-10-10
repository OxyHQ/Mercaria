import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { resolveVariantImages } from "@mercaria/shared-types";
import type {
  PaginatedResponse,
  Listing,
  ListingStatus,
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
  fetchVariantImages,
  replaceVariantImages,
  fetchVariantLevels,
  setVariantLevelInventory,
  type UpdateVariantInput,
} from "../api/products";
import { queryKeys } from "../queryKeys";

const PAGE_LIMIT = 20;

/** Paginated product list for a store (search and status filtered before pagination). */
export function useProducts(storeId: string, page: number, search: string, status: ListingStatus | "all" = "all") {
  return useQuery<PaginatedResponse<Listing>>({
    queryKey: queryKeys.products.list(storeId, page, search, status),
    queryFn: () => fetchProducts(storeId, { page, limit: PAGE_LIMIT, ...(search ? { search } : {}), ...(status !== "all" ? { status } : {}) }),
    enabled: Boolean(storeId),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === storeId &&
      (query.queryKey[3] as { search?: string; status?: string })?.search === search &&
      (query.queryKey[3] as { status?: string })?.status === status ? previous : undefined,
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
export function useVariantLevels(storeId: string, productId: string, variantId: string, enabled = true) {
  return useQuery<InventoryLevelDTO[]>({
    queryKey: queryKeys.products.levels(storeId, productId, variantId),
    queryFn: () => fetchVariantLevels(storeId, productId, variantId),
    enabled: enabled && Boolean(storeId) && Boolean(productId) && Boolean(variantId),
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
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: (input: UpdateListingInput) => updateProduct(storeId, productId, input),
    onSuccess: (product) => {
      // Publish the saved DTO before refreshing. Editors may now release their
      // dirty fields without briefly displaying the pre-save server values.
      queryClient.setQueryData(queryKeys.products.detail(storeId, productId), product);
      invalidateProducts(queryClient, storeId);
    },
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
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: (fields: string[]) => releaseProductPins(storeId, productId, fields),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Add a variant to a product. */
export function useCreateVariant(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: (input: CreateStoreProductVariantInput) =>
      createVariant(storeId, productId, input),
    onSuccess: (product) => {
      queryClient.setQueryData(queryKeys.products.detail(storeId, productId), product);
      invalidateProducts(queryClient, storeId);
    },
  });
}

/** Update a variant. */
export function useUpdateVariant(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: ({ variantId, input }: { variantId: string; input: UpdateVariantInput }) =>
      updateVariant(storeId, productId, variantId, input),
    onSuccess: (product) => {
      queryClient.setQueryData(queryKeys.products.detail(storeId, productId), product);
      invalidateProducts(queryClient, storeId);
    },
  });
}

/** Remove a variant. */
export function useDeleteVariant(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: (variantId: string) => deleteVariant(storeId, productId, variantId),
    onSuccess: (product) => {
      queryClient.setQueryData(queryKeys.products.detail(storeId, productId), product);
      invalidateProducts(queryClient, storeId);
    },
  });
}

/** Set a variant's available count at the default location. */
export function useSetVariantInventory(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: ({ variantId, available }: { variantId: string; available: number }) =>
      setVariantInventory(storeId, productId, variantId, available),
    onSuccess: () => invalidateProducts(queryClient, storeId),
  });
}

/** Set a variant's available count at a specific location. */
export function useSetVariantLevelInventory(storeId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: ({
      variantId,
      locationId,
      available,
    }: {
      variantId: string;
      locationId: string;
      available: number;
    }) => setVariantLevelInventory(storeId, productId, variantId, locationId, available),
    onSuccess: (levels, variables) => {
      queryClient.setQueryData(queryKeys.products.levels(storeId, productId, variables.variantId), levels);
      invalidateProducts(queryClient, storeId);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.levels(storeId, productId, variables.variantId),
      });
    },
  });
}

/** Reading the authoring selection needs products:write, just like its PUT. */
export function useVariantImages(storeId: string, productId: string, variantId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.products.images(storeId, productId, variantId),
    queryFn: () => fetchVariantImages(storeId, productId, variantId),
    enabled: Boolean(storeId && productId && variantId && enabled),
    staleTime: 0,
  });
}

export function useReplaceVariantImages(storeId: string, productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.products.write(storeId, productId),
    mutationFn: (fileIds: readonly string[]) => replaceVariantImages(storeId, productId, variantId, fileIds),
    onSuccess: async images => {
      // A focus refetch started before this PUT must not overwrite its result.
      await queryClient.cancelQueries({ queryKey: queryKeys.products.images(storeId, productId, variantId), exact: true });
      await queryClient.cancelQueries({ queryKey: queryKeys.products.detail(storeId, productId), exact: true });
      queryClient.setQueryData(queryKeys.products.images(storeId, productId, variantId), images);
      queryClient.setQueryData<Listing>(queryKeys.products.detail(storeId, productId), product => product ? {
        ...product,
        variants: product.variants.map(variant => variant.id === variantId ? {
          ...variant, images: resolveVariantImages(images, product.images),
        } : variant),
      } : product);
      invalidateProducts(queryClient, storeId);
    },
  });
}
