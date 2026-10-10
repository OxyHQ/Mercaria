/**
 * The shared readers every open-data provider leans on — money above all,
 * because a separator read the wrong way is a price a thousand times off.
 */

import { describe, expect, it } from 'vitest';
import { asDate, asNumber, decimalMoney, FactCollector, factKeySegment, gtinDigits, minorMoney, subFeedKey } from '../read.js';
import { madridTimestamp } from '../providers/miteco-fuel.js';

describe('decimalMoney reads MACHINE decimals, never human grouping', () => {
  it('reads Open Prices "1.250" as one euro twenty-five, not 1,250 euros', () => {
    expect(decimalMoney('1.250', 'EUR')).toEqual({ amount: 125, currency: 'EUR' });
  });

  it('reads MITECO "2,095" with a comma separator, half-up to the cent', () => {
    expect(decimalMoney('2,095', 'EUR', ',')).toEqual({ amount: 210, currency: 'EUR' });
    expect(decimalMoney('1,849', 'EUR', ',')).toEqual({ amount: 185, currency: 'EUR' });
    expect(decimalMoney('1,844', 'EUR', ',')).toEqual({ amount: 184, currency: 'EUR' });
  });

  it('reads a JSON number without float drift', () => {
    expect(decimalMoney(9.69, 'EUR')).toEqual({ amount: 969, currency: 'EUR' });
    expect(decimalMoney(0.1 + 0.2, 'EUR')).toEqual({ amount: 30, currency: 'EUR' });
  });

  it('honours a currency with no minor unit', () => {
    expect(decimalMoney('1500', 'JPY')).toEqual({ amount: 1500, currency: 'JPY' });
  });

  it('refuses rather than inventing a price', () => {
    expect(decimalMoney('-1.00', 'EUR')).toBeUndefined();
    expect(decimalMoney('1,999.00', 'EUR')).toBeUndefined();
    expect(decimalMoney('abc', 'EUR')).toBeUndefined();
    expect(decimalMoney('1.00', undefined)).toBeUndefined();
    expect(decimalMoney('1.00', 'XXX')).toBeUndefined();
    expect(decimalMoney('', 'EUR')).toBeUndefined();
  });

  it('reads minor units verbatim', () => {
    expect(minorMoney(969, 'eur')).toEqual({ amount: 969, currency: 'EUR' });
    expect(minorMoney(9.5, 'EUR')).toBeUndefined();
  });
});

describe('the scalar readers', () => {
  it('reads numbers in either separator and nothing else', () => {
    expect(asNumber('40,526722', ',')).toBeCloseTo(40.526722);
    expect(asNumber('4')).toBe(4);
    expect(asNumber('4 g')).toBeUndefined();
    expect(asNumber(Number.NaN)).toBeUndefined();
  });

  it('takes only GTIN-shaped digit strings', () => {
    expect(gtinDigits('8480000160164')).toBe('8480000160164');
    expect(gtinDigits(' 848-0000-160164 ')).toBe('8480000160164');
    expect(gtinDigits('ABC123')).toBeUndefined();
    expect(gtinDigits('1234567')).toBeUndefined();
  });

  it('reads a bare date as UTC midnight', () => {
    expect(asDate('2026-10-01')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(asDate('not a date')).toBeUndefined();
  });

  it('folds a provider field name into an ASCII fact-key segment, and nothing else', () => {
    expect(factKeySegment('energy-kcal')).toBe('energy_kcal');
    expect(factKeySegment('Energy (kcal)')).toBe('energy_kcal');
    // A person's words never become a fact key: non-ASCII is dropped, and a
    // key that folds to nothing is refused by normalization downstream.
    expect(factKeySegment('Пятёрочка')).toBe('');
  });

  it('keys a chain written in any script, folding only Latin accents', () => {
    expect(subFeedKey('Mercadona')).toBe('mercadona');
    expect(subFeedKey('Carrefour Express')).toBe('carrefour_express');
    expect(subFeedKey('BonÀrea')).toBe('bonarea');
    expect(subFeedKey('  Mercadona  Parking ')).toBe('mercadona_parking');
    // One chain per script: each must key to something non-empty and distinct,
    // or two chains would share one source.
    const chains = ['Пятёрочка', 'كارفور', 'স্বপ্ন', 'बिग बाज़ार', '永辉超市', 'イオン', 'ひまわり'];
    const keys = chains.map(subFeedKey);
    for (const key of keys) expect(key.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(chains.length);
    expect(subFeedKey('Пятёрочка')).toBe('пятёрочка');
    expect(subFeedKey('イオン')).toBe('イオン');
    expect(subFeedKey('बिग बाज़ार')).toBe(subFeedKey(subFeedKey('बिग बाज़ार')));
  });
});

describe('FactCollector', () => {
  it('namespaces keys and skips every absent value', () => {
    const facts = new FactCollector('demo')
      .add('present', 'yes')
      .add('nothing', undefined)
      .add('blank', '  ')
      .add('empty_list', [])
      .number('weight', '400', 'g')
      .number('not_a_number', 'heavy')
      .flag('flag', true)
      .flag('not_a_flag', 'true')
      .list('tags', ['a', '', 'b'])
      .toArray();
    expect(facts).toEqual([
      { key: 'demo.present', value: 'yes' },
      { key: 'demo.weight', value: 400, unit: 'g' },
      { key: 'demo.flag', value: true },
      { key: 'demo.tags', value: ['a', 'b'] },
    ]);
  });
});

describe('madridTimestamp', () => {
  it('reads summer time (UTC+2)', () => {
    expect(madridTimestamp('10/08/2025 4:03:28')?.toISOString()).toBe('2025-08-10T02:03:28.000Z');
  });

  it('reads winter time (UTC+1)', () => {
    expect(madridTimestamp('15/01/2026 12:00:00')?.toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('refuses anything else', () => {
    expect(madridTimestamp('2025-10-10')).toBeUndefined();
    expect(madridTimestamp(undefined)).toBeUndefined();
  });
});
