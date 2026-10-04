/**
 * The projection of a GoWay place and the trust rule over it (ADR 0013).
 *
 * Driven as a table from an ELIGIBLE base, so every case flips exactly one fact
 * and the expected gap is exact rather than a `toContain` — the fixture law the
 * pickup derivations follow.
 */

import { describe, expect, it } from 'vitest';
import type { Place } from '@goway.to/sdk';
import {
  hoursExceptionsOf,
  openStateOf,
  opensWithinHorizon,
  pickupAddressOf,
  placeFactsOf,
  placeLinkBlockers,
  placeLinkBroken,
  placeLinkGaps,
  type PlaceFacts,
  type PlaceLookup,
} from '../place-facts.js';

const OBSERVED = '2026-09-01T00:00:00.000Z';
const LOCATION_ID = 'location-1';

function storeLink(locationId: string, verification: Place['capabilities'][number]['verification']) {
  return {
    namespace: 'commerce.mercaria',
    capability: 'store',
    key: 'commerce.mercaria.store',
    value: locationId,
    verification,
    observedAt: OBSERVED,
  };
}

const PLACE: Place = {
  id: 'place-1',
  name: 'Llibreria Central',
  localizedName: { language: 'en', name: 'Central Bookshop', source: 'goway' },
  location: { latitude: 41.39, longitude: 2.17 },
  categories: ['shop.books'],
  address: { street: 'Carrer de Mallorca', houseNumber: '237', locality: 'Eixample', city: 'Barcelona', postalCode: '08008', countryCode: 'es' },
  contact: { phone: '+34 931 000 000', website: 'https://llibreria.example' },
  timezone: 'Europe/Madrid',
  openingHours: { intervals: [1, 2, 3, 4, 5].map((day) => ({ day: day as 1, opens: '09:00', closes: '20:00' })) },
  hoursExceptions: [],
  status: 'active',
  verification: { state: 'unverified' },
  sources: [],
  capabilities: [
    storeLink(LOCATION_ID, 'business_asserted'),
    {
      namespace: 'accessibility',
      capability: 'step_free_entrance',
      key: 'accessibility.step_free_entrance',
      value: true,
      verification: 'business_asserted',
      observedAt: OBSERVED,
    },
    {
      namespace: 'accessibility',
      capability: 'hearing_loop',
      key: 'accessibility.hearing_loop',
      value: false,
      verification: 'community_reported',
      observedAt: OBSERVED,
    },
  ],
  createdAt: OBSERVED,
  updatedAt: OBSERVED,
};

const FACTS = placeFactsOf(PLACE, 'https://goway.to/place/place-1');

function found(place: PlaceFacts): PlaceLookup {
  return { kind: 'found', place, stale: false };
}

describe('placeFactsOf', () => {
  it('projects the parts Mercaria uses, in Mercaria shapes', () => {
    expect(FACTS.name).toBe('Llibreria Central');
    expect(FACTS.displayName).toBe('Central Bookshop');
    expect(FACTS.address).toEqual({
      line1: 'Carrer de Mallorca 237',
      line2: 'Eixample',
      city: 'Barcelona',
      postalCode: '08008',
      country: 'ES',
    });
    expect(FACTS.contact).toEqual({ phone: '+34 931 000 000', url: 'https://llibreria.example' });
    // An assertion of `false` is a fact too: absence is the third state.
    expect(FACTS.accessibility).toEqual({ stepFreeAccess: true, hearingLoop: false });
    expect(FACTS.storeLink).toEqual({ locationId: LOCATION_ID, verification: 'business_asserted' });
    expect(FACTS.url).toBe('https://goway.to/place/place-1');
  });

  it('puts the house number first only where the country does', () => {
    const us = placeFactsOf(
      { ...PLACE, address: { street: 'Main St', houseNumber: '12', countryCode: 'US' } },
      'u',
    );
    expect(us.address.line1).toBe('12 Main St');
  });

  it('reads the STRONGEST back-reference, so a community report cannot outvote the business', () => {
    const contested = placeFactsOf(
      {
        ...PLACE,
        capabilities: [storeLink('somebody-else', 'community_reported'), storeLink(LOCATION_ID, 'business_asserted')],
      },
      'u',
    );
    expect(contested.storeLink?.locationId).toBe(LOCATION_ID);
  });
});

describe('placeLinkGaps — the trust rule, one failing condition at a time', () => {
  it('admits the base fixture, so every case below flips exactly one fact', () => {
    expect(placeLinkGaps({ locationId: LOCATION_ID, goWayPlaceId: PLACE.id, lookup: found(FACTS) })).toEqual([]);
  });

  it('(a) refuses a location that names no place', () => {
    expect(placeLinkGaps({ locationId: LOCATION_ID, goWayPlaceId: null, lookup: null })).toEqual(['place_not_set']);
  });

  const lookups: readonly [string, PlaceLookup, string][] = [
    ['(b) a place GoWay never heard of', { kind: 'not_found' }, 'place_not_found'],
    ['(b) a place GoWay removed', { kind: 'gone', mergedInto: null }, 'place_gone'],
    ['(b) a MERGED place, until the verify act follows it', { kind: 'gone', mergedInto: 'place-2' }, 'place_gone'],
    ['(b) GoWay unable to answer, with nothing cached', { kind: 'unavailable' }, 'goway_unavailable'],
  ];
  for (const [label, lookup, gap] of lookups) {
    it(`refuses ${label}`, () => {
      expect(placeLinkGaps({ locationId: LOCATION_ID, goWayPlaceId: PLACE.id, lookup })).toEqual([gap]);
    });
  }

  const places: readonly [string, Partial<Place>, string][] = [
    ['(b) a closed place', { status: 'closed' }, 'place_not_active'],
    ['(b) a merely proposed place', { status: 'proposed' }, 'place_not_active'],
    ['(c) a place with no back-reference', { capabilities: [] }, 'store_link_missing'],
    [
      '(c) a place naming another location',
      { capabilities: [storeLink('location-2', 'business_asserted')] },
      'store_link_names_other_location',
    ],
    [
      '(c) a back-reference only the community made',
      { capabilities: [storeLink(LOCATION_ID, 'community_reported')] },
      'store_link_unverified',
    ],
    [
      '(c) a back-reference only an import made',
      { capabilities: [storeLink(LOCATION_ID, 'external_source')] },
      'store_link_unverified',
    ],
    ['a place with no country', { address: { city: 'Barcelona' } }, 'place_country_missing'],
    ['a place with no timezone', { timezone: undefined }, 'place_timezone_missing'],
  ];
  for (const [label, patch, gap] of places) {
    it(`refuses ${label}`, () => {
      const place = placeFactsOf({ ...PLACE, ...patch }, 'u');
      expect(placeLinkGaps({ locationId: LOCATION_ID, goWayPlaceId: PLACE.id, lookup: found(place) })).toEqual([gap]);
    });
  }

  it('admits the Oxy tier as well as the business one', () => {
    const verified = placeFactsOf({ ...PLACE, capabilities: [storeLink(LOCATION_ID, 'oxy_verified')] }, 'u');
    expect(placeLinkGaps({ locationId: LOCATION_ID, goWayPlaceId: PLACE.id, lookup: found(verified) })).toEqual([]);
  });

  it('maps gaps to ONE block reason per remedy', () => {
    expect(
      placeLinkBlockers(['place_gone', 'goway_unavailable', 'store_link_unverified', 'place_country_missing']).sort(),
    ).toEqual(['place_incomplete', 'place_link_unverified', 'place_unavailable']);
    expect(placeLinkBlockers([])).toEqual([]);
  });

  it('calls a link broken only when the place does not vouch — never for an outage or an incomplete place', () => {
    for (const gap of ['place_not_set', 'place_gone', 'place_not_active', 'store_link_names_other_location'] as const) {
      expect(placeLinkBroken([gap]), gap).toBe(true);
    }
    expect(placeLinkBroken(['goway_unavailable'])).toBe(false);
    expect(placeLinkBroken(['place_country_missing', 'place_timezone_missing'])).toBe(false);
    expect(placeLinkBroken([])).toBe(false);
  });
});

describe('the address an order freezes', () => {
  it('insists on a country, and never invents one', () => {
    expect(pickupAddressOf(FACTS)?.country).toBe('ES');
    expect(pickupAddressOf(placeFactsOf({ ...PLACE, address: { city: 'Barcelona' } }, 'u'))).toBeNull();
  });
});

describe('opening facts — GoWay\'s own evaluation', () => {
  // A Monday at 10:00 in Madrid (08:00 UTC in summer).
  const MONDAY_MORNING = new Date('2026-08-10T08:00:00Z');

  it('reads open, and when that changes today', () => {
    expect(openStateOf(FACTS.opening, MONDAY_MORNING)).toEqual({ known: true, open: true, changesAt: '20:00' });
  });

  it('answers unknown without a zone rather than guessing one', () => {
    const zoneless = placeFactsOf({ ...PLACE, timezone: undefined }, 'u');
    expect(openStateOf(zoneless.opening, MONDAY_MORNING)).toEqual({ known: false });
  });

  it('lets a dated exception decide the day, and carries its note', () => {
    const shut = placeFactsOf(
      {
        ...PLACE,
        hoursExceptions: [
          {
            id: 'x',
            placeId: PLACE.id,
            startsOn: '2026-08-10',
            endsOn: '2026-08-10',
            closed: true,
            intervals: [],
            note: 'Stocktake',
            source: 'goway',
            verification: 'business_asserted',
            observedAt: OBSERVED,
          },
        ],
      },
      'u',
    );
    expect(openStateOf(shut.opening, MONDAY_MORNING)).toMatchObject({ known: true, open: false, exceptionNote: 'Stocktake' });
    // Closed today, open tomorrow: still a place to send somebody this week.
    expect(opensWithinHorizon(shut.opening, MONDAY_MORNING)).toBe(true);
  });

  it('treats a place with no weekly hours as possibly open, never as never open', () => {
    const silent = placeFactsOf({ ...PLACE, openingHours: undefined }, 'u');
    expect(opensWithinHorizon(silent.opening, MONDAY_MORNING)).toBe(true);
  });

  it('shows only the STRONGER of two exceptions for the same dates', () => {
    const both = placeFactsOf(
      {
        ...PLACE,
        hoursExceptions: (['community_reported', 'business_asserted'] as const).map((verification, index) => ({
          id: `e${index}`,
          placeId: PLACE.id,
          startsOn: '2026-08-15',
          endsOn: '2026-08-15',
          closed: verification === 'community_reported',
          intervals: verification === 'community_reported' ? [] : [{ opens: '10:00', closes: '14:00' }],
          source: 'goway',
          verification,
          observedAt: OBSERVED,
        })),
      },
      'u',
    );
    expect(hoursExceptionsOf(both.opening)).toEqual([
      { startsOn: '2026-08-15', endsOn: '2026-08-15', closed: false, intervals: [{ opens: '10:00', closes: '14:00' }] },
    ]);
  });
});
