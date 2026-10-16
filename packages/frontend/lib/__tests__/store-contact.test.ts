import { describe, expect, it } from 'vitest';
import type { Place } from '@goway.to/sdk';
import type { MercariaLocation } from '@mercaria/contracts';
import { placeBelongsToLocation, storeContactLinks } from '../store-contact';

const location: MercariaLocation = {
  ref: { kind: 'location', id: 'location-1' },
  goWayPlaceId: 'place-1',
  store: { ref: { kind: 'store', id: 'store-1' }, handle: 'shop', name: 'Shop', logoUrl: null },
  pickup: null,
  discoverable: false,
  url: 'https://mercaria.co/stores/shop',
};
const place: Place = {
  id: 'place-1',
  name: 'Shop front',
  location: { latitude: 41, longitude: 2 },
  categories: [],
  status: 'active',
  verification: { state: 'owner_verified' },
  sources: [],
  capabilities: [
    {
      namespace: 'commerce',
      capability: 'mercaria.store',
      key: 'commerce.mercaria.store',
      value: 'location-1',
      verification: 'business_asserted',
      observedAt: '2026-10-10T00:00:00Z',
    },
  ],
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
};

describe('public store contact', () => {
  it('requires the current place, active status and claimant-level backlink', () => {
    expect(placeBelongsToLocation(location, place)).toBe(true);
    expect(placeBelongsToLocation(location, { ...place, id: 'another-place' })).toBe(false);
    expect(placeBelongsToLocation(location, { ...place, status: 'closed' })).toBe(false);
    expect(placeBelongsToLocation(location, { ...place, capabilities: [] })).toBe(false);
    for (const capability of [
      { ...place.capabilities[0], value: 'other-location' },
      { ...place.capabilities[0], verification: 'community_reported' as const },
    ])
      expect(placeBelongsToLocation(location, { ...place, capabilities: [capability] })).toBe(
        false,
      );
  });

  it('uses published contacts only and keeps URI data out of headers', () => {
    expect(storeContactLinks(undefined)).toEqual([]);
    expect(
      storeContactLinks({
        phone: ' +34 931 000 000 ',
        email: 'support+shop@example.com',
        website: 'https://example.com/contact',
      }),
    ).toEqual([
      { kind: 'phone', value: '+34 931 000 000', href: 'tel:%2B34%20931%20000%20000' },
      {
        kind: 'email',
        value: 'support+shop@example.com',
        href: 'mailto:support%2Bshop%40example.com',
      },
      {
        kind: 'website',
        value: 'https://example.com/contact',
        href: 'https://example.com/contact',
      },
    ]);
    expect(
      storeContactLinks({
        phone: '+34\n123',
        email: 'a@example.com\r\nbcc:b@example.com',
        website: 'javascript:alert(1)',
      }),
    ).toEqual([]);
    expect(storeContactLinks({ website: 'https://user:secret@example.com' })).toEqual([]);
    expect(storeContactLinks({ phone: '+34\u0000123', email: 'a\u0000@example.com' })).toEqual([]);
    expect(storeContactLinks({ website: 'not a URL', phone: ' ' })).toEqual([]);
  });
});
