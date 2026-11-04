import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@oxy.so/bloom/hooks';
import type { PlacePickerStatus } from '@oxy.so/bloom/place-picker';
import { placeOptionFromResult, type GoWayPlaceOption } from '@/lib/address/goway-address';
import { goWayClient } from '@/lib/goway-client';
import { useTranslation } from '@/lib/i18n';
import { queryKeys } from './query-keys';

/** Characters typed before GoWay is asked; the Bloom picker's own default. */
export const PLACE_SEARCH_MIN_LENGTH = 3;
const PLACE_SEARCH_DEBOUNCE_MS = 300;
const PLACE_SEARCH_LIMIT = 6;

/**
 * Search-as-you-type over GoWay's forward geocoder, shaped for Bloom's
 * `PlacePicker`: options, a status and a retry. Public and signed out, like
 * GoWay's own map. The request is keyed on the DEBOUNCED term, and while the
 * typed text runs ahead of it the picker is told `loading` with no results, so
 * an answer for "Gran" never shows under "Gran Vía".
 */
export function usePlaceSearch(query: string): {
  results: GoWayPlaceOption[];
  status: PlacePickerStatus;
  retry: () => void;
} {
  const { locale } = useTranslation();
  const typed = query.trim();
  const term = useDebouncedValue(typed, PLACE_SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    queryKey: queryKeys.placeSearch(term, locale),
    queryFn: ({ signal }) =>
      goWayClient.geocode.forward({ query: term, locale, limit: PLACE_SEARCH_LIMIT }, { signal }),
    enabled: term.length >= PLACE_SEARCH_MIN_LENGTH,
    gcTime: 0,
    retry: false,
  });
  const current = term === typed;
  const results = useMemo(
    () => (current && search.data ? search.data.items.map(placeOptionFromResult) : []),
    [current, search.data],
  );
  const status: PlacePickerStatus =
    !current || search.isFetching ? 'loading' : search.isError ? 'error' : 'ready';
  return { results, status, retry: () => void search.refetch() };
}
