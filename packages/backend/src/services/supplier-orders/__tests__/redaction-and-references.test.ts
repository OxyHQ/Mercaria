/**
 * What may be stored about a supplier order, and the references that make a
 * repeat converge.
 *
 * Pure, and the two halves belong together because they are the same boundary
 * seen twice: the digest exists so a resubmission that DIFFERS is visible, and
 * the redaction exists so neither the digest's input nor a provider's reply
 * ends up somewhere a person can read it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SupplierOrderDraft } from '@mercaria/shared-types';
import { SUPPLIER_EVENT_PAYLOAD_FIELDS } from '@mercaria/shared-types';
import {
  canonicalJson,
  digestSupplierValue,
  projectSupplierEventPayload,
  redactSupplierOrderMessage,
  redactSupplierReference,
} from '../redact.js';
import {
  deriveCancellationIdempotencyKey,
  deriveSubmissionIdempotencyKey,
  deriveSupplierClientReference,
  digestPolledObservation,
  digestSupplierOrderRequest,
  parseSupplierClientReference,
} from '../client-reference.js';

function draft(overrides: Partial<SupplierOrderDraft> = {}): SupplierOrderDraft {
  return {
    clientReference: 'mercaria-po-abc',
    currency: 'EUR',
    lines: [
      {
        clientLineReference: 'line-1',
        supplierSku: 'SKU-A',
        quantity: 2,
        expectedUnitCost: { amount: 2_000, currency: 'EUR' },
        expectedLineTotal: { amount: 4_000, currency: 'EUR' },
        description: null,
      },
    ],
    destination: {
      recipient: { name: 'Ada Lovelace', company: null, phone: '+34600111222' },
      address: {
        line1: '1 Market Street',
        line2: null,
        city: 'Valencia',
        region: null,
        postalCode: '46001',
        country: 'ES',
      },
      deliveryInstructions: null,
    },
    shippingServiceCode: null,
    quoteReference: null,
    reservationReference: null,
    expectedTotal: { amount: 4_400, currency: 'EUR' },
    ...overrides,
  };
}

describe('the client reference and its idempotency keys', () => {
  it('round-trips, and answers null for somebody else"s reference', () => {
    const reference = deriveSupplierClientReference('po-123');
    expect(reference).toBe('mercaria-po-po-123');
    expect(parseSupplierClientReference(reference)).toBe('po-123');
    // A shared endpoint receives references that are not ours. That is a real
    // thing rather than an error in this process, so it answers `null`.
    expect(parseSupplierClientReference('shopify-order-99')).toBeNull();
    expect(parseSupplierClientReference('mercaria-po-')).toBeNull();
  });

  it('derives the same key for the same act, every time', () => {
    expect(deriveSubmissionIdempotencyKey('po-1')).toBe(deriveSubmissionIdempotencyKey('po-1'));
    expect(deriveCancellationIdempotencyKey('po-1')).toBe(
      deriveCancellationIdempotencyKey('po-1'),
    );
    // Submitting and cancelling are different acts and must not share a key: a
    // provider keyed on it would answer the cancellation with the submission.
    expect(deriveSubmissionIdempotencyKey('po-1')).not.toBe(
      deriveCancellationIdempotencyKey('po-1'),
    );
  });
});

describe('the request digest', () => {
  it('is stable across key ORDER, which is what makes it comparable at all', () => {
    // Two renderings of one request must be byte-identical, and an object built
    // by spreading a partial over a default has whatever order those had.
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(digestSupplierValue(a)).toBe(digestSupplierValue(b));
  });

  it('CHANGES when the destination changes', () => {
    // The property the whole "refuse a changed request" rule rests on.
    // Excluding the destination would be worse than storing the address: a
    // resubmission that changed only the street would read as the same request
    // and be sent without a second thought.
    const original = digestSupplierOrderRequest(draft());
    const moved = digestSupplierOrderRequest(
      draft({
        destination: {
          ...draft().destination,
          address: { ...draft().destination.address, line1: '2 Market Street' },
        },
      }),
    );
    expect(moved).not.toBe(original);
    expect(original).toHaveLength(64);
  });

  it('gives one polled observation one identity, and two observations two', () => {
    const base = {
      providerAccountId: 'acct-1',
      externalOrderId: 'ord-1',
      clientReference: 'mercaria-po-1',
      providerState: 'CONFIRMED',
      observedAt: '2026-08-09T12:00:00.000Z',
      trackingNumbers: ['B', 'A'],
    };
    // Tracking numbers are SORTED, so a provider that reorders its own array
    // between two polls does not mint a second event.
    expect(digestPolledObservation(base)).toBe(
      digestPolledObservation({ ...base, trackingNumbers: ['A', 'B'] }),
    );
    expect(digestPolledObservation(base)).not.toBe(
      digestPolledObservation({ ...base, providerState: 'DISPATCHED' }),
    );
  });
});

describe('redacting a provider message', () => {
  it('removes an email, a street fragment and a postal code', () => {
    const message = redactSupplierOrderMessage(
      'Rejected for ada@example.com at 1 Market Street, Valencia 46001 (phone 600111222)',
    );
    expect(message).not.toContain('example.com');
    expect(message).not.toContain('Market Street');
    expect(message).not.toContain('46001');
    expect(message).not.toContain('600111222');
  });

  it('leaves an alphanumeric SKU and a service code readable', () => {
    // The reason the rules are bounded rather than maximal: a message with
    // every token removed tells an operator nothing, and the SKU is usually
    // the whole of what makes one useful.
    const message = redactSupplierOrderMessage('SKU-A is out of stock for service STD');
    expect(message).toContain('SKU-A');
    expect(message).toContain('STD');
  });

  it('bounds what it returns', () => {
    expect(redactSupplierOrderMessage('x'.repeat(5_000)).length).toBeLessThanOrEqual(513);
  });

  it('shows a provider reference as its last four characters', () => {
    expect(redactSupplierReference('ord_1234567890')).toBe('…7890');
    // Too short to redact meaningfully: a four-character order id is still a
    // usable handle, so it is replaced entirely rather than shown whole.
    expect(redactSupplierReference('abc')).toBe('[redacted]');
    expect(redactSupplierReference(null)).toBeNull();
  });
});

/**
 * The marker, and the instrument that tells a PARTIAL redaction from a whole
 * one (#832).
 *
 * `[redacted]` contains `a`, `c`, `d`, `e`, `r` and `t`, so a naive "did any
 * input letter survive" scan reports every ASCII address as partly leaked. The
 * first run of this instrument said exactly that about `12 Main Street`, which
 * is why the marker is stripped before the residue is read and why the ASCII
 * control is carried through every table below.
 */
const REDACTED_MARKER = '[redacted]';

function survivingCharacters(input: string, output: string): string {
  const residue = output.split(REDACTED_MARKER).join('');
  const distinct = [...new Set([...input].filter((c) => /[\p{L}\p{M}]/u.test(c)))];
  return distinct.filter((c) => residue.includes(c)).join('');
}

// Written as code points rather than as themselves: a zero-width joiner pasted
// into a test fixture is invisible in the diff that adds it.
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);

describe('redacting an address that is not written in Latin script (#832)', () => {
  // The apps ship `hi`, `bn` and `ja` bundles in all four packages, so those
  // three are the ones the product has committed to. The rest are here because
  // each exercises a DIFFERENT half of the rule: `ru`/`el` are cased scripts
  // whose capitals are simply not ASCII, `ar`/`he`/`th`/`ko` are caseless.
  it.each([
    ['ASCII control', '12 Main Street'],
    ['Devanagari (hi)', '12 मुख्य मार्ग'],
    ['Devanagari + postal', '12 मुख्य मार्ग, नई दिल्ली 110001'],
    ['Bengali (bn)', '12 প্রধান সড়ক'],
    ['Japanese (ja)', '2-8-1 西新宿'],
    ['Cyrillic (ru)', '12 Красная Площадь'],
    ['Greek (el)', '12 Οδός Ερμού'],
    ['Arabic (ar)', '12 شارع الجمهورية'],
    ['Hebrew (he)', '12 רחוב הרצל'],
    ['Thai (th)', '12 ถนนสุขุมวิท'],
    ['Korean (ko)', '12 세종대로'],
  ])('leaves nothing of a %s address in the message', (_label, address) => {
    const output = redactSupplierOrderMessage(address);
    expect(output).toContain(REDACTED_MARKER);
    // The assertion that matters is the RESIDUE, not the presence of a marker.
    // Before #832 the Devanagari and Cyrillic rows produced no marker at all and
    // the NFD row produced one with the address still beside it.
    expect(survivingCharacters(address, output)).toBe('');
  });

  it('redacts a DECOMPOSED spelling as completely as a composed one', () => {
    // NFD is not an exotic-script concern: Spanish and German decompose the same
    // way, and before #832 each left its tail in the payload — `Nguye` plus
    // `ễn Trai`, `Pe` plus `ñíscola`.
    for (const base of ['12 Nguyễn Trai', '12 Calle Peñíscola', '12 Grüner Weg']) {
      for (const form of ['NFC', 'NFD'] as const) {
        const address = base.normalize(form);
        const output = redactSupplierOrderMessage(address);
        expect(`${form}:${output}`).toBe(`${form}:${REDACTED_MARKER}`);
        expect(survivingCharacters(address, output)).toBe('');
      }
    }
  });

  it('redacts across a zero-width joiner, which is not a combining mark', () => {
    // ZWNJ/ZWJ are `Cf`, so `\p{M}` does not cover them, and a Hindi or Bengali
    // conjunct that carries one would otherwise stop the word run dead — the
    // same "looks redacted" partial the NFD case produces.
    for (const address of [`12 अन्${ZWNJ}य मार्ग`, `12 क${ZWJ}ष मार्ग`, `12 প্${ZWNJ}রধান সড়ক`]) {
      const output = redactSupplierOrderMessage(address);
      expect(output).toBe(REDACTED_MARKER);
      expect(survivingCharacters(address, output)).toBe('');
    }
  });

  it('keeps the lowercase filter in every script that HAS one', () => {
    // The word run starts on `\p{Lu}\p{Lt}\p{Lo}` and deliberately NOT `\p{Ll}`,
    // so the filter that stops `12 items shipped` becoming `[redacted]` is not
    // an ASCII accident — it goes on working in Cyrillic and Greek. A naive
    // widening to `\p{L}` passes every test above and fails all three of these.
    for (const prose of ['12 items shipped', '12 товаров отправлено', '12 είδη απεστάλησαν']) {
      expect(redactSupplierOrderMessage(prose)).toBe(prose);
    }
  });

  it('does NOT reach an address in native CJK order — a stated limit, not an oversight', () => {
    // `東京都新宿区西新宿2-8-1` puts the number LAST and carries no separator, so
    // the house-number-then-name SHAPE never engages and no character class
    // changes that. Pinned so the gap is discoverable and closing it is a
    // deliberate change rather than a surprise; mechanisms 1 and 2 in
    // `redact.ts` are what stand in front of this case.
    const nativeOrder = '東京都新宿区西新宿2-8-1';
    expect(redactSupplierOrderMessage(nativeOrder)).toBe(nativeOrder);
  });
});

describe('what the street rule must NOT eat (#832 over-matching cost)', () => {
  // Every expected value here was captured by RUNNING the pre-#832 function,
  // not by running the new one — otherwise the table records whatever the change
  // happened to do. Two entries are pre-existing losses to the five-digit rule
  // (`SKU12345`, `18500`) and are recorded rather than quietly excluded.
  it.each([
    ['Rejected for ada@example.com at 1 Market Street, Valencia 46001 (phone 600111222)', 'Rejected for [redacted] at [redacted] [redacted] (phone [redacted])'],
    ['SKU-A is out of stock for service STD', 'SKU-A is out of stock for service STD'],
    ['refused for ada@example.com', 'refused for [redacted]'],
    ['SKU-A', 'SKU-A'],
    ['SKU12345', '[redacted]'],
    ['ABC-123-XL', 'ABC-123-XL'],
    ['TSHIRT-BLK-M', 'TSHIRT-BLK-M'],
    ['sku_9912_red', 'sku_9912_red'],
    ['PF-4XL-NAVY', 'PF-4XL-NAVY'],
    ['item 42 discontinued', 'item 42 discontinued'],
    ['variant 7 unavailable', 'variant 7 unavailable'],
    ['STD', 'STD'],
    ['DHL EXPRESS WORLDWIDE', 'DHL EXPRESS WORLDWIDE'],
    ['UPS 2ND DAY AIR', 'UPS 2ND DAY AIR'],
    ['service STD unavailable', 'service STD unavailable'],
    ['FEDEX_GROUND', 'FEDEX_GROUND'],
    ['GLS BusinessParcel', 'GLS BusinessParcel'],
    ['tracking 1Z999AA10123456784', 'tracking 1Z999AA10123456784'],
    ['Unisex Staple T-Shirt', 'Unisex Staple T-Shirt'],
    ['Enhanced Matte Paper Poster 12x18', 'Enhanced Matte Paper Poster 12x18'],
    ['Ceramic Mug 11oz', 'Ceramic Mug 11oz'],
    ['Bella + Canvas 3001', 'Bella + Canvas 3001'],
    ['Gildan 18500 Hoodie', 'Gildan [redacted] Hoodie'],
    ['Order rejected: 3 items are out of stock', 'Order rejected: 3 items are out of stock'],
    ['Please retry after 5 minutes', 'Please retry after 5 minutes'],
    ['quantity 2 exceeds available 1', 'quantity 2 exceeds available 1'],
    ['Rate limit exceeded, retry in 30 seconds', 'Rate limit exceeded, retry in 30 seconds'],
    ['Invalid value for field shipping.service', 'Invalid value for field shipping.service'],
    ['The order has 4 lines and 2 could not be fulfilled', 'The order has 4 lines and 2 could not be fulfilled'],
  ])('answers %j exactly as it did before #832', (input, expected) => {
    expect(redactSupplierOrderMessage(input)).toBe(expected);
  });
});

describe('the character classes the street rule is built from (#832)', () => {
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const source = readFileSync(join(SRC_ROOT, 'services/supplier-orders/redact.ts'), 'utf8');
  const streetRule = /\/\\b\\d\{1,4\}\[A-Za-z\]\?\[,\\s\]\+[^\n]*\/gu/.exec(source)?.[0] ?? '';

  it('finds the rule it is about to make claims about', () => {
    // The vacuity floor. A scan whose pattern stopped matching would report a
    // clean pass for every assertion below it.
    expect(source.length).toBeGreaterThan(2_000);
    expect(streetRule).not.toBe('');
    expect(streetRule).toContain('[,\\s]+');
  });

  it('starts a word on a caseless letter, and never on a LOWERCASE one', () => {
    // `\p{Lo}` is the whole of the non-Latin fix: `\p{Lu}` alone repairs Cyrillic
    // and Greek and leaves every caseless script exactly as broken.
    expect(streetRule).toContain('\\p{Lo}');
    expect(streetRule).toContain('\\p{Lu}');
    // `\p{Ll}` here would silently delete the filter the lowercase test above
    // depends on, in a diff that reads as "support more scripts".
    expect(streetRule).not.toContain('\\p{Ll}');
    // And the continuation must admit marks, or NFD partially redacts.
    expect(streetRule).toContain('\\p{M}');
  });

  it('spells the zero-width joiners as ESCAPES, never as themselves', () => {
    // A literal U+200C in a character class is invisible in every diff, every
    // review and every terminal — which is the state the mark handling was in.
    // Measured by CODE POINT, because there is no appearance to check.
    const invisible = [...source].filter((c) => c === ZWNJ || c === ZWJ);
    expect(invisible).toEqual([]);
    expect(streetRule).toContain('\\u200c');
    expect(streetRule).toContain('\\u200d');
  });

  it('self-test: the scan can actually SEE a forbidden class', () => {
    // Without this the three assertions above pass just as well against a rule
    // the regex above failed to locate.
    const mutated = streetRule.replace('\\p{Lo}', '\\p{Ll}');
    expect(mutated).not.toBe(streetRule);
    expect(mutated).toContain('\\p{Ll}');
    expect(mutated).not.toContain('\\p{Lo}');
  });
});

describe('projecting a provider payload', () => {
  it('keeps only the allow-listed keys', () => {
    const projection = projectSupplierEventPayload({
      orderStatus: 'CONFIRMED',
      externalOrderId: 'ord-1',
      recipientName: 'Ada Lovelace',
      shippingAddress: '1 Market Street',
      buyerEmail: 'ada@example.com',
      phone: '+34600111222',
    });
    expect(Object.keys(projection).sort()).toEqual(['externalOrderId', 'orderStatus']);
  });

  it('does not descend into a nested object under an allow-listed key', () => {
    // A nested object is where a provider puts the shipping address, and a
    // projection that walked into one would have to allow-list every PATH
    // rather than every key — the shape that goes stale silently.
    const projection = projectSupplierEventPayload({
      orderStatus: { code: 'CONFIRMED', recipient: 'Ada Lovelace', street: '1 Market Street' },
    });
    expect(JSON.stringify(projection)).not.toContain('Ada');
    expect(JSON.stringify(projection)).not.toContain('Market');
    expect(String(projection['orderStatus'])).toMatch(/^\[object:\d+ keys\]$/);
  });

  it('redacts inside an allow-listed STRING too', () => {
    const projection = projectSupplierEventPayload({
      reasonCode: 'refused for ada@example.com',
    });
    expect(String(projection['reasonCode'])).not.toContain('example.com');
  });

  it('has no allow-listed key that could name a person or a place', () => {
    // A shape check beside the projection test: the list itself is the defence,
    // and a plausible future addition (`recipient`, `address`, `contact`) would
    // pass every test above while defeating all of them.
    const forbidden = /recipient|address|street|city|postal|phone|email|contact|name$/i;
    expect(SUPPLIER_EVENT_PAYLOAD_FIELDS.filter((entry) => forbidden.test(entry))).toEqual([]);
  });
});
