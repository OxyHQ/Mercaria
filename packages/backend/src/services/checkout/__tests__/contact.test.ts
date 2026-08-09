/**
 * Address and contact normalization (#105 "Address and contact validation").
 *
 * The fixtures here follow `~/Oxy/AGENTS.md`'s rule about narrowing checks: for
 * every check that NORMALIZES or NARROWS, at least one fixture is in the shape
 * that makes the strict and loose readings DISAGREE. A suite of already-clean
 * addresses cannot tell "we NFC-normalize" from "we do nothing", and a suite of
 * already-lowercase emails cannot tell a display form from a lookup form.
 */

import { describe, expect, it } from 'vitest';
import type { CheckoutAddressInput } from '@mercaria/shared-types';
import {
  canonicalizePhone,
  isIsoAlpha2Country,
  normalizeCheckoutAddress,
  normalizeCheckoutContact,
} from '../contact.js';

/** A valid Spanish address; individual cases override one field at a time. */
function address(overrides: Partial<CheckoutAddressInput> = {}): CheckoutAddressInput {
  return {
    recipientName: 'Jane Doe',
    line1: 'Carrer de Colon 1',
    city: 'Valencia',
    postalCode: '46004',
    country: 'ES',
    ...overrides,
  };
}

describe('country validation', () => {
  it('accepts an assigned ISO-3166 alpha-2 code and upper-cases it', () => {
    expect(normalizeCheckoutAddress(address({ country: 'es' })).country).toBe('ES');
  });

  it('refuses an unassigned two-letter code rather than length-checking it', () => {
    // `ZZ` is user-assigned/private-use: two letters, correct SHAPE, and not a
    // country. A length check would accept it, which is the whole distinction
    // this fixture exists to make.
    expect(() => normalizeCheckoutAddress(address({ country: 'ZZ', postalCode: '1234' }))).toThrow(
      /ISO-3166/,
    );
    expect(isIsoAlpha2Country('ZZ')).toBe(false);
    expect(isIsoAlpha2Country('ES')).toBe(true);
  });
});

describe('postal-code validation is country-aware and only where reliable', () => {
  it('enforces the rule for a country that has one', () => {
    expect(() => normalizeCheckoutAddress(address({ postalCode: '4600' }))).toThrow(/ES/);
    expect(normalizeCheckoutAddress(address({ postalCode: '46004' })).postalCode).toBe('46004');
  });

  it('accepts a lower-case UK postcode and a Dutch one with no space', () => {
    expect(
      normalizeCheckoutAddress(
        address({ country: 'GB', postalCode: 'sw1a 1aa', city: 'London' }),
      ).postalCode,
      // Preserved as typed — the pattern matches case-insensitively, but the
      // stored value is the buyer's, because a carrier reads it back.
    ).toBe('sw1a 1aa');
    expect(
      normalizeCheckoutAddress(address({ country: 'NL', postalCode: '1012AB', city: 'Amsterdam' }))
        .postalCode,
    ).toBe('1012AB');
  });

  it('does NOT pattern-check a country with no reliable rule', () => {
    // Ireland's Eircode, Hong Kong (no postal system at all): an overfitted
    // regex here is exactly the failure #105 validation rule 3 names, so the
    // long tail is length-checked and left alone.
    expect(
      normalizeCheckoutAddress(address({ country: 'IE', postalCode: 'D02 AF30', city: 'Dublin' }))
        .postalCode,
    ).toBe('D02 AF30');
    expect(
      normalizeCheckoutAddress(address({ country: 'HK', postalCode: '000', city: 'Kowloon' }))
        .postalCode,
    ).toBe('000');
  });
});

describe('text hygiene', () => {
  it('applies Unicode NFC, which a pass-through would not', () => {
    // Decomposed "Málaga": `a` + U+0301. NFC folds it to the single code point,
    // so the length changes — a check that did nothing would leave 7.
    const decomposed = 'Ma\u0301laga';
    expect(decomposed.length).toBe(7);
    expect(normalizeCheckoutAddress(address({ city: decomposed })).city).toBe('M\u00e1laga');
    expect(normalizeCheckoutAddress(address({ city: decomposed })).city.length).toBe(6);
  });

  it('refuses control characters, including the ones a \\n check misses', () => {
    expect(() => normalizeCheckoutAddress(address({ recipientName: 'Jane\nBcc: x@y.z' }))).toThrow(
      /not allowed/,
    );
    // U+2028 LINE SEPARATOR — not matched by /\n|\r/, and it breaks label
    // renderers and JS string literals alike.
    expect(() => normalizeCheckoutAddress(address({ line1: 'Street\u2028One' }))).toThrow(
      /not allowed/,
    );
    // A bidi override: the display-spoofing family.
    expect(() => normalizeCheckoutAddress(address({ city: 'Valencia\u202E' }))).toThrow(
      /not allowed/,
    );
  });

  it('refuses markup with its own message, not the control-character one', () => {
    expect(() => normalizeCheckoutAddress(address({ line1: '<b>Street</b>' }))).toThrow(/markup/);
  });

  it('bounds every field and never echoes the value in the refusal', () => {
    try {
      normalizeCheckoutAddress(address({ city: 'x'.repeat(151) }));
      expect.unreachable('an over-long city must be refused');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('City');
      expect(message).not.toContain('xxx');
    }
  });

  it('treats an empty optional as ABSENT rather than as an empty string', () => {
    const result = normalizeCheckoutAddress(address({ line2: '   ', region: '' }));
    expect(result.line2).toBeUndefined();
    expect(result.region).toBeUndefined();
    expect('line2' in result).toBe(false);
  });
});

describe('email: the display form and the lookup form are different values', () => {
  it('keeps the address as typed and lower-cases only the lookup form', () => {
    // A MIXED-CASE fixture is the one that makes the two disagree; an
    // already-lowercase address would pass whether or not the split existed.
    const result = normalizeCheckoutContact({ email: '  Jane.Doe@Example.COM ' });
    expect(result.displayEmail).toBe('Jane.Doe@Example.COM');
    expect(result.normalizedEmail).toBe('jane.doe@example.com');
  });

  it('does NOT strip plus tags or fold dots — those are mailbox-owner semantics', () => {
    const result = normalizeCheckoutContact({ email: 'jane.doe+mercaria@gmail.com' });
    expect(result.normalizedEmail).toBe('jane.doe+mercaria@gmail.com');
  });

  it('refuses an address that is not one', () => {
    expect(() => normalizeCheckoutContact({ email: 'jane@' })).toThrow(/valid address/);
    expect(() => normalizeCheckoutContact({ email: 'jane@example' })).toThrow(/valid address/);
    expect(() => normalizeCheckoutContact({ email: 'jane doe@example.com' })).toThrow(
      /valid address/,
    );
  });
});

describe('phone: canonical for comparison, display preserved', () => {
  it('keeps the buyer spacing and canonicalizes separately', () => {
    const result = normalizeCheckoutContact({
      email: 'jane@example.com',
      phone: '+34 600 123 456',
    });
    expect(result.displayPhone).toBe('+34 600 123 456');
    expect(result.canonicalPhone).toBe('+34600123456');
  });

  it('never invents a country code for a national number', () => {
    expect(canonicalizePhone('600 123 456')).toBe('600123456');
    expect(canonicalizePhone('(600) 123-456')).toBe('600123456');
  });

  it('refuses a number that cannot be one', () => {
    expect(() => normalizeCheckoutContact({ email: 'jane@example.com', phone: '12' })).toThrow(
      /6 to 15 digits/,
    );
  });
});
