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
  accessibilityChoicesWithEdits,
  accessibilityOperations,
  contactInputOf,
  draftFromSearchResult,
  editPlaceDraft,
  placeAddressQuery,
  hoursExceptionInputOf,
  placeCreateInputOf,
  type AccessibilityChoices,
} from '../place-form';

const BARCELONA = {
  ...EMPTY_PLACE_DRAFT,
  name: ' Cafè ',
  countryCode: 'es',
  latitude: '41.3874',
  longitude: '2.1686',
};

describe('placeCreateInputOf', () => {
  it('builds the body with a trimmed name and an upper-cased country', () => {
    const built = placeCreateInputOf({
      ...BARCELONA,
      street: 'Carrer Gran',
      houseNumber: '5',
      city: 'Barcelona',
    });
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
    expect(placeCreateInputOf({ ...BARCELONA, latitude: '0', longitude: '0' })).toMatchObject({
      ok: false,
    });
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
    expect(draft).toMatchObject({
      name: 'Shop',
      street: 'Carrer Gran',
      city: 'Barcelona',
      countryCode: 'ES',
    });
    expect(placeCreateInputOf(draft).ok).toBe(true);
  });
});

describe('GoWay address selection', () => {
  it('invalidates both coordinates when any postal field changes', () => {
    for (const key of [
      'street',
      'houseNumber',
      'city',
      'region',
      'postalCode',
      'countryCode',
    ] as const) {
      const changed = editPlaceDraft(BARCELONA, key, 'changed');
      expect(changed).toMatchObject({ [key]: 'changed', latitude: '', longitude: '' });
      expect(placeCreateInputOf(changed).ok).toBe(false);
    }
  });
  it('preserves a selected position when renaming the business or leaving a value unchanged', () => {
    expect(editPlaceDraft(BARCELONA, 'name', 'Other name')).toMatchObject({
      latitude: BARCELONA.latitude,
      longitude: BARCELONA.longitude,
    });
    expect(editPlaceDraft(BARCELONA, 'countryCode', BARCELONA.countryCode)).toBe(BARCELONA);
  });
  it('keeps reviewed fields omitted by a structured result, while using its returned position', () => {
    const result: SearchResult = {
      id: 'r2',
      displayName: 'Public shop',
      kind: 'poi',
      source: 'goway',
      coordinate: { latitude: 41.4, longitude: 2.2 },
      address: { street: 'Resolved street' },
    };
    const draft = draftFromSearchResult(result, 'Shop', {
      ...BARCELONA,
      street: 'Typed street',
      houseNumber: '43',
      postalCode: '08007',
    });
    expect(draft).toMatchObject({
      street: 'Resolved street',
      countryCode: 'es',
      houseNumber: '43',
      postalCode: '08007',
      latitude: '41.4',
      longitude: '2.2',
    });
    // A general search has no reviewed address and must not inherit another place.
    expect(draftFromSearchResult(result, 'Shop').countryCode).toBe('');
  });
  it('sends only trimmed structured postal fields to the official geocoder', () => {
    expect(
      placeAddressQuery({
        ...BARCELONA,
        street: ' Passeig de Gràcia ',
        houseNumber: ' 43 ',
        city: ' Barcelona ',
        region: '  ',
      }),
    ).toEqual({
      street: 'Passeig de Gràcia',
      houseNumber: '43',
      city: 'Barcelona',
      countryCode: 'ES',
    });
  });
});

describe('contactInputOf', () => {
  it('sends only edited fields, never stale values from an earlier DTO', () => {
    expect(contactInputOf({ email: ' new@example.org ' })).toEqual({
      ok: true,
      contact: { email: 'new@example.org' },
    });
    expect(contactInputOf({ phone: ' +34 600 ' })).toEqual({
      ok: true,
      contact: { phone: '+34 600' },
    });
    expect(contactInputOf({})).toEqual({ ok: true, contact: {} });
  });
  it('clears an explicitly emptied field even when an earlier read had no value', () => {
    expect(contactInputOf({ phone: '' })).toEqual({ ok: true, contact: { phone: null } });
    expect(contactInputOf({ website: '   ', email: '' })).toEqual({
      ok: true,
      contact: { website: null, email: null },
    });
  });
  it('validates only edited email and website fields', () => {
    expect(contactInputOf({ website: 'example.org' })).toMatchObject({ ok: false });
    expect(contactInputOf({ email: 'not-an-email' })).toMatchObject({ ok: false });
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
      flags: {
        ...current.flags,
        'accessibility.hearing_loop': 'unset',
        'accessibility.parking_accessible': 'yes',
      },
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
      hoursExceptionInputOf({
        startsOn: '2026-12-25',
        endsOn: '',
        closed: true,
        hours: '',
        note: 'Christmas',
      }),
    ).toEqual({
      ok: true,
      input: { startsOn: '2026-12-25', endsOn: '2026-12-25', closed: true, note: 'Christmas' },
    });
  });

  it('requires hours for an open exception, and readable dates in order', () => {
    expect(
      hoursExceptionInputOf({
        startsOn: '2026-12-24',
        endsOn: '',
        closed: false,
        hours: '',
        note: '',
      }),
    ).toEqual({
      ok: false,
      errorKey: 'settings.locations.editor.exceptions.hoursInvalid',
    });
    expect(
      hoursExceptionInputOf({
        startsOn: '2026-12-24',
        endsOn: '',
        closed: false,
        hours: '10:00-14:00',
        note: '',
      }),
    ).toEqual({
      ok: true,
      input: {
        startsOn: '2026-12-24',
        endsOn: '2026-12-24',
        closed: false,
        intervals: [{ opens: '10:00', closes: '14:00' }],
      },
    });
    expect(
      hoursExceptionInputOf({
        startsOn: '2026-12-24',
        endsOn: '2026-12-01',
        closed: true,
        hours: '',
        note: '',
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('accessibility drafts after a remote update', () => {
  it('never reverts an untouched capability from the latest GoWay read', () => {
    const remote = accessibilityChoicesOf({
      capabilities: [capability('accessibility.step_free_entrance', true)],
    });
    const desired = accessibilityChoicesWithEdits(remote, { 'accessibility.hearing_loop': 'yes' });
    expect(desired.flags['accessibility.step_free_entrance']).toBe('yes');
    expect(accessibilityOperations(remote, desired)).toEqual([
      { kind: 'put', key: 'accessibility.hearing_loop', assertion: { value: true } },
    ]);
    expect(accessibilityOperations(remote, accessibilityChoicesWithEdits(remote, {}))).toEqual([]);
  });
  it('keeps an explicit withdrawal and wheelchair choice while other facts refresh', () => {
    const remote = accessibilityChoicesOf({
      capabilities: [capability('accessibility.hearing_loop', true)],
    });
    expect(
      accessibilityOperations(
        remote,
        accessibilityChoicesWithEdits(remote, {
          'accessibility.hearing_loop': 'unset',
          'accessibility.wheelchair': 'limited',
        }),
      ),
    ).toEqual([
      { kind: 'delete', key: 'accessibility.hearing_loop' },
      { kind: 'put', key: 'accessibility.wheelchair', assertion: { value: 'limited' } },
    ]);
  });
});
