/**
 * What may be stored about a supplier order, and the references that make a
 * repeat converge.
 *
 * Pure, and the two halves belong together because they are the same boundary
 * seen twice: the digest exists so a resubmission that DIFFERS is visible, and
 * the redaction exists so neither the digest's input nor a provider's reply
 * ends up somewhere a person can read it.
 */

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
