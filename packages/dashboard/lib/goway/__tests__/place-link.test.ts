/**
 * What the editor says about a location's GoWay place link.
 *
 * `storeLinkState` mirrors the backend's trust rule on the merchant's side of
 * the screen, so each of its four answers is pinned against the place shape
 * GoWay returns — strongest tier first, as GoWay's own `strongestCapability`
 * ranks — and a community assertion of the RIGHT location is still not a link.
 */

import { describe, expect, it } from 'vitest';
import { PLACE_LINK_GAPS } from '@mercaria/shared-types';
import type { PlaceCapability, PlaceClaim } from '@goway.to/sdk';
import { PLACE_LINK_GAP_KEYS, canFileClaim, claimOnPlace, storeLinkState } from '../place-link';

function link(value: string, verification: PlaceCapability['verification']): PlaceCapability {
  return {
    namespace: 'commerce.mercaria',
    capability: 'store',
    key: 'commerce.mercaria.store',
    value,
    verification,
    observedAt: '2026-10-01T00:00:00.000Z',
  };
}

function claim(
  state: PlaceClaim['state'],
  placeId = 'gw_1',
  claimedAt = '2026-10-01T00:00:00.000Z',
): PlaceClaim {
  return {
    id: `c_${state}_${claimedAt}`,
    placeId,
    role: 'owner',
    state,
    oxyAccountId: 'org_1',
    claimedAt,
  };
}

describe('storeLinkState', () => {
  it('is missing on a place that names no Mercaria location', () => {
    expect(storeLinkState({ capabilities: [] }, 'loc_1')).toBe('missing');
  });

  it('is verified only at a claimant or Oxy tier', () => {
    expect(storeLinkState({ capabilities: [link('loc_1', 'business_asserted')] }, 'loc_1')).toBe(
      'verified',
    );
    expect(storeLinkState({ capabilities: [link('loc_1', 'oxy_verified')] }, 'loc_1')).toBe(
      'verified',
    );
    expect(storeLinkState({ capabilities: [link('loc_1', 'community_reported')] }, 'loc_1')).toBe(
      'unverified',
    );
  });

  it('reads the STRONGEST assertion: a business naming another location beats a community report of this one', () => {
    const place = {
      capabilities: [link('loc_1', 'community_reported'), link('loc_2', 'business_asserted')],
    };
    expect(storeLinkState(place, 'loc_1')).toBe('other_location');
  });
});

describe('claimOnPlace', () => {
  it('prefers an approved claim, then a pending one, and ignores other places', () => {
    expect(
      claimOnPlace([claim('pending'), claim('approved'), claim('approved', 'gw_2')], 'gw_1')?.state,
    ).toBe('approved');
    expect(claimOnPlace([claim('rejected'), claim('pending')], 'gw_1')?.state).toBe('pending');
    expect(claimOnPlace([claim('approved', 'gw_2')], 'gw_1')).toBeUndefined();
  });

  it('falls back to the latest closed claim', () => {
    const latest = claim('revoked', 'gw_1', '2026-10-03T00:00:00.000Z');
    expect(claimOnPlace([claim('rejected'), latest], 'gw_1')).toBe(latest);
  });

  it('lets a store file again only when it holds no open claim', () => {
    expect(canFileClaim(undefined)).toBe(true);
    expect(canFileClaim(claim('rejected'))).toBe(true);
    expect(canFileClaim(claim('pending'))).toBe(false);
    expect(canFileClaim(claim('approved'))).toBe(false);
  });
});

describe('PLACE_LINK_GAP_KEYS', () => {
  it('explains every gap the verify endpoint can report', () => {
    expect(Object.keys(PLACE_LINK_GAP_KEYS).sort()).toEqual([...PLACE_LINK_GAPS].sort());
  });
});
