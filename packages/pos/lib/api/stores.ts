import type { ApiResponse, Store } from "@mercaria/shared-types";
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
