import type {
  ApiResponse,
  Location,
  CreateLocationInput,
  UpdateLocationInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/locations`;

/** GET the store's locations. */
export async function fetchLocations(storeId: string): Promise<Location[]> {
  const { data } = await apiClient.get<ApiResponse<Location[]>>(base(storeId));
  return unwrap(data);
}

/** POST a new location. */
export async function createLocation(
  storeId: string,
  input: CreateLocationInput,
): Promise<Location> {
  const { data } = await apiClient.post<ApiResponse<Location>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a location. */
export async function updateLocation(
  storeId: string,
  id: string,
  input: UpdateLocationInput,
): Promise<Location> {
  const { data } = await apiClient.patch<ApiResponse<Location>>(`${base(storeId)}/${id}`, input);
  return unwrap(data);
}

/** DELETE a location. */
export async function deleteLocation(
  storeId: string,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}
