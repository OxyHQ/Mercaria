/**
 * What survives redaction, and — the half that matters — what does not.
 *
 * A redaction test that only checks the useful fields survived is half a test:
 * it passes identically against a function that keeps EVERYTHING. Every case
 * below therefore asserts a drop as well as a keep, and the fixtures are shaped
 * like a real provider payload rather than like a flat object, because the
 * sensitive fields in one are always nested.
 */

import { describe, it, expect } from 'vitest';
import { redactProviderMessage, redactProviderPayload } from '../redact.js';

/** A payload shaped like a card rail's webhook, sensitive fields included. */
const PAYLOAD = {
  id: 'evt_123',
  object: 'event',
  type: 'payment_intent.succeeded',
  livemode: true,
  created: 1_767_225_600,
  data: {
    object: {
      id: 'pi_456',
      object: 'payment_intent',
      amount: 2_500,
      currency: 'eur',
      status: 'succeeded',
      receipt_email: 'buyer@example.com',
      description: 'Order MRC-000123 for Jane Buyer',
      charges: {
        data: [
          {
            id: 'ch_789',
            balance_transaction: 'txn_1',
            outcome: { network_status: 'approved_by_network', risk_score: 12 },
            billing_details: {
              email: 'buyer@example.com',
              phone: '+34600000000',
              address: { line1: '1 Real Street', postal_code: '08001' },
            },
            payment_method_details: {
              card: { last4: '4242', fingerprint: 'abc123fingerprint', brand: 'visa' },
            },
          },
        ],
      },
    },
  },
};

describe('redactProviderPayload', () => {
  const redacted = redactProviderPayload(PAYLOAD);
  /** The whole result as one string — what a grep for a leak would search. */
  const serialized = JSON.stringify(redacted);

  it('keeps the ids, amounts, currencies and statuses reconciliation needs', () => {
    expect(redacted.id).toBe('evt_123');
    expect(redacted.type).toBe('payment_intent.succeeded');
    expect(redacted.livemode).toBe(true);
    expect(serialized).toContain('pi_456');
    expect(serialized).toContain('ch_789');
    expect(serialized).toContain('2500');
    expect(serialized).toContain('eur');
    expect(serialized).toContain('succeeded');
  });

  it('drops the email, the phone, the address and the card details', () => {
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('+34600000000');
    expect(serialized).not.toContain('1 Real Street');
    expect(serialized).not.toContain('08001');
    expect(serialized).not.toContain('4242');
    expect(serialized).not.toContain('abc123fingerprint');
    // The free-text description quoted the buyer's name back at us. It is not on
    // the allow-list, so it goes — which is the point of an allow-list: nobody
    // had to anticipate that a `description` would carry a name.
    expect(serialized).not.toContain('Jane Buyer');
  });

  it('drops a NEW sensitive field nobody enumerated', () => {
    // The failure mode an allow-list exists for: a provider adds a field, and
    // the redactor has never heard of it. A deny-list would ship it.
    const withNewField = redactProviderPayload({
      id: 'evt_1',
      passport_number: 'X1234567',
      data: { object: { id: 'pi_1', national_id: '12345678Z' } },
    });
    const text = JSON.stringify(withNewField);
    expect(text).not.toContain('X1234567');
    expect(text).not.toContain('12345678Z');
    expect(text).toContain('pi_1');
  });

  it('leaves a marker where a value was dropped, rather than deleting the key', () => {
    // A reader must be able to see that something WAS there. A silently missing
    // key reads as "the provider did not send one".
    const result = redactProviderPayload({ id: 'evt', secret_thing: 'value' });
    expect(result.secret_thing).toBe('[redacted]');
  });

  it('truncates a long allowed string and bounds a long array', () => {
    const longId = 'x'.repeat(400);
    const result = redactProviderPayload({ id: longId, data: { object: { id: 'ok' } } });
    expect(String(result.id)).toHaveLength(257);
    expect(String(result.id).endsWith('…')).toBe(true);

    const many = redactProviderPayload({ data: Array.from({ length: 50 }, (_, i) => ({ id: `o_${String(i)}` })) });
    const list = (many.data ?? []) as unknown[];
    expect(list).toHaveLength(21);
    expect(String(list[20])).toContain('30 more');
  });

  it('stops at a depth bound rather than recursing forever', () => {
    // A provider can nest arbitrarily, and a cyclic structure is not
    // impossible; the bound is what stops a payload from becoming a stack
    // overflow inside the webhook handler.
    let deep: Record<string, unknown> = { id: 'bottom' };
    for (let level = 0; level < 40; level += 1) deep = { data: deep };
    expect(() => redactProviderPayload(deep)).not.toThrow();
    expect(JSON.stringify(redactProviderPayload(deep))).toContain('[redacted]');
  });

  it('returns an object for a payload that is not one', () => {
    // The column is `jsonb NOT NULL`; a caller should not have to branch on a
    // provider sending a bare string.
    expect(redactProviderPayload('not an object')).toEqual({ value: '[redacted]' });
    expect(redactProviderPayload(null)).toEqual({ value: '[redacted]' });
    expect(redactProviderPayload([1, 2, 3])).toEqual({ value: '[redacted]' });
  });
});

describe('redactProviderMessage', () => {
  it('scrubs an email a provider quoted back', () => {
    expect(redactProviderMessage('No such customer: buyer@example.com')).toBe(
      'No such customer: [redacted]',
    );
  });

  it('scrubs a long digit run', () => {
    expect(redactProviderMessage('Card 4242424242424242 was declined')).toBe(
      'Card [redacted] was declined',
    );
  });

  it('leaves an ordinary message and a short number alone', () => {
    // A four-digit code, an amount and a status word all have to survive, or the
    // message stops explaining anything.
    expect(redactProviderMessage('Declined with code 51 (insufficient funds)')).toBe(
      'Declined with code 51 (insufficient funds)',
    );
  });

  it('truncates a very long message', () => {
    const long = `error ${'y'.repeat(500)}`;
    expect(redactProviderMessage(long)).toHaveLength(257);
  });
});
