import { useQuery } from "@tanstack/react-query";
import type { Location } from "@mercaria/shared-types";
import { fetchLocations } from "../api/locations";
import { queryKeys } from "../queryKeys";

/** The store's stock locations (the register choices in store setup). */
export function useLocations(storeId: string) {
  return useQuery<Location[]>({
    queryKey: queryKeys.locations(storeId),
    queryFn: () => fetchLocations(storeId),
    enabled: Boolean(storeId),
  });
}
