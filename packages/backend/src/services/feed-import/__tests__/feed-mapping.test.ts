/**
 * The mapping engine, the money reader, the transforms and the external id
 * (#63 processing 2, 3 and 4, Mapping UX 4).
 *
 * The fixture rule `~/Oxy/AGENTS.md` (E) states applies throughout: every check
 * that narrows or normalizes gets a fixture in the shape that makes the strict
 * and loose readings DISAGREE. A money reader tested only on `19.99` cannot tell
 * string arithmetic from floating point; an external id tested only on
 * single-column keys cannot tell an injective join from a naive one.
 */

import { describe, expect, it } from 'vitest';
import type { FeedFieldMapping, FeedFieldRole } from '@mercaria/shared-types';
import { deriveFeedExternalId } from '../external-id.js';
import { mapFeedRecord, type ResolvedFeedMapping } from '../mapping.js';
import { parseFeedMoney } from '../money.js';
import { applyFeedTransform } from '../transforms.js';
import { suggestFeedFieldMappings } from '../suggest.js';
import type { FeedRawRecord } from '../parse/index.js';

function mapping(
  fields: readonly FeedFieldMapping[],
  overrides: Partial<ResolvedFeedMapping> = {},
): ResolvedFeedMapping {
  return {
    fieldMappings: new Map<FeedFieldRole, FeedFieldMapping>(
      fields.map((entry) => [entry.role, entry]),
    ),
    valueMappings: new Map(),
    identityKeyFields: ['id'],
    listSeparator: ',',
    defaultCurrency: null,
    defaultCountry: null,
    defaultLanguage: null,
    ...overrides,
  };
}

function record(fields: Record<string, string>, index = 0): FeedRawRecord {
  return { index, fields: new Map(Object.entries(fields)) };
}

describe('the money reader', () => {
  it('reads major units at the currency’s own precision, half-up, in string arithmetic', () => {
    // `Math.round(1.0050 * 100)` is 100 in IEEE-754 and 101 here, which is the
    // whole reason the conversion is textual. Four decimals rather than three,
    // because three trailing digits are a GROUPING separator by the rule below.
    expect(parseFeedMoney({ amountText: '1.0050', currencyText: 'EUR', defaultCurrency: null, minorUnits: false })).toEqual({
      kind: 'money',
      money: { amount: 101, currency: 'EUR' },
    });
    expect(parseFeedMoney({ amountText: '19.99', currencyText: 'EUR', defaultCurrency: null, minorUnits: false })).toEqual({
      kind: 'money',
      money: { amount: 1_999, currency: 'EUR' },
    });
  });

  it('resolves all three separator conventions', () => {
    const cases: readonly [string, number][] = [
      ['1,234.56', 123_456],
      ['1.234,56', 123_456],
      ['19,99', 1_999],
      // A single separator with exactly three trailing digits is a GROUPING
      // separator: `1,999` is one thousand nine hundred and ninety-nine.
      ['1,999', 199_900],
      ['1.999', 199_900],
      // The cost of that rule, asserted rather than left implicit: a genuine
      // three-decimal value in a two-decimal currency is read as thousands.
      // `1.005` meaning one euro and half a cent is not a price anybody
      // publishes; `1.005` meaning one thousand and five is every European feed.
      ['1.005', 100_500],
    ];
    for (const [text, expected] of cases) {
      expect(
        parseFeedMoney({ amountText: text, currencyText: 'EUR', defaultCurrency: null, minorUnits: false }),
      ).toEqual({ kind: 'money', money: { amount: expected, currency: 'EUR' } });
    }
  });

  it('takes the currency from the value itself before the column or the default', () => {
    expect(
      parseFeedMoney({ amountText: '19.99 USD', currencyText: 'EUR', defaultCurrency: 'GBP', minorUnits: false }),
    ).toEqual({ kind: 'money', money: { amount: 1_999, currency: 'USD' } });
    expect(
      parseFeedMoney({ amountText: 'USD 19.99', currencyText: null, defaultCurrency: 'GBP', minorUnits: false }),
    ).toEqual({ kind: 'money', money: { amount: 1_999, currency: 'USD' } });
  });

  it('honours a ZERO-decimal currency rather than assuming cents', () => {
    expect(
      parseFeedMoney({ amountText: '1500', currencyText: 'JPY', defaultCurrency: null, minorUnits: false }),
    ).toEqual({ kind: 'money', money: { amount: 1_500, currency: 'JPY' } });
  });

  it('refuses an unlistable currency by NAME, and accepts it in minor units', () => {
    const refused = parseFeedMoney({
      amountText: '19.99',
      currencyText: 'XYZ',
      defaultCurrency: null,
      minorUnits: false,
    });
    expect(refused).toEqual({ kind: 'refused', failure: 'unsupported_currency', token: 'XYZ' });
    // The escape hatch: a column already in minor units needs no precision.
    expect(
      parseFeedMoney({ amountText: '1999', currencyText: 'XYZ', defaultCurrency: null, minorUnits: true }),
    ).toEqual({ kind: 'money', money: { amount: 1_999, currency: 'XYZ' } });
  });

  it('refuses a missing currency, a negative amount and unparseable text', () => {
    expect(
      parseFeedMoney({ amountText: '19.99', currencyText: null, defaultCurrency: null, minorUnits: false }).kind,
    ).toBe('refused');
    expect(
      parseFeedMoney({ amountText: '-5.00', currencyText: 'EUR', defaultCurrency: null, minorUnits: false }),
    ).toEqual({ kind: 'refused', failure: 'negative_amount' });
    expect(
      parseFeedMoney({ amountText: 'call for price', currencyText: 'EUR', defaultCurrency: null, minorUnits: false }),
    ).toEqual({ kind: 'refused', failure: 'unparseable_number' });
  });
});

describe('the deterministic external id', () => {
  it('is stable across deliveries and derived from the key columns alone', () => {
    const first = deriveFeedExternalId(new Map([['id', 'SKU-1'], ['title', 'A']]), ['id']);
    const second = deriveFeedExternalId(new Map([['id', 'SKU-1'], ['title', 'B changed']]), ['id']);
    expect(first).toEqual({ kind: 'derived', externalId: 'SKU-1' });
    expect(second).toEqual(first);
  });

  it('joins a COMPOSITE key injectively', () => {
    // The fixture that makes a naive join and an escaping one disagree: without
    // escaping, `('a', 'b|c')` and `('a|b', 'c')` collide — which is two of a
    // merchant's products sharing one source object.
    const left = deriveFeedExternalId(new Map([['a', 'a'], ['b', 'b|c']]), ['a', 'b']);
    const right = deriveFeedExternalId(new Map([['a', 'a|b'], ['b', 'c']]), ['a', 'b']);
    expect(left.kind).toBe('derived');
    expect(right.kind).toBe('derived');
    expect(left).not.toEqual(right);
  });

  it('digests a key past the readable bound, under a distinguishable prefix', () => {
    const long = deriveFeedExternalId(new Map([['id', 'x'.repeat(400)]]), ['id']);
    expect(long.kind).toBe('derived');
    if (long.kind === 'derived') expect(long.externalId).toMatch(/^k:[0-9a-f]{64}$/u);
  });

  it('REFUSES rather than deriving from the columns that happened to be present', () => {
    const result = deriveFeedExternalId(new Map([['a', 'only-a']]), ['a', 'b']);
    expect(result).toEqual({ kind: 'incomplete', failure: { missingField: 'b' } });
  });
});

describe('the transforms', () => {
  it('are total functions of one string with no configuration', () => {
    expect(applyFeedTransform('  spaced  out ', 'collapse_whitespace', ',')).toBe('spaced out');
    expect(applyFeedTransform('978-0-13-235088-4', 'strip_identifier_separators', ',')).toBe(
      '9780132350884',
    );
    expect(applyFeedTransform('a.jpg , b.jpg ,', 'split_list', ',')).toBe('a.jpg,b.jpg');
    expect(applyFeedTransform('a.jpg,b.jpg', 'first_of_list', ',')).toBe('a.jpg');
    expect(applyFeedTransform('<p>Bold &amp; brave</p>', 'strip_html', ',')).toBe('Bold & brave');
    // A `<` that is not a tag survives, which is what a size description needs.
    expect(applyFeedTransform('12 < 15 cm', 'strip_html', ',')).toBe('12 < 15 cm');
  });
});

describe('the mapping engine', () => {
  it('produces a normalized record and no issues from a well-formed row', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: 'Blue widget', p: '19.99', c: 'EUR', gt: '5901234123457' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'price', sourceField: 'p' },
        { role: 'price_currency', sourceField: 'c' },
        { role: 'gtin', sourceField: 'gt' },
      ]),
    );
    expect(mapped.issues).toEqual([]);
    expect(mapped.externalId).toBe('1');
    expect(mapped.normalized?.title).toBe('Blue widget');
    expect(mapped.normalized?.price).toEqual({ amount: 1_999, currency: 'EUR' });
    expect(mapped.normalized?.identifiers).toEqual([{ scheme: 'gtin', value: '5901234123457' }]);
  });

  it('ISOLATES a row with no title: an error, no record, and the pass continues', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: '   ' }),
      mapping([{ role: 'title', sourceField: 'name' }]),
    );
    expect(mapped.normalized).toBeNull();
    expect(mapped.issues).toHaveLength(1);
    expect(mapped.issues[0]?.code).toBe('missing_required_field');
    expect(mapped.issues[0]?.severity).toBe('error');
  });

  it('keeps the record when a PRICE is unreadable, and reports a warning', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: 'A', p: 'call us' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'price', sourceField: 'p' },
        { role: 'price_currency', constantValue: 'EUR' },
      ]),
    );
    expect(mapped.normalized).not.toBeNull();
    expect(mapped.normalized?.price).toBeUndefined();
    expect(mapped.issues.map((issue) => issue.code)).toEqual(['unparseable_number']);
    expect(mapped.issues[0]?.severity).toBe('warning');
  });

  it('maps a SALE price onto the payable price and the list price onto compareAt', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: 'A', p: '30.00', s: '19.99' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'price', sourceField: 'p' },
        { role: 'sale_price', sourceField: 's' },
        { role: 'price_currency', constantValue: 'EUR' },
        { role: 'sale_price_currency', constantValue: 'EUR' },
      ]),
    );
    expect(mapped.normalized?.price).toEqual({ amount: 1_999, currency: 'EUR' });
    expect(mapped.normalized?.compareAtPrice).toEqual({ amount: 3_000, currency: 'EUR' });
  });

  it('drops a malformed identifier with a warning rather than asserting it', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: 'A', gt: '12345' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'gtin', sourceField: 'gt' },
      ]),
    );
    expect(mapped.normalized?.identifiers).toEqual([]);
    expect(mapped.issues.map((issue) => issue.code)).toEqual(['invalid_identifier']);
  });

  it('drops a non-http URL rather than rendering it', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: 'A', img: 'javascript:alert(1)' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'image', sourceField: 'img' },
      ]),
    );
    expect(mapped.normalized?.media).toEqual([]);
    expect(mapped.issues.map((issue) => issue.code)).toEqual(['invalid_url']);
  });

  it('reads an availability synonym, prefers the merchant’s value map, and reports the rest', () => {
    const withMap = mapping(
      [
        { role: 'title', sourceField: 'name' },
        { role: 'availability', sourceField: 'av' },
      ],
      { valueMappings: new Map([['availability:agotado', 'out_of_stock']]) },
    );
    expect(
      mapFeedRecord(record({ id: '1', name: 'A', av: 'In Stock' }), withMap).normalized
        ?.availability,
    ).toBe('in_stock');
    expect(
      mapFeedRecord(record({ id: '1', name: 'A', av: 'Agotado' }), withMap).normalized
        ?.availability,
    ).toBe('out_of_stock');

    // A word neither the synonyms nor the merchant's table knows is UNKNOWN
    // (absent), never guessed — with the token carried, because it comes from a
    // closed external vocabulary.
    const unmapped = mapFeedRecord(record({ id: '1', name: 'A', av: 'backorder' }), withMap);
    expect(unmapped.normalized?.availability).toBeUndefined();
    expect(unmapped.issues[0]?.code).toBe('unknown_availability');
    expect(unmapped.issues[0]?.observedToken).toBe('backorder');
  });

  it('stores a condition label VERBATIM and warns only when a translation table exists', () => {
    const withoutTable = mapFeedRecord(
      record({ id: '1', name: 'A', cond: 'Reacondicionado' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'condition', sourceField: 'cond' },
      ]),
    );
    expect(withoutTable.normalized?.conditionLabel).toBe('Reacondicionado');
    expect(withoutTable.issues).toEqual([]);

    const withTable = mapFeedRecord(
      record({ id: '1', name: 'A', cond: 'Reacondicionado' }),
      mapping(
        [
          { role: 'title', sourceField: 'name' },
          { role: 'condition', sourceField: 'cond' },
        ],
        { valueMappings: new Map([['condition:nuevo', 'new']]) },
      ),
    );
    expect(withTable.issues.map((issue) => issue.code)).toEqual(['unknown_condition']);
  });

  it('fills three option slots from a constant NAME and a column VALUE', () => {
    const mapped = mapFeedRecord(
      record({ id: '1', name: 'A', colour: 'Black', size: 'M' }),
      mapping([
        { role: 'title', sourceField: 'name' },
        { role: 'option_name_1', constantValue: 'Colour' },
        { role: 'option_value_1', sourceField: 'colour' },
        { role: 'option_name_2', constantValue: 'Size' },
        { role: 'option_value_2', sourceField: 'size' },
      ]),
    );
    expect(mapped.normalized?.options).toEqual([
      { name: 'Colour', value: 'Black' },
      { name: 'Size', value: 'M' },
    ]);
  });

  it('reports a malformed record as ONE error rather than dropping it silently', () => {
    const mapped = mapFeedRecord(record({ __malformed__: 'unparseable' }), mapping([]));
    expect(mapped.normalized).toBeNull();
    expect(mapped.issues.map((issue) => issue.code)).toEqual(['malformed_record']);
  });
});

describe('mapping suggestions', () => {
  it('suggests without applying, and records WHY each suggestion was made', () => {
    const suggestions = suggestFeedFieldMappings([
      'title',
      'image_link',
      'g:price',
      'Sale Price',
      'unrecognised_column',
    ]);
    const byField = new Map(suggestions.map((suggestion) => [suggestion.sourceField, suggestion]));
    expect(byField.get('title')?.basis).toBe('exact_role_name');
    expect(byField.get('image_link')).toEqual({
      role: 'image',
      sourceField: 'image_link',
      basis: 'google_merchant_alias',
    });
    expect(byField.get('g:price')?.role).toBe('price');
    expect(byField.get('Sale Price')?.role).toBe('sale_price');
    expect(byField.has('unrecognised_column')).toBe(false);
  });

  it('claims each role at most once, first column wins', () => {
    const suggestions = suggestFeedFieldMappings(['title', 'name']);
    expect(suggestions.filter((suggestion) => suggestion.role === 'title')).toHaveLength(1);
    expect(suggestions[0]?.sourceField).toBe('title');
  });
});
