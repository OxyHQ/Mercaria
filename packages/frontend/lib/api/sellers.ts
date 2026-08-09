import type {
  ApiResponse,
  Listing,
  PublicSellerListingsPage,
  PublicSellerProfile,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Public P2P seller API client (#92).
 *
 * `/sellers` (plural) is the PUBLIC profile; `/seller` (singular) is the
 * authenticated seller's own management surface and is not reachable from here.
 *
 * There is no follow endpoint and there will not be one: follow state lives in
 * Oxy's user-owned graph and `@oxyhq/services` talks to it directly.
 */

/** Fetch a seller's public profile. Throws on an unresolvable or hidden seller (404). */
export async function fetchSellerProfile(oxyUserId: string): Promise<PublicSellerProfile> {
  const { data } = await apiClient.get<ApiResponse<PublicSellerProfile>>(
    `/sellers/${encodeURIComponent(oxyUserId)}`,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load seller');
  }
  return data.data;
}

/**
 * Fetch one KEYSET page of a seller's public listings.
 *
 * `cursor` is opaque and is passed back verbatim — never an offset. A seller
 * publishes and archives while somebody is scrolling, and an offset silently
 * skips or repeats rows exactly when they do.
 */
export async function fetchSellerListings(
  oxyUserId: string,
  params?: { limit?: number; cursor?: string },
): Promise<PublicSellerListingsPage<Listing>> {
  const { data } = await apiClient.get<ApiResponse<PublicSellerListingsPage<Listing>>>(
    `/sellers/${encodeURIComponent(oxyUserId)}/listings`,
    { params },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load seller listings');
  }
  return data.data;
}
