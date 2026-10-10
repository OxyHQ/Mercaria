import { useQuery } from '@tanstack/react-query';
import type { MercariaLocation } from '@mercaria/contracts';
import type { Place, PlaceMedia } from '@goway.to/sdk';
import { fetchStoreLocations } from '../api/public-locations';
import { goWayClient } from '../goway-client';
import { VISIT_PHOTO_KINDS, VISIT_PHOTO_LIMIT } from '../visit-us';
import { queryKeys } from './query-keys';

/** Five minutes: shop fronts and their places change on a merchant's schedule, not a shopper's. */
const STALE_TIME = 1000 * 60 * 5;

/** A store's public shop fronts (`/public/v1`). */
export function useStoreLocations(storeId: string) {
  return useQuery<MercariaLocation[]>({
    queryKey: queryKeys.visitUs.locations(storeId),
    queryFn: () => fetchStoreLocations(storeId),
    enabled: storeId !== '',
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/**
 * One shop front's GoWay place, its name resolved in the shopper's language.
 * A public GoWay read: no Oxy session is sent, so it works signed out.
 */
export function useGoWayPlace(placeId: string, locale: string) {
  return useQuery<Place>({
    queryKey: queryKeys.visitUs.place(placeId, locale),
    queryFn: () => goWayClient.places.get(placeId, { locale }),
    staleTime: STALE_TIME,
    retry: 1,
  });
}

/** The photos of one shop front's place, in the business's order. */
export function useGoWayPlacePhotos(placeId: string) {
  return useQuery<PlaceMedia[]>({
    queryKey: queryKeys.visitUs.photos(placeId),
    queryFn: async () =>
      (
        await goWayClient.places.media.list(placeId, {
          kinds: [...VISIT_PHOTO_KINDS],
          limit: VISIT_PHOTO_LIMIT,
        })
      ).items,
    staleTime: STALE_TIME,
    retry: 1,
  });
}
