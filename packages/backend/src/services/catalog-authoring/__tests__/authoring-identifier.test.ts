/**
 * `classifyBarcode` and the scheme map it reads (#367 workstream 7).
 *
 * The interesting thing here is not that the arithmetic works — that is
 * `services/canonical/__tests__/identifiers.test.ts`'s, and this module
 * deliberately owns none of it. It is that `GTIN_SCHEME_BY_LENGTH` is a HAND
 * MAP over a registry that can grow, and a hand map is blind in the ADD
 * direction: a fifth GS1 scheme added to `IDENTIFIER_SCHEME_REGISTRY` would
 * simply never be reachable from authoring, silently, with every case in this
 * file still green.
 *
 * So the population is DERIVED from the registry and the map is measured
 * against it, with the two absences named rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import {
  IDENTIFIER_SCHEME_REGISTRY,
  type IdentifierScheme,
} from '@mercaria/shared-types';
import { gs1CheckDigit } from '../../canonical/identifiers.js';
import {
  GTIN_SCHEME_BY_LENGTH,
  classifyBarcode,
  identifierIsGloballyUnique,
} from '../identifier.js';

/** A payload of `length - 1` digits plus the check digit it really needs. */
function validGtin(length: number): string {
  const payload = Array.from({ length: length - 1 }, (_, index) => String((index * 3) % 10)).join(
    '',
  );
  return `${payload}${gs1CheckDigit(payload)}`;
}

describe('the scheme map is measured against the registry, not asserted', () => {
  /**
   * Registry schemes that normalize to a GTIN and declare a digit length — the
   * complete population a length-keyed map could possibly serve.
   */
  const gtinSchemes = (Object.keys(IDENTIFIER_SCHEME_REGISTRY) as IdentifierScheme[]).filter(
    (scheme) => {
      const definition = IDENTIFIER_SCHEME_REGISTRY[scheme];
      return definition.canonicalScheme === 'gtin' && definition.digitLength !== undefined;
    },
  );

  /**
   * The registry schemes the map deliberately does NOT serve, each with the
   * reason. Asserted at an exact length, or it erodes to "all of them".
   */
  const NOT_INFERRED: Readonly<Record<string, string>> = {
    isbn10:
      'ten digits, and there is no ten-digit GS1 scheme — so a ten-digit barcode is either an ' +
      'ISBN-10 or a code system Mercaria does not model, and inferring the first would refuse ' +
      'the second by arithmetic it never agreed to. An ISBN reaches this path as its 13-digit ' +
      'form, which IS an EAN-13.',
    isbn13:
      'thirteen digits, which `ean` already serves with the identical check digit over the ' +
      'identical string. Choosing `isbn13` for all thirteen-digit values would additionally ' +
      'raise `not_an_isbn_prefix` for every grocery item — a refusal of a valid barcode.',
  };

  it('serves every GTIN scheme the registry declares, or names why not', () => {
    // A vacuity floor: a registry that returned nothing would make the walk
    // below assert nothing at all and report clean.
    expect(gtinSchemes.length).toBeGreaterThanOrEqual(6);

    const served = new Set(Object.values(GTIN_SCHEME_BY_LENGTH));
    const unserved = gtinSchemes.filter(
      (scheme) => !served.has(scheme) && NOT_INFERRED[scheme] === undefined,
    );
    expect(
      unserved,
      'these GTIN schemes are in the registry and authoring can never reach one',
    ).toEqual([]);

    expect(Object.keys(NOT_INFERRED)).toHaveLength(2);
    for (const scheme of Object.keys(NOT_INFERRED)) {
      expect(gtinSchemes, `${scheme} is excused and is not in the registry`).toContain(scheme);
      expect(served.has(scheme as IdentifierScheme), `${scheme} is excused and IS served`).toBe(
        false,
      );
    }
  });

  it('keys each scheme at the length the REGISTRY gives it, not at a pasted number', () => {
    // The map is `length -> scheme`; this is the other direction, and it is
    // what a copy-paste error would break. A `13: 'upc'` entry would classify
    // every EAN as a twelve-digit number and refuse all of them.
    for (const [length, scheme] of Object.entries(GTIN_SCHEME_BY_LENGTH)) {
      expect({ length, declared: IDENTIFIER_SCHEME_REGISTRY[scheme].digitLength }).toEqual({
        length,
        declared: Number(length),
      });
    }
    expect(Object.keys(GTIN_SCHEME_BY_LENGTH).length).toBeGreaterThanOrEqual(4);
  });

  it('serves only globally unique schemes, which is what makes a repeat worth reporting', () => {
    // `validation.ts` reports two variants sharing a barcode BECAUSE the
    // registry declares the scheme globally unique. If the map ever served a
    // scheme that is not — an MPN, say, which two variants of one product share
    // routinely — that finding would be noise on every draft, and this is where
    // it shows up rather than in a merchant's list of complaints.
    for (const scheme of Object.values(GTIN_SCHEME_BY_LENGTH)) {
      expect({ scheme, unique: identifierIsGloballyUnique(scheme) }).toEqual({
        scheme,
        unique: true,
      });
    }
    // The positive control for `identifierIsGloballyUnique` itself: a function
    // that returned `true` unconditionally would satisfy the loop above.
    expect(identifierIsGloballyUnique('mpn')).toBe(false);
    expect(identifierIsGloballyUnique('brand_model')).toBe(false);
  });
});

describe('classifyBarcode answers three different things', () => {
  it('carries BOTH stored forms for a valid GTIN, and the canonical one is padded to 14', () => {
    // The canonical form is what the collision read compares on, so a
    // classification that dropped it would make the collision check silently
    // compare nothing.
    for (const length of [8, 12, 13, 14]) {
      const gtin = validGtin(length);
      const result = classifyBarcode(gtin);
      expect({ length, kind: result.kind }).toEqual({ length, kind: 'valid' });
      if (result.kind !== 'valid') continue;
      expect({ length, normalized: result.normalizedValue }).toEqual({ length, normalized: gtin });
      expect({ length, canonical: result.canonicalValue }).toEqual({
        length,
        canonical: gtin.padStart(14, '0'),
      });
    }
  });

  it('separates "not an identifier" from "an identifier that is wrong"', () => {
    // The distinction is the whole reason the union has three members rather
    // than two: `unrecognized` reports nothing and `invalid` reports a finding,
    // and collapsing them would either refuse every merchant part number or
    // admit every mistyped GTIN.
    expect(classifyBarcode('ACME-PART-9').kind).toBe('unrecognized');
    expect(classifyBarcode('1234567890').kind).toBe('unrecognized');
    expect(classifyBarcode(null).kind).toBe('unrecognized');
    expect(classifyBarcode('   ').kind).toBe('unrecognized');

    const good = validGtin(13);
    const bad = `${good.slice(0, -1)}${(Number(good.slice(-1)) + 1) % 10}`;
    expect(classifyBarcode(bad).kind).toBe('invalid');
    expect(classifyBarcode(good).kind).toBe('valid');
  });

  it('reaches the same verdict for a scanned and a keyed spelling', () => {
    const gtin = validGtin(13);
    const scanned = classifyBarcode(gtin);
    const keyed = classifyBarcode(` ${gtin.slice(0, 3)}-${gtin.slice(3)} `);
    expect(keyed).toEqual(scanned);
  });
});
