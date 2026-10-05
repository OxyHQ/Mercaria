import type {
  ApiResponse,
  SetStorePermissionOverrideInput,
  StorePermissionOverride,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/permission-overrides`;

/** GET every per-person exception to the role map on this store. */
export async function fetchPermissionOverrides(
  storeId: string,
): Promise<StorePermissionOverride[]> {
  const { data } = await apiClient.get<ApiResponse<StorePermissionOverride[]>>(base(storeId));
  return unwrap(data);
}

/**
 * PUT one person's exception, replacing what it said. Two empty sets remove it,
 * and the server answers `null`.
 */
export async function setPermissionOverride(
  storeId: string,
  oxyUserId: string,
  input: SetStorePermissionOverrideInput,
): Promise<StorePermissionOverride | null> {
  const { data } = await apiClient.put<ApiResponse<StorePermissionOverride | null>>(
    `${base(storeId)}/${oxyUserId}`,
    input,
  );
  if (!data.success) {
    throw new Error(data.message ?? data.error ?? "Request failed");
  }
  return data.data ?? null;
}
