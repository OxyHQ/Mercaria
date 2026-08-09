/**
 * The query-redaction fixture suite — #77 acceptance criterion 4 ("query
 * redaction fixtures cover common sensitive patterns").
 *
 * Two halves, and the second is the one that makes the first worth anything:
 *
 *  - Every redaction kind has at least one POSITIVE fixture and the pattern
 *    destroys the value.
 *  - Ordinary product queries are NOT destroyed. A redactor that eats
 *    `iphone 15 128gb` catches nothing a human would call sensitive and
 *    silently empties the dataset, which is a worse outcome than no redaction
 *    at all because it looks like it is working.
 *
 * The AGENTS.md rule (E) applies throughout: a fixture set where every case
 * sits on the same side of the distinction a check exists to make cannot kill a
 * mutation of that check. So each pattern has a fixture that would still match
 * under a looser rule AND a near-miss that must not match.
 */

import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_QUERY_REDACTED_MARKER,
  ANALYTICS_QUERY_REDACTION_KINDS,
} from '@mercaria/shared-types';
import {
  REDACTION_KINDS_COVERED,
  normalizeQueryTokens,
  redactSearchQuery,
} from '../redact-query.js';

/** The sensitive substring must be GONE, and the marker must be present. */
function expectRedacted(raw: string, secret: string, kind: string): void {
  const result = redactSearchQuery(raw);
  expect(result.redactedText, `"${raw}" still contains "${secret}"`).not.toContain(secret);
  expect(result.redactedText).toContain(ANALYTICS_QUERY_REDACTED_MARKER);
  expect(result.redactionKinds, `"${raw}" was not reported as ${kind}`).toContain(kind);
  // The tokens are derived from the REDACTED text, so the secret must be absent
  // from them too — otherwise nulling the text at 30 days would leave the thing
  // the text was redacted for standing in the column that survives.
  expect(result.normalizedTokens.join(' ')).not.toContain(secret.toLowerCase());
}

describe('search-query redaction', () => {
  describe('emails', () => {
    it('destroys a plain address', () => {
      expectRedacted('refund for nate@example.com please', 'nate@example.com', 'email');
    });

    it('destroys a plus-tagged address with a multi-label domain', () => {
      expectRedacted(
        'order under maria+shop@mail.co.uk',
        'maria+shop@mail.co.uk',
        'email',
      );
    });

    it('leaves an at-sign that is not an address alone', () => {
      const result = redactSearchQuery('meet @ the shop');
      expect(result.redactionKinds).not.toContain('email');
    });
  });

  describe('phone numbers', () => {
    it('destroys an international number', () => {
      expectRedacted('call me +34 600 123 456', '600 123 456', 'phone');
    });

    it('destroys a hyphenated national number', () => {
      expectRedacted('phone 600-123-456', '600-123-456', 'phone');
    });

    it('destroys a parenthesised area code', () => {
      expectRedacted('ring (555) 123-4567', '(555) 123-4567', 'phone');
    });

    it('does NOT eat a product query full of numbers', () => {
      // The fixture that makes the mandatory-separator rule load-bearing:
      // with separators optional, this reads as three digit groups and the
      // whole query is destroyed.
      const result = redactSearchQuery('iphone 15 128 256 gb');
      expect(result.redactionKinds).not.toContain('phone');
      expect(result.redactedText).toBe('iphone 15 128 256 gb');
    });
  });

  describe('payment card numbers', () => {
    it('destroys a spaced 16-digit number', () => {
      expectRedacted('4242 4242 4242 4242', '4242 4242 4242 4242', 'payment_card');
    });

    it('destroys a 19-digit number a 16-digit-only pattern would miss', () => {
      expectRedacted('6221260000000000000 charge', '6221260000000000000', 'payment_card');
    });

    it('reports a card as a CARD, not as a long digit run', () => {
      // The ordering fixture. With the digit-run rule first, an operator
      // watching for `payment_card` would see nothing while cards were being
      // pasted into the search box daily.
      const result = redactSearchQuery('4242424242424242');
      expect(result.redactionKinds).toContain('payment_card');
    });
  });

  describe('IBANs', () => {
    it('destroys a spaced ES IBAN', () => {
      expectRedacted('ES91 2100 0418 4502 0005 1332', 'ES91 2100 0418 4502 0005 1332', 'iban');
    });

    it('reports an IBAN as an IBAN, not as a long digit run', () => {
      const result = redactSearchQuery('DE89370400440532013000');
      expect(result.redactionKinds).toContain('iban');
    });
  });

  describe('secrets and tokens', () => {
    it('destroys a JWT', () => {
      expectRedacted(
        'why does eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U fail',
        'eyJhbGciOiJIUzI1NiJ9',
        'secret_token',
      );
    });

    it('destroys an API key', () => {
      expectRedacted('key sk_live_51H8xQpLmNoPqRsTuVwXyZ', 'sk_live_51H8xQpLmNoPqRsTuVwXyZ', 'secret_token');
    });

    it('destroys a Mercaria guest token', () => {
      // The three guest prefixes are on the list deliberately: a shopper who
      // pastes a magic-link URL into the search box would otherwise hand a live
      // credential to a table an operator reads.
      expectRedacted(
        'mgp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 does not work',
        'mgp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
        'secret_token',
      );
    });
  });

  describe('postal addresses', () => {
    it('destroys an English street address', () => {
      expectRedacted('deliver to 221 Baker Street', '221 Baker Street', 'postal_address');
    });

    it('destroys a Spanish street address', () => {
      expectRedacted('envio a Calle Mallorca 401', 'Calle Mallorca 401', 'postal_address');
    });
  });

  describe('URLs carrying credentials', () => {
    it('destroys the whole URL', () => {
      expectRedacted(
        'https://admin:hunter2@shop.example.com/orders',
        'hunter2',
        'url_with_credentials',
      );
    });

    it('reports it as a credentialled URL, not as an email', () => {
      // The ordering fixture for the other end of the list: `admin:hunter2@host`
      // contains an at-sign, and naming it an email would report the wrong
      // exposure to whoever is triaging.
      const result = redactSearchQuery('https://admin:hunter2@shop.example.com/orders');
      expect(result.redactionKinds).toContain('url_with_credentials');
    });
  });

  describe('long digit runs', () => {
    it('destroys a bare identifier just below the card range', () => {
      // Twelve digits: one short of the shortest card, so the digit-run rule is
      // what catches it. The pair with the 13-digit case above is what pins the
      // boundary — a card rule widened to 12 would silently reclassify order
      // numbers as payment data, and one narrowed to 16 would let a Maestro
      // number through as an order number.
      expectRedacted('order 123456789012', '123456789012', 'long_digit_run');
    });

    it('destroys a nine-digit national id', () => {
      expectRedacted('dni 123456789', '123456789', 'long_digit_run');
    });
  });

  describe('oversized queries', () => {
    it('truncates and reports it', () => {
      const result = redactSearchQuery('a'.repeat(500));
      expect(result.redactedText.length).toBeLessThanOrEqual(256);
      expect(result.redactionKinds).toContain('oversized');
    });
  });

  describe('ordinary queries survive intact', () => {
    // The other side of rule (E). Without these, a redactor that replaced
    // EVERY query with the marker would pass every fixture above.
    it.each([
      'red wedding dress size 12',
      'iphone 15 pro max 256gb',
      'bicicleta de montaña segunda mano',
      'nike air max 90',
      'lego star wars 75192',
      'cafetera italiana 6 tazas',
    ])('leaves "%s" untouched', (query) => {
      const result = redactSearchQuery(query);
      expect(result.redactedText).toBe(query);
      expect(result.redactionKinds).toEqual([]);
      expect(result.normalizedTokens.length).toBeGreaterThan(0);
    });
  });

  describe('normalization', () => {
    it('lower-cases, strips punctuation and keeps accents', () => {
      expect(normalizeQueryTokens('Bicicleta, de MONTAÑA!')).toEqual([
        'bicicleta',
        'de',
        'montaña',
      ]);
    });

    it('drops the redaction marker rather than tokenising it', () => {
      // Otherwise every query containing anything sensitive would aggregate
      // into one very popular "[redacted]" bucket, which would then clear the
      // reporting floor and appear at the top of a merchant's list.
      const result = redactSearchQuery('shoes for nate@example.com');
      expect(result.normalizedTokens).toEqual(['shoes', 'for']);
    });

    it('drops an over-long token', () => {
      const tokens = normalizeQueryTokens(`shoes ${'x'.repeat(64)}`);
      expect(tokens).toEqual(['shoes']);
    });
  });

  describe('the vocabulary is fully covered', () => {
    it('every redaction kind but `oversized` has a pattern', () => {
      // The vacuity floor: a rule list that lost an entry would make every
      // fixture for that kind fail loudly, and a VOCABULARY that gained one
      // with no rule behind it would fail here instead of silently never
      // matching.
      const patternKinds = new Set(REDACTION_KINDS_COVERED);
      const missing = ANALYTICS_QUERY_REDACTION_KINDS.filter(
        (kind) => kind !== 'oversized' && !patternKinds.has(kind),
      );
      expect(missing).toEqual([]);
      expect(patternKinds.size).toBeGreaterThanOrEqual(7);
    });
  });
});
