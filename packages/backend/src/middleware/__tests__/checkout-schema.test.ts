/**
 * The checkout request schema — what a buyer's client may say about payment.
 *
 * ## Why this is a security test and not a validation one
 *
 * Mercaria must never receive card data. PCI SAQ-A depends on it, and a field
 * that reaches this server can end up in a log line, an error message or a bug
 * report long before anyone notices it exists. Zod's DEFAULT is to strip unknown
 * keys, which is safe but silent: a client sending `cardNumber` would be told
 * nothing, keep sending it, and the day somebody logs `req.body` before
 * validation the data is already arriving.
 *
 * `.strict()` turns that into a 400 on the first attempt, in development, to the
 * person who can fix it. These tests pin that — and pin the other half, which is
 * that the ONLY thing a client may say about payment here is WHICH RAIL. Not an
 * amount, not a token, not a status, not a provider object: every figure about
 * the money is server-derived (#45 invariant 6).
 */

import { describe, it, expect } from 'vitest';
import { CHECKOUT_PAYMENT_METHODS } from '@mercaria/shared-types';
import { checkoutSchema } from '../schemas.js';

/** The smallest body the route accepts. */
const VALID = { addressId: 'addr-1' };

describe('checkoutSchema', () => {
  it('accepts the ordinary body, with and without a rail', () => {
    expect(checkoutSchema.safeParse(VALID).success).toBe(true);
    for (const paymentMethod of CHECKOUT_PAYMENT_METHODS) {
      expect(checkoutSchema.safeParse({ ...VALID, paymentMethod }).success).toBe(true);
    }
  });

  it('refuses a rail it does not know', () => {
    // A closed set, so a typo or an invented rail is a 400 rather than a silent
    // fallback to whatever the deployment happens to have enabled.
    expect(checkoutSchema.safeParse({ ...VALID, paymentMethod: 'bank_transfer' }).success).toBe(
      false,
    );
  });

  it.each([
    ['cardNumber', '4242424242424242'],
    ['card_number', '4242424242424242'],
    ['pan', '4242424242424242'],
    ['cvc', '123'],
    ['cvv', '123'],
    ['expiry', '12/30'],
    ['paymentMethodId', 'pm_1234567890'],
    ['paymentIntentId', 'pi_1234567890'],
    ['clientSecret', 'pi_123_secret_456'],
  ])('REFUSES a body carrying %s rather than stripping it', (field, value) => {
    const result = checkoutSchema.safeParse({ ...VALID, [field]: value });

    expect(result.success).toBe(false);
    // And the value is nowhere in the parsed output, because there is none —
    // this is the assertion that would fail if `.strict()` were ever dropped,
    // since a stripping schema returns `success: true` with the field gone.
    expect(result.data).toBeUndefined();
  });

  it.each([
    ['amount', 4_500],
    ['paid', true],
    ['paymentStatus', 'succeeded'],
    ['currency', 'EUR'],
  ])('REFUSES a client asserting %s', (field, value) => {
    // The money is the server's to decide, start to finish: the total comes from
    // the orders it just wrote, the currency from the buyer's own preference,
    // and `paid` from a verified provider event. A body able to carry any of
    // them is the surface where one would eventually be trusted.
    expect(checkoutSchema.safeParse({ ...VALID, [field]: value }).success).toBe(false);
  });
});
