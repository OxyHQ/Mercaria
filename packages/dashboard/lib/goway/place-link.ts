/**
 * What the location editor says about the link between a Mercaria location and
 * its GoWay place (ADR 0013) — pure, so every branch is tested without a
 * renderer.
 *
 * A location is discoverable only while its GoWay place names it back:
 * `commerce.mercaria.store` = the location id, asserted at `business_asserted`
 * (which only an APPROVED claimant can write) or `oxy_verified`. Mercaria's
 * verify endpoint is the authority on the verdict; this module turns its gaps
 * into sentences, and reads the two things only the merchant's own session can
 * see — the store's claim on the place, and how strongly the place names the
 * location today.
 */

import {
  strongestCapability,
  type Place,
  type PlaceClaim,
  type PlaceClaimState,
} from '@goway.to/sdk';
import type { PlaceLinkGap } from '@mercaria/shared-types';

/** The capability a GoWay place carries to say "this is Mercaria location X". */
export const MERCARIA_STORE_CAPABILITY = 'commerce.mercaria.store' as const;

/** One plain-language explanation per gap the verify endpoint can report, as KEYS. */
export const PLACE_LINK_GAP_KEYS: Record<PlaceLinkGap, string> = {
  place_not_set: 'settings.locations.editor.gaps.placeNotSet',
  place_not_found: 'settings.locations.editor.gaps.placeNotFound',
  place_gone: 'settings.locations.editor.gaps.placeGone',
  place_not_active: 'settings.locations.editor.gaps.placeNotActive',
  goway_unavailable: 'settings.locations.editor.gaps.gowayUnavailable',
  store_link_missing: 'settings.locations.editor.gaps.storeLinkMissing',
  store_link_names_other_location: 'settings.locations.editor.gaps.storeLinkOtherLocation',
  store_link_unverified: 'settings.locations.editor.gaps.storeLinkUnverified',
  place_country_missing: 'settings.locations.editor.gaps.placeCountryMissing',
  place_timezone_missing: 'settings.locations.editor.gaps.placeTimezoneMissing',
};

/** A claim's state, as the merchant reads it. */
export const CLAIM_STATE_KEYS: Record<PlaceClaimState, string> = {
  pending: 'settings.locations.editor.claim.state.pending',
  approved: 'settings.locations.editor.claim.state.approved',
  rejected: 'settings.locations.editor.claim.state.rejected',
  revoked: 'settings.locations.editor.claim.state.revoked',
};

/** Which of an account's claims speaks for it on this place: approved, else pending, else the latest. */
export function claimOnPlace(
  claims: readonly PlaceClaim[],
  placeId: string,
): PlaceClaim | undefined {
  const onPlace = claims.filter((claim) => claim.placeId === placeId);
  return (
    onPlace.find((claim) => claim.state === 'approved') ??
    onPlace.find((claim) => claim.state === 'pending') ??
    [...onPlace].sort((left, right) => right.claimedAt.localeCompare(left.claimedAt))[0]
  );
}

/** Whether the store may file a NEW claim: it holds none, or only a closed one. */
export function canFileClaim(claim: PlaceClaim | undefined): boolean {
  return claim === undefined || claim.state === 'rejected' || claim.state === 'revoked';
}

/**
 * How the place names this location today, read off the place itself.
 *
 * - `missing` — no `commerce.mercaria.store` at all;
 * - `other_location` — its strongest assertion names a different location;
 * - `unverified` — names this one, but no claimant vouches for it yet;
 * - `verified` — names this one at `business_asserted` or `oxy_verified`.
 */
export type StoreLinkState = 'missing' | 'other_location' | 'unverified' | 'verified';

export function storeLinkState(
  place: Pick<Place, 'capabilities'>,
  locationId: string,
): StoreLinkState {
  const strongest = strongestCapability(place, MERCARIA_STORE_CAPABILITY);
  if (strongest === undefined) return 'missing';
  if (strongest.value !== locationId) return 'other_location';
  return strongest.verification === 'business_asserted' || strongest.verification === 'oxy_verified'
    ? 'verified'
    : 'unverified';
}

export const STORE_LINK_STATE_KEYS: Record<StoreLinkState, string> = {
  missing: 'settings.locations.editor.storeLink.state.missing',
  other_location: 'settings.locations.editor.storeLink.state.otherLocation',
  unverified: 'settings.locations.editor.storeLink.state.unverified',
  verified: 'settings.locations.editor.storeLink.state.verified',
};
