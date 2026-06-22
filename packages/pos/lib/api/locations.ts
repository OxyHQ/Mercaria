import type { ApiResponse, Location } from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

/** GET /admin/stores/:storeId/locations — the store's stock locations. */
export async function fetchLocations(storeId: string): Promise<Location[]> {
  const { data } = await apiClient.get<ApiResponse<Location[]>>(
    `/admin/stores/${storeId}/locations`,
  );
  return unwrap(data);
}
