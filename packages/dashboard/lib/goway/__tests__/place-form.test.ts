/**
 * The location editor's forms → GoWay inputs.
 *
 * What these pin is what is SENT: a created place always carries a country
 * (Mercaria cannot describe a collection point without one), the accessibility
 * form writes only the keys a merchant changed, and an exception's hours are
 * required exactly when it is open.
 */

import { describe, expect, it } from 'vitest';
import type { PlaceCapability, SearchResult } from '@goway.to/sdk';
import {
  EMPTY_PLACE_DRAFT,
  accessibilityChoicesOf,
  accessibilityOperations,
  contactInputOf,
  draftFromSearchResult,
  hoursExceptionInputOf,
  placeCreateInputOf,
  type AccessibilityChoices,
} from '../place-form';

const BARCELONA = { ...EMPTY_PLACE_DRAFT, name: ' Cafè ', countryCode: 'es', latitude: '41.3874', longitude: '2.1686' };

describe('placeCreateInputOf', () => {
  it('builds the body with a trimmed name and an upper-cased country', () => {
    const built = placeCreateInputOf({ ...BARCELONA, street: 'Carrer Gran', houseNumber: '5', city: 'Barcelona' });
    expect(built).toEqual({
      ok: true,
      input: {
        name: 'Cafè',
        location: { latitude: 41.3874, longitude: 2.1686 },
        address: { street: 'Carrer Gran', houseNumber: '5', city: 'Barcelona', countryCode: 'ES' },
      },
    });
  });

  it('refuses a place with no country, no position, or the null island', () => {
    expect(placeCreateInputOf({ ...BARCELONA, countryCode: '' })).toEqual({
      ok: false,
      errorKey: 'settings.locations.editor.create.countryRequired',
    });
    expect(placeCreateInputOf({ ...BARCELONA, latitude: '' })).toMatchObject({ ok: false });
    expect(placeCreateInputOf({ ...BARCELONA, latitude: '0', longitude: '0' })).toMatchObject({ ok: false });
    expect(placeCreateInputOf({ ...BARCELONA, name: ' ' })).toMatchObject({
      errorKey: 'settings.locations.editor.create.nameRequired',
    });
  });

  it('prefills from a search result GoWay holds no place for, position included', () => {
    const result: SearchResult = {
      id: 'r1',
      displayName: 'Carrer Gran 5, Barcelona',
      kind: 'address',
      coordinate: { latitude: 41.39, longitude: 2.17 },
      address: { street: 'Carrer Gran', houseNumber: '5', countryCode: 'ES' },
      context: { city: 'Barcelona' },
      source: 'photon',
    };
    const draft = draftFromSearchResult(result, 'Shop');
    expect(draft).toMatchObject({ name: 'Shop', street: 'Carrer Gran', city: 'Barcelona', countryCode: 'ES' });
    expect(placeCreateInputOf(draft).ok).toBe(true);
  });
});

describe('contactInputOf', () => {
  it('sends only filled fields and refuses a website that is not a link', () => {
    expect(contactInputOf({ phone: ' +34 600 ', email: '', website: '' })).toEqual({
      ok: true,
      contact: { phone: '+34 600' },
    });
    expect(contactInputOf({ phone: '', email: '', website: 'example.org' })).toMatchObject({ ok: false });
    expect(contactInputOf({ phone: '', email: 'not-an-email', website: '' })).toMatchObject({ ok: false });
  });
});

function capability(key: string, value: boolean | string): PlaceCapability {
  const separator = key.lastIndexOf('.');
  return {
    namespace: key.slice(0, separator),
    capability: key.slice(separator + 1),
    key,
    value,
    verification: 'business_asserted',
    observedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('accessibility', () => {
  const place = {
    capabilities: [
      capability('accessibility.step_free_entrance', true),
      capability('accessibility.hearing_loop', false),
      capability('accessibility.wheelchair', 'limited'),
    ],
  };

  it('reads the strongest assertion per key, and unset where there is none', () => {
    expect(accessibilityChoicesOf(place)).toEqual({
      flags: {
        'accessibility.step_free_entrance': 'yes',
        'accessibility.toilets_wheelchair': 'unset',
        'accessibility.parking_accessible': 'unset',
        'accessibility.hearing_loop': 'no',
      },
      wheelchair: 'limited',
    });
  });

  it('writes only what changed: a put for a value, a delete for unset', () => {
    const current = accessibilityChoicesOf(place);
    const desired: AccessibilityChoices = {
      flags: { ...current.flags, 'accessibility.hearing_loop': 'unset', 'accessibility.parking_accessible': 'yes' },
      wheelchair: 'yes',
    };
    expect(accessibilityOperations(current, desired)).toEqual([
      { kind: 'put', key: 'accessibility.parking_accessible', assertion: { value: true } },
      { kind: 'delete', key: 'accessibility.hearing_loop' },
      { kind: 'put', key: 'accessibility.wheelchair', assertion: { value: 'yes' } },
    ]);
    expect(accessibilityOperations(current, current)).toEqual([]);
  });
});

describe('hoursExceptionInputOf', () => {
  it('makes a one-day closure from a start date alone', () => {
    expect(
      hoursExceptionInputOf({ startsOn: '2026-12-25', endsOn: '', closed: true, hours: '', note: 'Christmas' }),
    ).toEqual({ ok: true, input: { startsOn: '2026-12-25', endsOn: '2026-12-25', closed: true, note: 'Christmas' } });
  });

  it('requires hours for an open exception, and readable dates in order', () => {
    expect(hoursExceptionInputOf({ startsOn: '2026-12-24', endsOn: '', closed: false, hours: '', note: '' })).toEqual({
      ok: false,
      errorKey: 'settings.locations.editor.exceptions.hoursInvalid',
    });
    expect(
      hoursExceptionInputOf({ startsOn: '2026-12-24', endsOn: '', closed: false, hours: '10:00-14:00', note: '' }),
    ).toEqual({
      ok: true,
      input: { startsOn: '2026-12-24', endsOn: '2026-12-24', closed: false, intervals: [{ opens: '10:00', closes: '14:00' }] },
    });
    expect(
      hoursExceptionInputOf({ startsOn: '2026-12-24', endsOn: '2026-12-01', closed: true, hours: '', note: '' }),
    ).toMatchObject({ ok: false });
  });
});
