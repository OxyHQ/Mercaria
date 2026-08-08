/**
 * The `PaymentProvider` CONTRACT SUITE — every rail runs it.
 *
 * Not a test file (no `.test.ts`, so vitest does not collect it): it is a suite
 * a rail's own test file calls. `SyntheticPaymentProvider` runs it today; the
 * Stripe adapter (#46–#48) and the Faircoin one (#51) run this same function
 * against their own sandbox, and a rail that cannot pass it is not finished.
 *
 * ## What it pins, and why each one is here rather than in a provider's own file
 *
 * These are the properties the payment SERVICE relies on and therefore cannot
 * verify for itself — it has one code path for every rail, so a rail that
 * behaves differently breaks it silently:
 *
 *  - the happy path reaches `succeeded` and can be refunded to `refunded`;
 *  - a partial refund lands on `partially_refunded`, not `refunded`;
 *  - every mutation is IDEMPOTENT under a repeated idempotency key — the single
 *    property standing between a retry and a second charge;
 *  - a failure at any stage arrives as a `PaymentProviderError` carrying a
 *    `retryable` flag, which is what the outbox's backoff and dead-lettering
 *    branch on;
 *  - `verifyEvent` refuses a bad signature, non-retryably;
 *  - duplicate and out-of-order events converge on ONE state (#45 acceptance 3).
 *
 * ## The optional capabilities
 *
 * A rail that cannot inject a failure, or cannot forge one of its own signed
 * events, still runs everything else — those two arms are skipped rather than
 * failed. A live Stripe sandbox can do neither on demand.
 */

import { describe, it, expect } from 'vitest';
import type { Money } from '@mercaria/shared-types';
import {
  PaymentProviderError,
  type PaymentProvider,
  type PaymentProviderStage,
  type ProviderEventInput,
} from '../provider.js';

/** How a suite run reaches its subject. */
export interface PaymentProviderContractOptions {
  /** Names the `describe` block, so several rails read apart in one run. */
  name: string;
  /** A FRESH provider per test. Shared state between tests is its own bug. */
  createProvider: () => PaymentProvider;
  /** Make the next call at `stage` throw. Omit if the rail cannot be made to fail. */
  injectFailure?: (provider: PaymentProvider, stage: PaymentProviderStage) => void;
  /** Produce a signed event the rail will verify. Omit if it cannot forge one. */
  signEventFor?: (
    provider: PaymentProvider,
    input: { paymentId: string; providerObjectId: string; status: 'succeeded' | 'processing' },
  ) => ProviderEventInput;
}

/** A charge every rail can handle: 25.00 EUR. */
const AMOUNT: Money = { amount: 2_500, currency: 'EUR' };

/** Run the contract suite against one rail. */
export function runPaymentProviderContract(options: PaymentProviderContractOptions): void {
  const paymentId = 'pay-contract-1';
  const create = () => ({
    paymentId,
    checkoutGroupId: 'group-contract-1',
    amount: AMOUNT,
    orderIds: ['order-1'],
    idempotencyKey: `pi:${paymentId}`,
    metadata: { paymentId, checkoutGroupId: 'group-contract-1' },
  });

  describe(`PaymentProvider contract — ${options.name}`, () => {
    it('runs authorize → capture → refund to a fully refunded payment', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      expect(created.providerObjectId).toBeTruthy();
      expect(created.status).toBe('created');

      const authorized = await provider.authorize({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `auth:${paymentId}`,
      });
      expect(authorized.status).toBe('processing');

      const captured = await provider.capture({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `cap:${paymentId}`,
      });
      expect(captured.status).toBe('succeeded');

      const refunded = await provider.refund({
        paymentId,
        providerObjectId: created.providerObjectId,
        refundId: 'refund-1',
        amount: AMOUNT,
        idempotencyKey: 're:refund-1',
      });
      expect(refunded.status).toBe('refunded');
      expect(refunded.providerObjectId).toBeTruthy();
    });

    it('lands a PARTIAL refund on partially_refunded, not refunded', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      await provider.capture({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `cap:${paymentId}`,
      });

      const partial = await provider.refund({
        paymentId,
        providerObjectId: created.providerObjectId,
        refundId: 'refund-partial',
        amount: { amount: 1_000, currency: 'EUR' },
        idempotencyKey: 're:refund-partial',
      });
      expect(partial.status).toBe('partially_refunded');

      // The remainder still refunds, and only then is it fully refunded — the
      // property that makes a two-step refund reach the same place as a one-step.
      const rest = await provider.refund({
        paymentId,
        providerObjectId: created.providerObjectId,
        refundId: 'refund-rest',
        amount: { amount: 1_500, currency: 'EUR' },
        idempotencyKey: 're:refund-rest',
      });
      expect(rest.status).toBe('refunded');
    });

    it('is idempotent: repeating createPayment yields the same provider object', async () => {
      const provider = options.createProvider();
      const first = await provider.createPayment(create());
      const second = await provider.createPayment(create());
      expect(second.providerObjectId).toBe(first.providerObjectId);
      expect(second.status).toBe(first.status);
    });

    it('is idempotent: repeating capture does not move a captured payment', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      const first = await provider.capture({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `cap:${paymentId}`,
      });
      const second = await provider.capture({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `cap:${paymentId}`,
      });
      expect(second.status).toBe(first.status);
      expect(second.status).toBe('succeeded');
    });

    it('refuses to refund a payment that was never captured', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      await expect(
        provider.refund({
          paymentId,
          providerObjectId: created.providerObjectId,
          refundId: 'refund-early',
          amount: AMOUNT,
          idempotencyKey: 're:refund-early',
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });

    it('refuses to cancel a captured payment', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      await provider.capture({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `cap:${paymentId}`,
      });
      await expect(
        provider.cancel({
          paymentId,
          providerObjectId: created.providerObjectId,
          idempotencyKey: `cancel:${paymentId}`,
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });

    it('reports the current status back through getStatus', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      await provider.capture({
        paymentId,
        providerObjectId: created.providerObjectId,
        idempotencyKey: `cap:${paymentId}`,
      });
      const read = await provider.getStatus(created.providerObjectId);
      expect(read.status).toBe('succeeded');
    });

    it('rejects an event whose signature does not verify, non-retryably', async () => {
      const provider = options.createProvider();
      const rejected: unknown = await provider
        .verifyEvent({ payload: '{"id":"evt_forged"}', signature: 'deadbeef' })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejected).toBeInstanceOf(PaymentProviderError);
      // Non-retryable specifically: a forged signature is never transient, and
      // retrying one is how a forgery eventually gets a lucky window.
      expect((rejected as PaymentProviderError).retryable).toBe(false);
    });

    const failureStages: PaymentProviderStage[] = [
      'createPayment',
      'authorize',
      'capture',
      'cancel',
      'refund',
      'getStatus',
    ];
    for (const stage of failureStages) {
      it(`surfaces an injected failure at ${stage} as a retryable-flagged error`, async () => {
        const inject = options.injectFailure;
        if (!inject) {
          // A rail that cannot be made to fail on demand skips this arm rather
          // than failing it — a live sandbox cannot decline on request.
          expect(inject).toBeUndefined();
          return;
        }
        const provider = options.createProvider();
        const created = await provider.createPayment(create());
        await provider.capture({
          paymentId,
          providerObjectId: created.providerObjectId,
          idempotencyKey: `cap:${paymentId}`,
        });

        inject(provider, stage);
        const call = async (): Promise<unknown> => {
          switch (stage) {
            case 'createPayment':
              return await provider.createPayment(create());
            case 'authorize':
              return await provider.authorize({
                paymentId,
                providerObjectId: created.providerObjectId,
                idempotencyKey: `auth:${paymentId}`,
              });
            case 'capture':
              return await provider.capture({
                paymentId,
                providerObjectId: created.providerObjectId,
                idempotencyKey: `cap:${paymentId}`,
              });
            case 'cancel':
              return await provider.cancel({
                paymentId,
                providerObjectId: created.providerObjectId,
                idempotencyKey: `cancel:${paymentId}`,
              });
            case 'refund':
              return await provider.refund({
                paymentId,
                providerObjectId: created.providerObjectId,
                refundId: 'refund-fail',
                amount: AMOUNT,
                idempotencyKey: 're:refund-fail',
              });
            default:
              return await provider.getStatus(created.providerObjectId);
          }
        };

        const thrown: unknown = await call().then(
          () => null,
          (error: unknown) => error,
        );
        expect(thrown).toBeInstanceOf(PaymentProviderError);
        expect(typeof (thrown as PaymentProviderError).retryable).toBe('boolean');
        expect((thrown as PaymentProviderError).stage).toBe(stage);
      });
    }

    it('converges on ONE state under duplicate and out-of-order events', async () => {
      const sign = options.signEventFor;
      if (!sign) {
        expect(sign).toBeUndefined();
        return;
      }
      const provider = options.createProvider();
      const created = await provider.createPayment(create());

      const success = sign(provider, {
        paymentId,
        providerObjectId: created.providerObjectId,
        status: 'succeeded',
      });
      const stale = sign(provider, {
        paymentId,
        providerObjectId: created.providerObjectId,
        status: 'processing',
      });

      const first = await provider.verifyEvent(success);
      const duplicate = await provider.verifyEvent(success);
      const outOfOrder = await provider.verifyEvent(stale);

      // A duplicate is BYTE-identical, including its id — which is what lets the
      // event store dedupe it without the service having to compare payloads.
      expect(duplicate.providerEventId).toBe(first.providerEventId);
      expect(duplicate.paymentStatus).toBe(first.paymentStatus);
      // An out-of-order event carries a DIFFERENT id, so it reaches the service
      // as a genuine event — and is refused there by the status CAS, not here.
      expect(outOfOrder.providerEventId).not.toBe(first.providerEventId);
      expect(outOfOrder.paymentStatus).toBe('processing');
    });
  });
}
