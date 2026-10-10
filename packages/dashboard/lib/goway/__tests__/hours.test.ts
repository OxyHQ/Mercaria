/**
 * The week editor's seven lines ↔ GoWay's weekly intervals.
 *
 * The round trip is the property worth holding: a merchant who opens the
 * editor and saves without touching anything must send back exactly the hours
 * the place already had, or every save quietly rewrites a shop's week.
 */

import { describe, expect, it } from 'vitest';
import { intervalsOf, parseRanges, weekTextOf, type WeekText } from '../hours';

describe('parseRanges', () => {
  it('reads a split shift, pads a one-digit hour and accepts an en dash', () => {
    expect(parseRanges('9:00-14:00, 17:00–20:30')).toEqual([
      { opens: '09:00', closes: '14:00' },
      { opens: '17:00', closes: '20:30' },
    ]);
  });

  it('reads an empty line as a closed day, not as unreadable', () => {
    expect(parseRanges('   ')).toEqual([]);
  });

  it('keeps a span across midnight, which GoWay reads as closes <= opens', () => {
    expect(parseRanges('20:00-02:00')).toEqual([{ opens: '20:00', closes: '02:00' }]);
  });

  it.each(['9-14', '09:00', '24:00-25:00', '09:00-14:00-18:00', 'closed'])('refuses %s', (text) => {
    expect(parseRanges(text)).toBeNull();
  });
});

describe('weekTextOf and intervalsOf', () => {
  it('round-trips a week untouched', () => {
    const intervals = [
      { day: 1, opens: '09:00', closes: '14:00' },
      { day: 1, opens: '17:00', closes: '20:00' },
      { day: 6, opens: '10:00', closes: '14:00' },
    ] as const;
    const week = weekTextOf([...intervals]);
    expect(week[1]).toBe('09:00-14:00, 17:00-20:00');
    expect(week[0]).toBe('');
    const back = intervalsOf(week);
    expect(
      back.ok &&
        [...back.intervals].sort((a, b) => a.day - b.day || a.opens.localeCompare(b.opens)),
    ).toEqual([...intervals]);
  });

  it('names the first unreadable day instead of sending a partial week', () => {
    const week: WeekText = {
      0: '',
      1: '09:00-14:00',
      2: 'nine to five',
      3: '',
      4: '',
      5: '',
      6: '',
    };
    expect(intervalsOf(week)).toEqual({ ok: false, day: 2 });
  });
});
