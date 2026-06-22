import type {
  ApiResponse,
  PaginatedResponse,
  Listing,
  Money,
  CreateStoreProductInput,
  UpdateListingInput,
  ProductVariantDTO,
  CreateStoreProductVariantInput,
  VariantOptionValue,
  InventoryLevelDTO,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

/** Partial variant payload accepted by `PATCH .../variants/:variantId`. */
export interface UpdateVariantInput {
  title?: string;
  sku?: string;
  barcode?: string;
  price?: Money;
  compareAtPrice?: Money | null;
  optionValues?: VariantOptionValue[];
  inventory?: { tracked?: boolean; available?: number };
}

const base = (storeId: string) => `/admin/stores/${storeId}/products`;

/** GET products — paginated store products. */
export async function fetchProducts(
  storeId: string,
  params: { page?: number; limit?: number } = {},
): Promise<PaginatedResponse<Listing>> {
  const { data } = await apiClient.get<PaginatedResponse<Listing>>(base(storeId), { params });
  return data;
}

/** GET a single product. */
export async function fetchProduct(storeId: string, id: string): Promise<Listing> {
  const { data } = await apiClient.get<ApiResponse<Listing>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}

/** POST a new product (options + variants builder). */
export async function createProduct(
  storeId: string,
  input: CreateStoreProductInput,
): Promise<Listing> {
  const { data } = await apiClient.post<ApiResponse<Listing>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a product (title/description/status/vendor/...). */
export async function updateProduct(
  storeId: string,
  id: string,
  input: UpdateListingInput,
): Promise<Listing> {
  const { data } = await apiClient.patch<ApiResponse<Listing>>(`${base(storeId)}/${id}`, input);
  return unwrap(data);
}

/** DELETE (archive) a product. */
export async function archiveProduct(
  storeId: string,
  id: string,
): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string; status: string }>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}

/** POST a new variant on a product. */
export async function createVariant(
  storeId: string,
  id: string,
  input: CreateStoreProductVariantInput,
): Promise<ProductVariantDTO> {
  const { data } = await apiClient.post<ApiResponse<ProductVariantDTO>>(
    `${base(storeId)}/${id}/variants`,
    input,
  );
  return unwrap(data);
}

/** PATCH an existing variant. */
export async function updateVariant(
  storeId: string,
  id: string,
  variantId: string,
  input: UpdateVariantInput,
): Promise<ProductVariantDTO> {
  const { data } = await apiClient.patch<ApiResponse<ProductVariantDTO>>(
    `${base(storeId)}/${id}/variants/${variantId}`,
    input,
  );
  return unwrap(data);
}

/** DELETE a variant. */
export async function deleteVariant(
  storeId: string,
  id: string,
  variantId: string,
): Promise<ProductVariantDTO> {
  const { data } = await apiClient.delete<ApiResponse<ProductVariantDTO>>(
    `${base(storeId)}/${id}/variants/${variantId}`,
  );
  return unwrap(data);
}

/** PATCH a variant's absolute available count at the default location. */
export async function setVariantInventory(
  storeId: string,
  id: string,
  variantId: string,
  available: number,
): Promise<ProductVariantDTO> {
  const { data } = await apiClient.patch<ApiResponse<ProductVariantDTO>>(
    `${base(storeId)}/${id}/variants/${variantId}/inventory`,
    { available },
  );
  return unwrap(data);
}

/** GET multi-location inventory levels for a variant. */
export async function fetchVariantLevels(
  storeId: string,
  id: string,
  variantId: string,
): Promise<InventoryLevelDTO[]> {
  const { data } = await apiClient.get<ApiResponse<InventoryLevelDTO[]>>(
    `${base(storeId)}/${id}/variants/${variantId}/levels`,
  );
  return unwrap(data);
}

/** PATCH a variant's available count at a specific location. */
export async function setVariantLevelInventory(
  storeId: string,
  id: string,
  variantId: string,
  locationId: string,
  available: number,
): Promise<InventoryLevelDTO[]> {
  const { data } = await apiClient.patch<ApiResponse<InventoryLevelDTO[]>>(
    `${base(storeId)}/${id}/variants/${variantId}/levels/${locationId}`,
    { available },
  );
  return unwrap(data);
}
