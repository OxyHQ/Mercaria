/**
 * Opening hours, in the shop's OWN zone (#93).
 *
 * The fixtures that matter are the ones a naive implementation would pass
 * anyway, so each is chosen to break one:
 *
 *  - a summer instant AND a winter one in `Europe/Madrid`, which differ by an
 *    hour of UTC offset. A stored offset — or a `Date#getHours()` read against
 *    the server's own zone — agrees with the truth for half the year, and a
 *    single-season fixture cannot tell that apart from a correct answer.
 *  - a timezone `Intl` refuses, which must answer `{ known: false }` rather
 *    than falling back to UTC and reporting a shop shut when it is open.
 *  - a shop with NO hours at all, which must not read as "never open" — that
 *    is an empty form, not a closed business.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_HORIZON_HOURS,
  deriveLocationOpenState,
  opensWithin,
  type LocationSchedule,
} from '../hours.js';

/** Nine to five, Monday to Friday, in Barcelona. */
const MADRID: LocationSchedule = {
  timezone: 'Europe/Madrid',
  hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 9 * 60, closesMinute: 17 * 60 })),
  closures: [],
};

describe('deriveLocationOpenState', () => {
  it('reads the SUMMER offset correctly (CEST, UTC+2)', () => {
    // 2026-08-10 is a Monday. 08:00Z is 10:00 local — open.
    expect(deriveLocationOpenState(MADRID, new Date('2026-08-10T08:00:00Z'))).toEqual({
      known: true,
      open: true,
      changesAt: '17:00',
    });
  });

  it('reads the WINTER offset correctly (CET, UTC+1)', () => {
    // 2026-01-12 is a Monday. 08:00Z is 09:00 local — open, and the SAME UTC
    // instant that a fixed +02:00 offset would put at 10:00. An implementation
    // carrying one offset agrees with the summer case above and disagrees here.
    expect(deriveLocationOpenState(MADRID, new Date('2026-01-12T08:00:00Z'))).toEqual({
      known: true,
      open: true,
      changesAt: '17:00',
    });
    // And the discriminating pair: 07:30Z is 08:30 local in winter — CLOSED —
    // while it is 09:30 and open in summer.
    expect(deriveLocationOpenState(MADRID, new Date('2026-01-12T07:30:00Z'))).toEqual({
      known: true,
      open: false,
      changesAt: '09:00',
    });
    expect(deriveLocationOpenState(MADRID, new Date('2026-08-10T07:30:00Z'))).toEqual({
      known: true,
      open: true,
      changesAt: '17:00',
    });
  });

  it('is closed on a weekday with no interval, and says nothing about when', () => {
    // 2026-08-09 is a Sunday.
    expect(deriveLocationOpenState(MADRID, new Date('2026-08-09T10:00:00Z'))).toEqual({
      known: true,
      open: false,
    });
  });

  it('lets a dated closure beat the schedule, and carries its note', () => {
    const schedule: LocationSchedule = {
      ...MADRID,
      closures: [{ id: 'c1', fromDate: '2026-08-10', throughDate: '2026-08-14', note: 'Refit' }],
    };
    expect(deriveLocationOpenState(schedule, new Date('2026-08-10T08:00:00Z'))).toEqual({
      known: true,
      open: false,
      closureNote: 'Refit',
    });
  });

  it('answers UNKNOWN for a zone this runtime does not recognise', () => {
    // Not `open: false`. A shop taken off the map for a zone string is worse
    // than one shown with an unknown state.
    expect(
      deriveLocationOpenState({ ...MADRID, timezone: 'Mars/Olympus_Mons' }, new Date()),
    ).toEqual({ known: false });
  });

  it('handles a split shift', () => {
    const schedule: LocationSchedule = {
      timezone: 'Europe/Madrid',
      hours: [
        { weekday: 1, opensMinute: 9 * 60, closesMinute: 13 * 60 },
        { weekday: 1, opensMinute: 16 * 60, closesMinute: 20 * 60 },
      ],
      closures: [],
    };
    // 12:00Z = 14:00 local — inside the siesta.
    expect(deriveLocationOpenState(schedule, new Date('2026-08-10T12:00:00Z'))).toEqual({
      known: true,
      open: false,
      changesAt: '16:00',
    });
  });
});

describe('opensWithin', () => {
  it('is true for a shop that is shut NOW but opens tomorrow', () => {
    // 22:00 local on a Monday. Closed, and a nearby search at that hour must
    // still show it — otherwise the feature is useless in the evening, which
    // is when people browse.
    expect(opensWithin(MADRID, new Date('2026-08-10T20:00:00Z'), DEFAULT_OPEN_HORIZON_HOURS)).toBe(
      true,
    );
  });

  it('is FALSE for a shop closed across the whole horizon', () => {
    const schedule: LocationSchedule = {
      ...MADRID,
      // The closure has to cover the WHOLE horizon (7 days from the clock), and
      // both its dates and the clock's own week are pinned in the PAST — a
      // fixture whose end date the real clock is still travelling toward
      // passes today and breaks CI for whoever pushes on the day it arrives.
      closures: [{ id: 'c1', fromDate: '2026-08-01', throughDate: '2026-08-11' }],
    };
    expect(opensWithin(schedule, new Date('2026-08-03T08:00:00Z'), DEFAULT_OPEN_HORIZON_HOURS)).toBe(
      false,
    );
  });

  it('treats an EMPTY schedule as open, not as never open', () => {
    // A merchant who published a collection point and no hours has told us
    // nothing about when it is shut. Inventing "never" from silence would
    // delist them for an empty form.
    expect(
      opensWithin({ timezone: 'Europe/Madrid', hours: [], closures: [] }, new Date(), 24),
    ).toBe(true);
  });

  it('treats an UNKNOWN zone as open, for the same reason', () => {
    expect(opensWithin({ ...MADRID, timezone: 'Nowhere/At_All' }, new Date(), 24)).toBe(true);
  });
});
