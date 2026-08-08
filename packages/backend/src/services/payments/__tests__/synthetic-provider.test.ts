/**
 * `SyntheticPaymentProvider` against the shared contract suite, plus the few
 * properties that are its own rather than every rail's.
 *
 * The contract suite is the bulk of it and lives in `./provider-contract.ts`
 * precisely so this file is short: what is asserted here about the synthetic
 * rail is asserted identically about Stripe (#46–#48) and Faircoin (#51) when
 * they arrive, by calling the same function.
 */

import { describe, it, expect } from 'vitest';
import { PaymentProviderError } from '../provider.js';
import { SyntheticPaymentProvider } from '../synthetic-provider.js';
import { runPaymentProviderContract } from './provider-contract.js';

/** A fixed secret so the signed-event arms are deterministic. */
const EVENT_SECRET = 'contract-suite-secret';

runPaymentProviderContract({
  name: 'SyntheticPaymentProvider',
  createProvider: () => new SyntheticPaymentProvider({ eventSecret: EVENT_SECRET }),
  injectFailure: (provider, stage) => {
    if (!(provider instanceof SyntheticPaymentProvider)) return;
    provider.setFailure(
      stage,
      new PaymentProviderError({
        provider: 'mock',
        stage,
        message: `injected failure at ${stage}`,
        retryable: stage === 'getStatus',
        code: 'injected',
      }),
    );
  },
  signEventFor: (provider, input) => {
    if (!(provider instanceof SyntheticPaymentProvider)) {
      throw new Error('signEventFor was called with a provider it does not own');
    }
    return provider.signEvent(provider.buildEvent(input));
  },
});

describe('SyntheticPaymentProvider — its own properties', () => {
  it('derives the SAME provider object id from the same payment id, across instances', () => {
    // Determinism across instances, not just within one: it is what makes a
    // retry converge with no stored state, which is the property a real rail's
    // idempotency key buys and the one worth exercising here.
    const first = new SyntheticPaymentProvider({ eventSecret: EVENT_SECRET });
    const second = new SyntheticPaymentProvider({ eventSecret: EVENT_SECRET });
    const request = {
      paymentId: 'pay-determinism',
      checkoutGroupId: 'group-determinism',
      amount: { amount: 100, currency: 'EUR' } as const,
      orderIds: ['order-1'],
      idempotencyKey: 'pi:pay-determinism',
      metadata: {},
    };
    return Promise.all([first.createPayment(request), second.createPayment(request)]).then(
      ([a, b]) => {
        expect(a.providerObjectId).toBe(b.providerObjectId);
      },
    );
  });

  it('rejects a refund larger than the captured amount', async () => {
    const provider = new SyntheticPaymentProvider({ eventSecret: EVENT_SECRET });
    const created = await provider.createPayment({
      paymentId: 'pay-overrefund',
      checkoutGroupId: 'group-overrefund',
      amount: { amount: 1_000, currency: 'EUR' },
      orderIds: ['order-1'],
      idempotencyKey: 'pi:pay-overrefund',
      metadata: {},
    });
    await provider.capture({
      paymentId: 'pay-overrefund',
      providerObjectId: created.providerObjectId,
      idempotencyKey: 'cap:pay-overrefund',
    });

    await expect(
      provider.refund({
        paymentId: 'pay-overrefund',
        providerObjectId: created.providerObjectId,
        refundId: 'refund-too-big',
        amount: { amount: 1_001, currency: 'EUR' },
        idempotencyKey: 're:refund-too-big',
      }),
    ).rejects.toThrow(/exceeds the captured amount/);
  });

  it('generates a random event secret when none is given', async () => {
    // Two default instances must not verify each other's events. If the default
    // were a constant it would be a shipped secret, live in production, whether
    // or not anything used it.
    const signer = new SyntheticPaymentProvider();
    const verifier = new SyntheticPaymentProvider();
    const event = signer.signEvent(
      signer.buildEvent({ paymentId: 'p', providerObjectId: 'o', status: 'succeeded' }),
    );
    await expect(verifier.verifyEvent(event)).rejects.toThrow(/signature does not verify/);
    // …and the signer verifies its own, so the failure above is the SECRET
    // differing rather than the signing being broken.
    await expect(signer.verifyEvent(event)).resolves.toMatchObject({ provider: 'mock' });
  });

  it('rejects a truncated signature rather than throwing a TypeError', async () => {
    // `timingSafeEqual` throws on a length mismatch instead of returning false,
    // so a length check has to come first — otherwise a truncated signature
    // surfaces as a crash rather than as the rejection it is.
    const provider = new SyntheticPaymentProvider({ eventSecret: EVENT_SECRET });
    const rejected: unknown = await provider
      .verifyEvent({ payload: '{"id":"evt"}', signature: 'ab' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBeInstanceOf(PaymentProviderError);
    expect((rejected as PaymentProviderError).code).toBe('signature_verification_failed');
  });
});
