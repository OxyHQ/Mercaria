import type {
  ApiResponse,
  Store,
  CreateStoreInput,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

/** GET /admin/stores — the caller's stores (every store they're a member of). */
export async function fetchMyStores(): Promise<Store[]> {
  const { data } = await apiClient.get<ApiResponse<Store[]>>("/admin/stores");
  return unwrap(data);
}

/** GET /admin/stores/:storeId — a single store the caller belongs to. */
export async function fetchStore(storeId: string): Promise<Store> {
  const { data } = await apiClient.get<ApiResponse<Store>>(`/admin/stores/${storeId}`);
  return unwrap(data);
}

/** POST /admin/stores — create a store; the caller becomes its owner. */
export async function createStore(input: CreateStoreInput): Promise<Store> {
  const { data } = await apiClient.post<ApiResponse<Store>>("/admin/stores", input);
  return unwrap(data);
}

/** PATCH /admin/stores/:storeId — update the store's core profile. */
export async function updateStore(storeId: string, input: UpdateStoreInput): Promise<Store> {
  const { data } = await apiClient.patch<ApiResponse<Store>>(`/admin/stores/${storeId}`, input);
  return unwrap(data);
}

/** PATCH /admin/stores/:storeId/settings — policies / notifications / tax. */
export async function updateStoreSettings(
  storeId: string,
  input: UpdateStoreSettingsInput,
): Promise<Store> {
  const { data } = await apiClient.patch<ApiResponse<Store>>(
    `/admin/stores/${storeId}/settings`,
    input,
  );
  return unwrap(data);
}
