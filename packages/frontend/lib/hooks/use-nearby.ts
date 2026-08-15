/**
 * React Query hooks for nearby discovery (#93).
 *
 * ## Location permission is asked for ONLY when somebody invokes discovery
 *
 * #93 location-input rule 1 and client rule 1. `useNearbyOrigin` asks for
 * nothing on mount: it exposes `requestDeviceOrigin`, which a control calls,
 * and until then the origin is `null` and the nearby query is DISABLED. There
 * is no watcher, no subscription and no background read anywhere in this
 * module — rule 3's "do not use background location tracking" is the absence of
 * a `watchPosition` call rather than a setting.
 *
 * ## The coordinate is request-local and is never persisted
 *
 * It lives in component state for as long as the screen is open. Nothing writes
 * it to storage, to a guest session or to an analytics call — #93 privacy rules
 * 4, 5 and 6 — and the module imports no store and no analytics client at all.
 *
 * ## The manual fallback is a first-class path, not a degraded one
 *
 * `useNearbyPlaces` answers with the cities that actually hold the item, so a
 * shopper who declines the prompt gets a real list rather than an empty state
 * with an apology (#93 acceptance 5). It is also the ONLY path on native today —
 * see {@link requestDeviceOrigin}.
 */

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ItemConditionKey, NearbyPlaceSuggestion, NearbyResponse } from '@mercaria/shared-types';
import {
  fetchNearby,
  fetchNearbyPlaces,
  placeOrigin,
  type NearbyOrigin,
} from '../api/nearby';
import { queryKeys } from './query-keys';

/** Why a device position could not be obtained. Never shown as an error. */
export type NearbyOriginRefusal =
  /** The person said no. The manual picker is the remedy and is offered. */
  | 'permission_denied'
  /**
   * This build has no way to ask.
   *
   * The native apps carry no location dependency today, deliberately: adding
   * one is a config-plugin change plus a store-listing permission disclosure,
   * and the manual place picker is a complete path without it. Stated here
   * rather than hidden behind a generic failure, so a client renders "choose a
   * city" rather than "something went wrong".
   */
  | 'unsupported'
  /** The device tried and could not fix a position. */
  | 'unavailable';

/** The origin a screen is currently searching from, and how to get one. */
export interface NearbyOriginState {
  readonly origin: NearbyOrigin | null;
  readonly refusal: NearbyOriginRefusal | null;
  readonly requesting: boolean;
  /** Ask the device. Called from a control, never on mount. */
  readonly requestDeviceOrigin: () => void;
  /** Adopt a city the shopper picked — the manual fallback. */
  readonly selectPlace: (place: NearbyPlaceSuggestion) => void;
  /** Forget the position. A shopper who shared one can take it back. */
  readonly clearOrigin: () => void;
}

/**
 * Hold one screen's search origin.
 *
 * `navigator.geolocation` is read through a guarded lookup rather than assumed:
 * it exists on web and is absent in the native runtime, which is exactly the
 * `unsupported` branch above. No polyfill is installed and none should be — a
 * shim that silently answered would be a location feature nobody disclosed.
 */
export function useNearbyOrigin(): NearbyOriginState {
  const [origin, setOrigin] = useState<NearbyOrigin | null>(null);
  const [refusal, setRefusal] = useState<NearbyOriginRefusal | null>(null);
  const [requesting, setRequesting] = useState(false);

  const requestDeviceOrigin = useCallback(() => {
    const geolocation =
      typeof navigator === 'undefined' ? undefined : navigator.geolocation;
    if (!geolocation) {
      setRefusal('unsupported');
      return;
    }
    setRequesting(true);
    setRefusal(null);
    geolocation.getCurrentPosition(
      (position) => {
        setOrigin({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          source: 'device',
        });
        setRequesting(false);
      },
      (error) => {
        // `PERMISSION_DENIED` is 1 in the W3C API. Anything else is the device
        // failing to fix a position, which is a different message to show.
        setRefusal(error.code === 1 ? 'permission_denied' : 'unavailable');
        setRequesting(false);
      },
      // No `watchPosition`, no high accuracy and a short timeout: this is one
      // question asked once, and a long wait on a shopping screen reads as a
      // hang.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

  const selectPlace = useCallback((place: NearbyPlaceSuggestion) => {
    setOrigin(placeOrigin(place));
    setRefusal(null);
  }, []);

  const clearOrigin = useCallback(() => {
    setOrigin(null);
    setRefusal(null);
  }, []);

  return { origin, refusal, requesting, requestDeviceOrigin, selectPlace, clearOrigin };
}

/** One page of collectable locations. Disabled until an origin exists. */
export function useNearbyAvailability(params: {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  origin: NearbyOrigin | null;
  conditionKeys?: readonly ItemConditionKey[];
  withCheckoutEligibility?: boolean;
  enabled?: boolean;
}) {
  const { origin } = params;
  const subject = params.canonicalVariantId ?? params.canonicalProductId ?? '';
  return useQuery<NearbyResponse>({
    // The COARSE cell is the cache key, not the coordinate: two searches from
    // opposite ends of one district share an answer, and a cache entry cannot
    // record where somebody was standing.
    queryKey: queryKeys.nearby.availability(
      subject,
      origin === null ? null : cellKey(origin),
    ),
    queryFn: () =>
      fetchNearby({
        ...(params.canonicalVariantId ? { canonicalVariantId: params.canonicalVariantId } : {}),
        ...(params.canonicalProductId ? { canonicalProductId: params.canonicalProductId } : {}),
        // Non-null inside `queryFn`: `enabled` below is what guarantees it.
        origin: origin as NearbyOrigin,
        ...(params.conditionKeys ? { conditionKeys: params.conditionKeys } : {}),
        ...(params.withCheckoutEligibility
          ? { withCheckoutEligibility: params.withCheckoutEligibility }
          : {}),
      }),
    enabled: (params.enabled ?? true) && origin !== null && subject !== '',
    // Short, because the answer includes a stock level. A stale "available
    // nearby" is the one thing this surface must not show for long.
    staleTime: 30_000,
    retry: false,
  });
}

/** The manual fallback's suggestions. Runs with no origin, by design. */
export function useNearbyPlaces(params: {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  term?: string;
  enabled?: boolean;
}) {
  const subject = params.canonicalVariantId ?? params.canonicalProductId ?? '';
  return useQuery<readonly NearbyPlaceSuggestion[]>({
    queryKey: queryKeys.nearby.places(subject, params.term ?? ''),
    queryFn: () =>
      fetchNearbyPlaces({
        ...(params.canonicalVariantId ? { canonicalVariantId: params.canonicalVariantId } : {}),
        ...(params.canonicalProductId ? { canonicalProductId: params.canonicalProductId } : {}),
        ...(params.term ? { q: params.term } : {}),
      }),
    enabled: (params.enabled ?? true) && subject !== '',
    staleTime: 300_000,
    retry: false,
  });
}

/**
 * The 0.1° cell an origin falls in, as a cache key.
 *
 * The SAME arithmetic the server uses (`toLocalArea`), duplicated here rather
 * than round-tripped because a cache key is needed before the request is made.
 * It is a key and never a value: nothing renders it, and the server re-derives
 * its own from the coordinate it actually received.
 */
function cellKey(origin: NearbyOrigin): string {
  const precision = 0.1;
  return `${Math.floor(origin.latitude / precision)}:${Math.floor(origin.longitude / precision)}`;
}
