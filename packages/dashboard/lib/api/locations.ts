import type {
  ApiResponse,
  Location,
  CreateLocationInput,
  LocationPlaceLink,
  LocationPublicationState,
  MerchantLocationPublication,
  SetLocationPickupPauseInput,
  UpdateLocationInput,
  UpsertLocationPublicationInput,
} from "@mercaria/shared-types";
import axios from "axios";
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

// --- Publication: the commerce half of a location (#93, ADR 0013) -----------
//
// Where the location IS — its name, address, hours — is its GoWay place, which
// the editor reads and writes in GoWay directly. What Mercaria stores is which
// place, plus whether and on what terms the location offers collection.

/** GET one location's publication, or `null` when it has none yet (the server's 404). */
export async function fetchLocationPublication(
  storeId: string,
  locationId: string,
): Promise<MerchantLocationPublication | null> {
  try {
    const { data } = await apiClient.get<ApiResponse<{ publication: MerchantLocationPublication }>>(
      `${base(storeId)}/${locationId}/publication`,
    );
    return unwrap(data).publication;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
}

/** PUT the GoWay place and the commerce fields. The server checks the place exists in GoWay. */
export async function saveLocationPublication(
  storeId: string,
  locationId: string,
  input: UpsertLocationPublicationInput,
): Promise<MerchantLocationPublication> {
  const { data } = await apiClient.put<ApiResponse<{ publication: MerchantLocationPublication }>>(
    `${base(storeId)}/${locationId}/publication`,
    input,
  );
  return unwrap(data).publication;
}

/** POST a state change. Publishing runs the trust rule first and refuses a location it refuses. */
export async function setLocationPublicationState(
  storeId: string,
  locationId: string,
  state: LocationPublicationState,
): Promise<MerchantLocationPublication> {
  const { data } = await apiClient.post<ApiResponse<{ publication: MerchantLocationPublication }>>(
    `${base(storeId)}/${locationId}/publication/state`,
    { state },
  );
  return unwrap(data).publication;
}

/** POST a collection pause or resume at one location. */
export async function setLocationPickupPause(
  storeId: string,
  locationId: string,
  input: SetLocationPickupPauseInput,
): Promise<MerchantLocationPublication> {
  const { data } = await apiClient.post<ApiResponse<{ publication: MerchantLocationPublication }>>(
    `${base(storeId)}/${locationId}/publication/pickup-pause`,
    input,
  );
  return unwrap(data).publication;
}

/**
 * POST the place-link check: the trust rule, now, with what is missing. A POST
 * because the server may re-point the location at a place GoWay merged.
 */
export async function verifyLocationPlaceLink(
  storeId: string,
  locationId: string,
): Promise<LocationPlaceLink> {
  const { data } = await apiClient.post<ApiResponse<{ link: LocationPlaceLink }>>(
    `${base(storeId)}/${locationId}/place-link/verify`,
  );
  return unwrap(data).link;
}
