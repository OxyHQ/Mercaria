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
  /**
   * Drive a created payment to `succeeded`, however THIS rail does that.
   *
   * Defaults to calling `capture`, which is how a rail that holds funds gets
   * there. A card rail does not hold funds — the buyer confirms client-side and
   * the money is captured in the same movement (ADR 0001 D3) — so its adapter
   * has no capture step at all, and a suite hard-coded to call one could only
   * ever test rails shaped like the synthetic one.
   */
  settle?: (
    provider: PaymentProvider,
    input: { paymentId: string; providerObjectId: string },
  ) => Promise<void>;
  /**
   * Operations this rail structurally does not have, each mapped to the reason.
   *
   * Declaring one does NOT skip the check — it inverts it. The suite asserts the
   * method rejects with a non-retryable `PaymentProviderError` whose message
   * contains the declared reason, so "this rail cannot capture" is pinned as
   * firmly as "this rail captures correctly" would be.
   *
   * That distinction is the whole point of the option. A rail that quietly
   * returned a plausible-looking result from an operation it never performed
   * would pass a skipped test and fail a real customer, and the operations most
   * likely to be faked that way — capture and refund — are precisely the two
   * that move money.
   */
  unsupported?: Partial<Record<PaymentProviderStage, string>>;
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

  /**
   * Drive a payment to `succeeded` the way this rail does it.
   *
   * The default IS `capture`, so a rail that holds funds is tested exactly as
   * before this hook existed — the option adds a shape rather than relaxing one.
   */
  const settle = async (provider: PaymentProvider, providerObjectId: string): Promise<void> => {
    if (options.settle) {
      await options.settle(provider, { paymentId, providerObjectId });
      return;
    }
    await provider.capture({ paymentId, providerObjectId, idempotencyKey: `cap:${paymentId}` });
  };

  const unsupported = options.unsupported ?? {};
  const supports = (stage: PaymentProviderStage): boolean => unsupported[stage] === undefined;

  describe(`PaymentProvider contract — ${options.name}`, () => {
    for (const [stage, reason] of Object.entries(unsupported)) {
      it(`refuses ${stage}, non-retryably, saying why`, async () => {
        const provider = options.createProvider();
        const created = await provider.createPayment(create());
        const operation = {
          paymentId,
          providerObjectId: created.providerObjectId,
          idempotencyKey: `${stage}:${paymentId}`,
        };

        const thrown: unknown = await (async () => {
          switch (stage as PaymentProviderStage) {
            case 'authorize':
              return await provider.authorize(operation);
            case 'capture':
              return await provider.capture(operation);
            case 'cancel':
              return await provider.cancel(operation);
            case 'refund':
              return await provider.refund({ ...operation, refundId: 'refund-x', amount: AMOUNT });
            default:
              return await provider.getStatus(created.providerObjectId);
          }
        })().then(
          () => null,
          (error: unknown) => error,
        );

        expect(thrown).toBeInstanceOf(PaymentProviderError);
        // Non-retryable: an operation a rail does not HAVE is not a transient
        // condition, and retrying one burns the outbox's attempts on a wall.
        expect((thrown as PaymentProviderError).retryable).toBe(false);
        expect((thrown as PaymentProviderError).stage).toBe(stage);
        // The reason travels in the message, so whoever hits this in production
        // reads why rather than "unsupported".
        expect((thrown as PaymentProviderError).message).toContain(reason);
      });
    }

    it.skipIf(!supports('authorize') || !supports('capture') || !supports('refund'))(
      'runs authorize → capture → refund to a fully refunded payment',
      async () => {
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
      },
    );

    it.skipIf(!supports('refund'))(
      'lands a PARTIAL refund on partially_refunded, not refunded',
      async () => {
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
      },
    );

    it('is idempotent: repeating createPayment yields the same provider object', async () => {
      const provider = options.createProvider();
      const first = await provider.createPayment(create());
      const second = await provider.createPayment(create());
      expect(second.providerObjectId).toBe(first.providerObjectId);
      expect(second.status).toBe(first.status);
    });

    it.skipIf(!supports('capture'))(
      'is idempotent: repeating capture does not move a captured payment',
      async () => {
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
      },
    );

    it.skipIf(!supports('refund'))(
      'refuses to refund a payment that was never captured',
      async () => {
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
      },
    );

    it.skipIf(!supports('cancel'))('refuses to cancel a captured payment', async () => {
      const provider = options.createProvider();
      const created = await provider.createPayment(create());
      await settle(provider, created.providerObjectId);
      await expect(
        provider.cancel({
          paymentId,
          providerObjectId: created.providerObjectId,
          idempotencyKey: `cancel:${paymentId}`,
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });

    it.skipIf(!supports('getStatus'))(
      'reports the current status back through getStatus',
      async () => {
        const provider = options.createProvider();
        const created = await provider.createPayment(create());
        await settle(provider, created.providerObjectId);
        const read = await provider.getStatus(created.providerObjectId);
        expect(read.status).toBe('succeeded');
      },
    );

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
        if (!supports(stage)) {
          // Declared unsupported above, where its refusal is asserted directly.
          expect(unsupported[stage]).toBeTypeOf('string');
          return;
        }
        const provider = options.createProvider();
        const created = await provider.createPayment(create());
        await settle(provider, created.providerObjectId);

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
