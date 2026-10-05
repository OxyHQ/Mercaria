import { describe, expect, it } from 'vitest';
import { capabilityLabel, capabilityValueLabel, type Place, type PlaceHoursException, type PlaceMedia } from '@goway.to/sdk';
import {
  calendarDate,
  orderLocations,
  placeAddressLine,
  placeOpenState,
  placeToday,
  upcomingExceptions,
  visitAttributes,
  visitPhotos,
  weeklyHours,
} from '../visit-us';

const OBSERVED = '2026-09-01T00:00:00.000Z';

function capability(key: string, value: Place['capabilities'][number]['value'], verification = 'business_asserted') {
  const separator = key.lastIndexOf('.');
  return {
    namespace: key.slice(0, separator),
    capability: key.slice(separator + 1),
    key,
    value,
    verification: verification as Place['capabilities'][number]['verification'],
    observedAt: OBSERVED,
  };
}

function exception(
  startsOn: string,
  endsOn: string,
  overrides: Partial<PlaceHoursException> = {},
): PlaceHoursException {
  return {
    id: `${startsOn}-${endsOn}-${overrides.verification ?? 'business_asserted'}`,
    placeId: 'plc_1',
    startsOn,
    endsOn,
    closed: true,
    intervals: [],
    source: 'goway',
    verification: 'business_asserted',
    observedAt: OBSERVED,
    ...overrides,
  };
}

/** Weekdays 09:00–20:00 in Madrid. */
const SCHEDULE = {
  timezone: 'Europe/Madrid',
  openingHours: { intervals: ([1, 2, 3, 4, 5] as const).map((day) => ({ day, opens: '09:00', closes: '20:00' })) },
  hoursExceptions: [] as PlaceHoursException[],
};

/** Monday 2026-10-05, 10:00 in Madrid. */
const MONDAY_MORNING = new Date('2026-10-05T08:00:00Z');

describe('orderLocations', () => {
  const locations = [{ ref: { id: 'a' } }, { ref: { id: 'b' } }, { ref: { id: 'c' } }];

  it('puts the location a link named first, and keeps the rest in order', () => {
    expect(orderLocations(locations, 'c').map((l) => l.ref.id)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the order alone for no focus, or a focus naming none of them', () => {
    expect(orderLocations(locations).map((l) => l.ref.id)).toEqual(['a', 'b', 'c']);
    expect(orderLocations(locations, 'zzz').map((l) => l.ref.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('placeAddressLine', () => {
  it('prefers GoWay’s own formatting', () => {
    expect(placeAddressLine({ address: { formatted: 'Carrer de Mallorca 401, Barcelona', city: 'X' } })).toBe(
      'Carrer de Mallorca 401, Barcelona',
    );
  });

  it('joins only the parts GoWay publishes, and is empty for none', () => {
    expect(placeAddressLine({ address: { street: 'Carrer de Mallorca', houseNumber: '401', postalCode: '08013', city: 'Barcelona' } })).toBe(
      'Carrer de Mallorca 401, 08013 Barcelona',
    );
    expect(placeAddressLine({ address: { city: 'Barcelona' } })).toBe('Barcelona');
    expect(placeAddressLine({})).toBe('');
  });
});

describe('placeOpenState — GoWay’s evaluation', () => {
  it('reads open, and when that changes today', () => {
    expect(placeOpenState(SCHEDULE, MONDAY_MORNING)).toEqual({ known: true, open: true, changesAt: '20:00' });
  });

  it('answers unknown without a zone rather than guessing one', () => {
    expect(placeOpenState({ ...SCHEDULE, timezone: undefined }, MONDAY_MORNING)).toEqual({ known: false });
  });

  it('lets a dated closure decide the day, and carries its note', () => {
    const closed = { ...SCHEDULE, hoursExceptions: [exception('2026-10-05', '2026-10-05', { note: 'Stocktake' })] };
    expect(placeOpenState(closed, MONDAY_MORNING)).toMatchObject({ known: true, open: false, exceptionNote: 'Stocktake' });
  });
});

describe('weeklyHours', () => {
  it('gives seven rows, Monday first, a closed day as no spans', () => {
    const rows = weeklyHours({
      openingHours: {
        intervals: [
          { day: 1, opens: '16:00', closes: '20:00' },
          { day: 1, opens: '09:00', closes: '14:00' },
          { day: 6, opens: '10:00', closes: '14:00' },
        ],
      },
    });
    expect(rows?.map((row) => row.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(rows?.[0]?.spans).toEqual([
      { opens: '09:00', closes: '14:00' },
      { opens: '16:00', closes: '20:00' },
    ]);
    expect(rows?.[1]?.spans).toEqual([]);
  });

  it('says nothing — never "always closed" — for a place with no weekly hours', () => {
    expect(weeklyHours({})).toBeNull();
    expect(weeklyHours({ openingHours: { intervals: [] } })).toBeNull();
  });
});

describe('upcomingExceptions', () => {
  it('drops the ended, orders the rest, keeps the STRONGER of two for the same dates, and stops at three', () => {
    const list = upcomingExceptions(
      {
        hoursExceptions: [
          exception('2026-09-01', '2026-09-02'),
          exception('2026-12-25', '2026-12-25', { verification: 'community_reported', note: 'rumour' }),
          exception('2026-12-25', '2026-12-25', { verification: 'business_asserted', note: 'Christmas' }),
          exception('2026-10-05', '2026-10-12'),
          exception('2027-01-01', '2027-01-01'),
          exception('2027-01-06', '2027-01-06'),
        ],
      },
      '2026-10-05',
    );
    expect(list.map((entry) => entry.startsOn)).toEqual(['2026-10-05', '2026-12-25', '2027-01-01']);
    expect(list[1]?.note).toBe('Christmas');
  });

  it('reads today in the place’s own calendar', () => {
    // 23:30 UTC on the 4th is already the 5th in Madrid.
    expect(placeToday(SCHEDULE, new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-05');
  });
});

describe('calendarDate', () => {
  it('lands on the same calendar day in the local zone', () => {
    const date = calendarDate('2026-12-25');
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 11, 25]);
  });
});

describe('visitAttributes', () => {
  it('lists the accessibility and payment attributes the place HAS, by the strongest assertion', () => {
    const attributes = visitAttributes(
      {
        capabilities: [
          capability('accessibility.wheelchair', 'limited'),
          capability('accessibility.hearing_loop', false),
          capability('payments.cards', true),
          // A business "no" outranks a community "yes".
          capability('payments.cash', true, 'community_reported'),
          capability('payments.cash', false, 'business_asserted'),
          // Neither group: not a visit fact.
          capability('commerce.mercaria.store', 'loc_1'),
        ],
      },
      'en',
    );
    // GoWay's registry owns the words; the derivation only chooses which keys.
    expect(attributes).toEqual([
      {
        group: 'accessibility',
        key: 'accessibility.wheelchair',
        label: capabilityLabel('accessibility.wheelchair', 'en'),
        valueLabel: capabilityValueLabel('accessibility.wheelchair', 'limited', 'en'),
      },
      { group: 'payment', key: 'payments.cards', label: capabilityLabel('payments.cards', 'en') },
    ]);
  });

  it('leaves out an enum value that says the place does NOT have it', () => {
    expect(visitAttributes({ capabilities: [capability('accessibility.wheelchair', 'no')] }, 'en')).toEqual([]);
  });
});

describe('visitPhotos', () => {
  function media(id: string, kind: PlaceMedia['kind'], position: number): PlaceMedia {
    return {
      id,
      placeId: 'plc_1',
      fileId: `file-${id}`,
      kind,
      verification: 'business_asserted',
      position,
      createdAt: OBSERVED,
    };
  }

  it('keeps the shop’s own photos in the business’s order, never its logo or menu', () => {
    const photos = visitPhotos([
      media('b', 'interior', 2),
      media('logo', 'logo', 0),
      media('a', 'exterior', 1),
      media('menu', 'menu', 3),
    ]);
    expect(photos.map((photo) => photo.id)).toEqual(['a', 'b']);
  });

  it('stops at eight', () => {
    expect(visitPhotos(Array.from({ length: 12 }, (_, i) => media(`p${i}`, 'photo', i)))).toHaveLength(8);
  });
});
