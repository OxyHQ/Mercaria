import type {
  ApiResponse,
  ItemConditionKey,
  NearbyPlaceSuggestion,
  NearbyResponse,
  OrderPickup,
  PickupCollectionCode,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Nearby discovery and the collection code (#93).
 *
 * ## The shopper's coordinate goes into ONE request and nowhere else
 *
 * It is a query parameter on the call that needs it and is never persisted:
 * there is no store, no `AsyncStorage` key and no analytics call in this
 * module. #93 privacy rules 3 and 4 — no background tracking, and no precise
 * coordinate kept in a guest session. What the SERVER echoes back is the coarse
 * cell it reduced the request to, which is what a client may keep if it wants
 * to re-run a search.
 *
 * ## Two ways to get an origin, and the second needs no permission
 *
 * `fetchNearby` takes a position; `fetchNearbyPlaces` answers with the CITIES
 * that actually hold the item, each carrying a cell whose centre is a usable
 * origin. So a shopper who declines the location prompt gets a real answer
 * rather than a dead end, which is #93 acceptance 5.
 *
 * ## The collection code is fetched separately, and only when it is rendered
 *
 * Not a field of the order. An order DTO is logged, cached and forwarded into
 * support tools; a code carried inside one would follow it into all three.
 */

/** Unwrap the Mercaria envelope, or throw with whatever the server said. */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/** Where a nearby search is measured from, and how the shopper supplied it. */
export interface NearbyOrigin {
  readonly latitude: number;
  readonly longitude: number;
  /**
   * DECLARED, and a label rather than a claim the server acts on: it exists so
   * a rollout can tell "shoppers who shared a location" from "shoppers who
   * picked a city", which are different products.
   */
  readonly source: 'device' | 'map_area' | 'published_place';
}

/** One page of collectable locations for a canonical entity. */
export async function fetchNearby(params: {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  origin: NearbyOrigin;
  radiusMetres?: number;
  country?: string;
  currency?: string;
  conditionKeys?: readonly ItemConditionKey[];
  /**
   * Ask for the actor-specific verdict too (#93 nearby rule 12).
   *
   * Left OFF while browsing: a shopper reading a product page wants to know
   * what is on a shelf, and the question "may I check out here" costs the
   * server per-location work that a browse should not spend.
   */
  withCheckoutEligibility?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<NearbyResponse> {
  const { data } = await apiClient.get<ApiResponse<NearbyResponse>>('/nearby', {
    params: {
      ...(params.canonicalVariantId ? { canonicalVariantId: params.canonicalVariantId } : {}),
      ...(params.canonicalProductId ? { canonicalProductId: params.canonicalProductId } : {}),
      latitude: params.origin.latitude,
      longitude: params.origin.longitude,
      originSource: params.origin.source,
      ...(params.radiusMetres ? { radiusMetres: params.radiusMetres } : {}),
      ...(params.country ? { country: params.country } : {}),
      ...(params.currency ? { currency: params.currency } : {}),
      ...(params.conditionKeys?.length
        ? { conditionKeys: params.conditionKeys.join(',') }
        : {}),
      ...(params.withCheckoutEligibility ? { withCheckoutEligibility: 'true' } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
  });
  return unwrap(data, 'Failed to look for nearby availability');
}

/**
 * The manual fallback: cities that actually hold this item (#93 acceptance 5).
 *
 * Every suggestion carries a cell, and its centre is what the next
 * {@link fetchNearby} uses as an origin — so declining the location prompt
 * costs a shopper one tap and no precision they did not choose to give.
 */
export async function fetchNearbyPlaces(params: {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  q?: string;
  country?: string;
  limit?: number;
}): Promise<readonly NearbyPlaceSuggestion[]> {
  const { data } = await apiClient.get<ApiResponse<{ places: NearbyPlaceSuggestion[] }>>(
    '/nearby/places',
    { params },
  );
  return unwrap(data, 'Failed to suggest nearby places').places;
}

/** The centre of a suggested place — the origin a manual choice produces. */
export function placeOrigin(place: NearbyPlaceSuggestion): NearbyOrigin {
  return {
    latitude: (place.cell.latIndex + 0.5) * place.cell.precisionDegrees,
    longitude: (place.cell.lonIndex + 0.5) * place.cell.precisionDegrees,
    source: 'published_place',
  };
}

/** An order's collection snapshot, and its code when there is one to show. */
export interface CollectionView {
  readonly pickup: OrderPickup;
  /**
   * ABSENT for a location that asks for no code, for a cancelled collection and
   * on a deployment with none configured. The client renders nothing in each
   * case, which is right for all three — a present-but-empty field is the shape
   * that gets rendered as a blank box.
   */
  readonly code?: PickupCollectionCode;
}

/** The buyer's own view, through their account. */
export async function fetchOrderCollection(orderId: string): Promise<CollectionView> {
  const { data } = await apiClient.get<ApiResponse<CollectionView>>(
    `/orders/${orderId}/collection`,
  );
  return unwrap(data, 'Failed to load the collection');
}

/**
 * The same view through a guest PORTAL credential (#108).
 *
 * A separate function because the PATH differs and the credential differs; the
 * server handler is the same one, which is #93 verification rule 9 — guest and
 * authenticated buyers use one collection mechanism.
 */
export async function fetchGuestOrderCollection(input: {
  checkoutGroupId: string;
  orderId: string;
}): Promise<CollectionView> {
  const { data } = await apiClient.get<ApiResponse<CollectionView>>(
    `/guest/orders/${input.checkoutGroupId}/orders/${input.orderId}/collection`,
  );
  return unwrap(data, 'Failed to load the collection');
}
