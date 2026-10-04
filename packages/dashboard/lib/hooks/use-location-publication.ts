import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LocationPlaceLink,
  LocationPublicationState,
  MerchantLocationPublication,
  SetLocationPickupPauseInput,
  UpsertLocationPublicationInput,
} from "@mercaria/shared-types";
import {
  fetchLocationPublication,
  saveLocationPublication,
  setLocationPickupPause,
  setLocationPublicationState,
  verifyLocationPlaceLink,
} from "../api/locations";
import { queryKeys } from "../queryKeys";

/** One location's publication; `null` when it has none yet. */
export function useLocationPublication(storeId: string, locationId: string) {
  return useQuery<MerchantLocationPublication | null>({
    queryKey: queryKeys.locationPublication(storeId, locationId),
    queryFn: () => fetchLocationPublication(storeId, locationId),
    enabled: Boolean(storeId) && Boolean(locationId),
  });
}

/**
 * The trust rule's verdict on the location's GoWay place, checked against GoWay
 * NOW (ADR 0013).
 *
 * A query over a POST, deliberately: the check is what the screen shows, it is
 * safe to repeat, and its only write — following a place GoWay merged — is one
 * every repetition makes identically. `staleTime: 0` because the merchant edits
 * the place in GoWay from this same screen and asks again.
 */
export function useLocationPlaceLink(storeId: string, locationId: string, enabled: boolean) {
  return useQuery<LocationPlaceLink>({
    queryKey: queryKeys.locationPlaceLink(storeId, locationId),
    queryFn: () => verifyLocationPlaceLink(storeId, locationId),
    enabled: Boolean(storeId) && Boolean(locationId) && enabled,
    staleTime: 0,
    retry: false,
  });
}

/** Everything a publication write can change: the publication, the link verdict and the location's place id. */
function useInvalidatePublication(storeId: string, locationId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.locationPublication(storeId, locationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.locationPlaceLink(storeId, locationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.locations(storeId), exact: true });
  };
}

/** Save the GoWay place and the commerce fields. */
export function useSaveLocationPublication(storeId: string, locationId: string) {
  const invalidate = useInvalidatePublication(storeId, locationId);
  return useMutation({
    mutationFn: (input: UpsertLocationPublicationInput) => saveLocationPublication(storeId, locationId, input),
    onSuccess: invalidate,
  });
}

/** Publish, withdraw or return to draft. */
export function useSetLocationPublicationState(storeId: string, locationId: string) {
  const invalidate = useInvalidatePublication(storeId, locationId);
  return useMutation({
    mutationFn: (state: LocationPublicationState) => setLocationPublicationState(storeId, locationId, state),
    // A refused publish is as worth re-reading as a success: the verdict that
    // refused it is what the screen shows next.
    onSettled: invalidate,
  });
}

/** Pause or resume collection at this location. */
export function useSetLocationPickupPause(storeId: string, locationId: string) {
  const invalidate = useInvalidatePublication(storeId, locationId);
  return useMutation({
    mutationFn: (input: SetLocationPickupPauseInput) => setLocationPickupPause(storeId, locationId, input),
    onSuccess: invalidate,
  });
}
