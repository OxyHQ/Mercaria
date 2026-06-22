import type {
  ApiResponse,
  Collection,
  CreateCollectionInput,
  UpdateCollectionInput,
  SetCollectionProductsInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/collections`;

/** GET the store's collections. */
export async function fetchCollections(storeId: string): Promise<Collection[]> {
  const { data } = await apiClient.get<ApiResponse<Collection[]>>(base(storeId));
  return unwrap(data);
}

/** GET a single collection. */
export async function fetchCollection(storeId: string, id: string): Promise<Collection> {
  const { data } = await apiClient.get<ApiResponse<Collection>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}

/** POST a new collection (manual or automated). */
export async function createCollection(
  storeId: string,
  input: CreateCollectionInput,
): Promise<Collection> {
  const { data } = await apiClient.post<ApiResponse<Collection>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a collection. */
export async function updateCollection(
  storeId: string,
  id: string,
  input: UpdateCollectionInput,
): Promise<Collection> {
  const { data } = await apiClient.patch<ApiResponse<Collection>>(`${base(storeId)}/${id}`, input);
  return unwrap(data);
}

/** DELETE a collection. */
export async function deleteCollection(
  storeId: string,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}

/** POST the full ordered product list for a manual collection. */
export async function setCollectionProducts(
  storeId: string,
  id: string,
  input: SetCollectionProductsInput,
): Promise<Collection> {
  const { data } = await apiClient.post<ApiResponse<Collection>>(
    `${base(storeId)}/${id}/products`,
    input,
  );
  return unwrap(data);
}
