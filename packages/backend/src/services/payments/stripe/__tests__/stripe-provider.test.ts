/**
 * The Stripe adapter, against a FAKE Stripe client.
 *
 * Two things are under test and they are different in kind:
 *
 *  1. **The contract**, run through the shared `runPaymentProviderContract` — the
 *     properties `payment.service` relies on for every rail, plus the honest
 *     refusals this one declares (`authorize`, `capture`, `refund`). Those are
 *     asserted, not skipped: the suite checks each rejects non-retryably with the
 *     declared reason, because a rail that quietly returned a plausible result
 *     from an operation it never performed would pass a skipped test and fail a
 *     real customer.
 *  2. **The exact payload sent to Stripe**, which the contract suite cannot see.
 *     ADR 0001 D3/D4/D8/D11 are decisions that live entirely in the shape of two
 *     API calls — the intent's `transfer_group`, metadata, capture mode and
 *     method types, and the transfer's `source_transaction`, currency and
 *     idempotency key — so the only way to hold them is to inspect what the
 *     adapter handed the client.
 *
 * ## Why a fake client rather than a Stripe sandbox
 *
 * The sandbox cannot decline on request, cannot make a charge succeed without a
 * browser, and cannot be made to answer twice from one idempotency key on
 * demand. The fake can do all three, and everything it fakes is Stripe's side of
 * a boundary the adapter's whole job is to translate — the translation itself is
 * real code here. Signatures are the one exception: `verifyEvent` runs the SDK's
 * own verification against events signed with the SDK's own helper, because a
 * faked signature check is a security control that tests nothing.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import type { PaymentProvider, PaymentProviderStage } from '../../provider.js';
import { PaymentProviderError } from '../../provider.js';
import { runPaymentProviderContract } from '../../__tests__/provider-contract.js';

const WEBHOOK_SECRET = 'whsec_provider_suite_not_a_real_one';

/**
 * The fake Stripe API's state.
 *
 * Hoisted so the `vi.mock` factory below can close over it — a factory is
 * hoisted above every `const` in this file and would otherwise reference an
 * uninitialised binding.
 */
const api = vi.hoisted(() => ({
  intents: new Map<string, Record<string, unknown>>(),
  transfers: new Map<string, Record<string, unknown>>(),
  /** Charge id → the object a settled intent produced (#49). */
  charges: new Map<string, Record<string, unknown>>(),
  /** Refund id → the object `createStripeRefund` produced (#49). */
  refunds: new Map<string, Record<string, unknown>>(),
  /** Idempotency key → the object that key already produced. */
  byKey: new Map<string, Record<string, unknown>>(),
  /** Every create call, verbatim, so a payload can be ASSERTED rather than assumed. */
  intentCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  transferCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  refundCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  reversalCalls: [] as {
    transferId: string;
    params: Record<string, unknown>;
    idempotencyKey: string;
  }[],
  /** Which call should throw next, and as what — the suite's failure injection. */
  failures: new Map<string, { type: string; message: string; code?: string }>(),
  nextId: 0,
}));

/** Throw the injected failure for `hook`, if one is armed. */
function guard(hook: string): void {
  const failure = api.failures.get(hook);
  if (!failure) return;
  // A Stripe SDK error is a plain object with `type`/`code`/`message` as far as
  // the adapter's classifier is concerned, and building one by hand is what lets
  // this file assert that the classifier reads Stripe's OWN type rather than
  // guessing from the message.
  throw Object.assign(new Error(failure.message), { type: failure.type, code: failure.code });
}

vi.mock('../client.js', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  getStripeClient: () => {
    throw new Error('This suite must not construct a real Stripe client.');
  },
  resetStripeClient: () => undefined,
  createStripePaymentIntent: (params: Record<string, unknown>, idempotencyKey: string) => {
    guard('createPayment');
    api.intentCalls.push({ params, idempotencyKey });
    // Stripe's own idempotency: the same key returns the object it already made,
    // which is the single property standing between a retry and a second charge.
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    api.nextId += 1;
    const id = `pi_fake_${String(api.nextId)}`;
    const intent = {
      id,
      object: 'payment_intent',
      status: 'requires_payment_method',
      amount: params.amount,
      currency: params.currency,
      metadata: params.metadata,
      client_secret: `${id}_secret_fake`,
    };
    api.intents.set(id, intent);
    api.byKey.set(idempotencyKey, intent);
    return Promise.resolve(intent);
  },
  retrieveStripePaymentIntent: (id: string) => {
    guard('getStatus');
    const intent = api.intents.get(id);
    if (!intent) {
      throw Object.assign(new Error(`No such payment_intent: ${id}`), {
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
      });
    }
    return Promise.resolve(intent);
  },
  cancelStripePaymentIntent: (id: string) => {
    guard('cancel');
    const intent = api.intents.get(id);
    if (!intent) {
      throw Object.assign(new Error(`No such payment_intent: ${id}`), {
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
      });
    }
    if (intent.status === 'succeeded') {
      // Stripe's real refusal, and the one the sweep depends on reading: a
      // capture that beat the cancellation is information, not an obstacle.
      throw Object.assign(new Error('You cannot cancel this PaymentIntent because it has a status of succeeded.'), {
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
      });
    }
    intent.status = 'canceled';
    return Promise.resolve(intent);
  },
  createStripeTransfer: (params: Record<string, unknown>, idempotencyKey: string) => {
    guard('transfer');
    api.transferCalls.push({ params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    api.nextId += 1;
    const transfer = { id: `tr_fake_${String(api.nextId)}`, object: 'transfer', ...params };
    api.transfers.set(String(transfer.id), transfer);
    api.byKey.set(idempotencyKey, transfer);
    return Promise.resolve(transfer);
  },
  retrieveStripeTransfer: (id: string) => Promise.resolve(api.transfers.get(id)),
  /**
   * Refund a charge, the way Stripe does — including the two expansions the
   * adapter depends on and neither of which it may invent.
   *
   * `charge` is expanded because the PAYMENT's status after a refund is a
   * question about the charge's cumulative `amount_refunded`, not about this
   * refund's amount. `balance_transaction` is expanded because it is the only
   * statement of what the refund took off the PLATFORM balance, at the
   * refund-time rate (ADR 0001 D7).
   */
  createStripeRefund: (params: Record<string, unknown>, idempotencyKey: string) => {
    guard('refund');
    api.refundCalls.push({ params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const charge = api.charges.get(String(params.charge));
    if (!charge) {
      throw Object.assign(new Error(`No such charge: ${String(params.charge)}`), {
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
      });
    }
    const amount = Number(params.amount);
    if (Number(charge.amount_refunded) + amount > Number(charge.amount)) {
      throw Object.assign(new Error('Refund amount exceeds the charge amount.'), {
        type: 'StripeInvalidRequestError',
        code: 'amount_too_large',
      });
    }
    charge.amount_refunded = Number(charge.amount_refunded) + amount;

    api.nextId += 1;
    const refund = {
      id: `re_fake_${String(api.nextId)}`,
      object: 'refund',
      amount,
      currency: charge.currency,
      status: 'succeeded',
      metadata: params.metadata,
      charge,
      balance_transaction: {
        id: `txn_re_${String(api.nextId)}`,
        object: 'balance_transaction',
        // Negative: funds LEAVING the platform balance. The adapter takes the
        // magnitude, and a fake that reported it positive would hide that.
        amount: -amount,
        currency: charge.currency,
        fee: 0,
        exchange_rate: null,
        created: Math.floor(Date.now() / 1000),
      },
    };
    api.refunds.set(refund.id, refund);
    api.byKey.set(idempotencyKey, refund);
    return Promise.resolve(refund);
  },
  retrieveStripeRefund: (id: string) => {
    const refund = api.refunds.get(id);
    if (!refund) throw new Error(`No fake refund registered for ${id}`);
    return Promise.resolve(refund);
  },
  createStripeTransferReversal: (
    transferId: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    guard('transfer');
    api.reversalCalls.push({ transferId, params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const transfer = api.transfers.get(transferId);
    if (!transfer) {
      throw Object.assign(new Error(`No such transfer: ${transferId}`), {
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
      });
    }
    transfer.amount_reversed = Number(transfer.amount_reversed ?? 0) + Number(params.amount);

    api.nextId += 1;
    const reversal = {
      id: `trr_fake_${String(api.nextId)}`,
      object: 'transfer_reversal',
      amount: params.amount,
      // The reversal reports the TRANSFER, whose reversed total is cumulative —
      // which is what the adapter hands back so a caller never has to add this
      // leg to a figure it read before the call.
      transfer,
    };
    api.byKey.set(idempotencyKey, reversal);
    return Promise.resolve(reversal);
  },
  retrieveStripeChargeWithBalance: () => {
    throw new Error('The adapter suite reads no balance transactions.');
  },
  retrieveStripeChargeWithRefunds: () => {
    throw new Error('The adapter suite reads no charge refund lists.');
  },
  retrieveStripeDispute: () => {
    throw new Error('The adapter suite reads no disputes.');
  },
  retrieveStripePayout: () => {
    throw new Error('The adapter suite reads no payouts.');
  },
  createStripeConnectedAccount: () => {
    throw new Error('The adapter suite creates no connected accounts.');
  },
  retrieveStripeAccount: () => {
    throw new Error('The adapter suite reads no connected accounts.');
  },
  createStripeAccountLink: () => {
    throw new Error('The adapter suite mints no account links.');
  },
}));

let StripePaymentProvider: typeof import('../stripe-provider.js').StripePaymentProvider;

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_provider_suite_connect';

  ({ StripePaymentProvider } = await import('../stripe-provider.js'));
});

beforeEach(() => {
  api.intents.clear();
  api.transfers.clear();
  api.charges.clear();
  api.refunds.clear();
  api.byKey.clear();
  api.intentCalls.length = 0;
  api.transferCalls.length = 0;
  api.refundCalls.length = 0;
  api.reversalCalls.length = 0;
  api.failures.clear();
  api.nextId = 0;
});

/** Sign an event the way Stripe would, so the REAL verification runs. */
async function signedEvent(input: {
  id: string;
  type: string;
  intentId: string;
  status: string;
}): Promise<{ payload: string; signature: string }> {
  const payload = JSON.stringify({
    id: input.id,
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: input.type,
    data: {
      object: {
        id: input.intentId,
        object: 'payment_intent',
        status: input.status,
        amount: 2_500,
        currency: 'eur',
        metadata: { paymentId: 'pay-contract-1' },
      },
    },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

// The shared contract, with this rail's honest refusals declared. `settle` is
// what a card rail's success actually is: the BUYER confirms and Stripe captures
// in the same movement, so the fake moves the intent rather than the adapter
// calling a capture that does not exist.
//
// #49 moved `refund` out of `unsupported`, which un-skips two arms that had
// never run against this rail — the partial-refund walk and the injected refund
// failure. Both now exercise the real adapter against the fake, which is the
// point of declaring a rail's refusals rather than skipping its tests.
runPaymentProviderContract({
  name: 'StripePaymentProvider (fake Stripe client)',
  createProvider: () => new StripePaymentProvider(),
  settle: (_provider, input) => {
    const intent = api.intents.get(input.providerObjectId);
    if (!intent) throw new Error(`No fake intent for ${input.providerObjectId}`);
    intent.status = 'succeeded';
    // A settled intent has a CHARGE, and the refund path resolves it from here
    // rather than being handed one — "which charge funded this payment" is a
    // Stripe question and a `chargeId` on a provider-neutral request would be
    // the first Stripe noun to cross the seam. A fake that skipped this would
    // let the adapter's `resolveChargeId` go untested.
    const chargeId = `ch_fake_${String(input.providerObjectId)}`;
    intent.latest_charge = chargeId;
    api.charges.set(chargeId, {
      id: chargeId,
      object: 'charge',
      amount: intent.amount,
      currency: intent.currency,
      amount_refunded: 0,
    });
    return Promise.resolve();
  },
  unsupported: {
    authorize: 'Stripe payments are authorized by the buyer',
    capture: 'capture automatically on confirmation',
  },
  injectFailure: (_provider: PaymentProvider, stage: PaymentProviderStage) => {
    api.failures.set(stage, {
      // A connection error: Stripe's own classification of a transient failure,
      // so the adapter must mark it retryable.
      type: 'StripeConnectionError',
      message: 'An error occurred with our connection to Stripe.',
      code: 'connection_error',
    });
  },
});

describe('StripePaymentProvider — the PaymentIntent it creates', () => {
  const request = {
    paymentId: 'pay-1',
    checkoutGroupId: 'group-1',
    amount: { amount: 4_500, currency: 'EUR' as const },
    orderIds: ['order-a', 'order-b'],
    idempotencyKey: 'pi:pay-1',
    metadata: { paymentId: 'pay-1', checkoutGroupId: 'group-1', orderCount: '2' },
  };

  it('sends exactly what ADR 0001 D3, D4, D8 and D11 require', async () => {
    const provider = new StripePaymentProvider();
    const result = await provider.createPayment(request);

    expect(api.intentCalls).toHaveLength(1);
    const [call] = api.intentCalls;
    expect(call.params).toEqual({
      // D8: the charge is created in the BUYER's presentment currency, and
      // Stripe's API takes it lowercase.
      amount: 4_500,
      currency: 'eur',
      // D3: immediate capture. A card authorization lasts 2–7 days, which is
      // shorter than realistic secondhand fulfilment.
      capture_method: 'automatic',
      // D3: cards and card-based wallets only. Explicit rather than
      // `automatic_payment_methods`, which would move the decision into a Stripe
      // dashboard toggle that could enable an asynchronous method.
      payment_method_types: ['card'],
      // D3/D4: one charge per checkout group, tying every seller transfer to it.
      transfer_group: 'group-1',
      // D11: the correlation the webhook resolver reads. Server-issued ids only.
      metadata: { paymentId: 'pay-1', checkoutGroupId: 'group-1', orderCount: '2' },
    });
    // D11 again: the key is derived from Mercaria's durable payment id, never
    // from anything request-scoped.
    expect(call.idempotencyKey).toBe('pi:pay-1');

    expect(result.status).toBe('requires_action');
    expect(result.clientAction).toEqual({
      kind: 'client_secret',
      value: `${result.providerObjectId}_secret_fake`,
    });
  });

  it('converges on ONE intent when the same request is made twice', async () => {
    const provider = new StripePaymentProvider();
    const first = await provider.createPayment(request);
    const second = await provider.createPayment(request);

    // Two calls reached Stripe — a retry is a real request — and Stripe answered
    // both from one object. That is the property that makes a double-tapped
    // checkout one charge, and it is the rail's, not Mercaria's.
    expect(api.intentCalls).toHaveLength(2);
    expect(second.providerObjectId).toBe(first.providerObjectId);
    expect(api.intents.size).toBe(1);
  });

  it('reads an existing intent instead of creating a second one', async () => {
    const provider = new StripePaymentProvider();
    const created = await provider.createPayment(request);
    api.intentCalls.length = 0;

    const resumed = await provider.resumePayment(created.providerObjectId);

    // No create call at all: an idempotency key expires (Stripe's after 24
    // hours) and a buyer returning the next day must not be handed a SECOND
    // charge for orders the first one can still fund.
    expect(api.intentCalls).toHaveLength(0);
    expect(resumed.providerObjectId).toBe(created.providerObjectId);
    expect(resumed.clientAction?.value).toBe(created.clientAction?.value);
  });

  it('refuses to cancel a captured intent, non-retryably', async () => {
    const provider = new StripePaymentProvider();
    const created = await provider.createPayment(request);
    const intent = api.intents.get(created.providerObjectId);
    if (intent) intent.status = 'succeeded';

    const thrown: unknown = await provider
      .cancel({
        paymentId: 'pay-1',
        providerObjectId: created.providerObjectId,
        idempotencyKey: 'cancel:pay-1',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(PaymentProviderError);
    // Non-retryable, and that classification is load-bearing: the sweep treats
    // this refusal as evidence the money arrived, marks the payment canceled
    // locally anyway, and lets the succeeded event raise its exception.
    expect((thrown as PaymentProviderError).retryable).toBe(false);
    expect((thrown as PaymentProviderError).code).toBe('payment_intent_unexpected_state');
  });
});

describe('StripePaymentProvider — the Transfer it creates', () => {
  it('sends the seller net in the platform currency, drawn from the charge', async () => {
    const provider = new StripePaymentProvider();
    const created = await provider.createPayment({
      paymentId: 'pay-2',
      checkoutGroupId: 'group-2',
      amount: { amount: 9_000, currency: 'EUR' },
      orderIds: ['order-x'],
      idempotencyKey: 'pi:pay-2',
      metadata: { paymentId: 'pay-2' },
    });
    // A funded intent names its charge; the adapter resolves it from there
    // rather than taking a charge id through the provider-neutral request.
    const intent = api.intents.get(created.providerObjectId);
    if (intent) {
      intent.status = 'succeeded';
      intent.latest_charge = 'ch_fake_2';
    }

    const result = await provider.createTransfer({
      paymentId: 'pay-2',
      orderId: 'order-x',
      sourcePaymentObjectId: created.providerObjectId,
      destinationAccountId: 'acct_seller_x',
      amount: { amount: 9_000, currency: 'EUR' },
      groupRef: 'group-2',
      idempotencyKey: 'tr:pay-2:order-x',
      metadata: { orderId: 'order-x', paymentId: 'pay-2' },
    });

    expect(api.transferCalls).toHaveLength(1);
    const [call] = api.transferCalls;
    expect(call.params).toEqual({
      amount: 9_000,
      currency: 'eur',
      destination: 'acct_seller_x',
      // ADR 0001 D3 / fact 5: the transfer waits for the charge's funds instead
      // of failing against a platform balance that has not landed.
      source_transaction: 'ch_fake_2',
      transfer_group: 'group-2',
      metadata: { orderId: 'order-x', paymentId: 'pay-2' },
    });
    expect(call.idempotencyKey).toBe('tr:pay-2:order-x');
    expect(result.status).toBe('paid');
  });

  it('refuses to transfer from an intent that never captured', async () => {
    const provider = new StripePaymentProvider();
    const created = await provider.createPayment({
      paymentId: 'pay-3',
      checkoutGroupId: 'group-3',
      amount: { amount: 1_000, currency: 'EUR' },
      orderIds: ['order-y'],
      idempotencyKey: 'pi:pay-3',
      metadata: { paymentId: 'pay-3' },
    });

    const thrown: unknown = await provider
      .createTransfer({
        paymentId: 'pay-3',
        orderId: 'order-y',
        sourcePaymentObjectId: created.providerObjectId,
        destinationAccountId: 'acct_seller_y',
        amount: { amount: 1_000, currency: 'EUR' },
        groupRef: 'group-3',
        idempotencyKey: 'tr:pay-3:order-y',
        metadata: {},
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // Money that has not arrived cannot be paid out, and no retry changes that.
    expect(thrown).toBeInstanceOf(PaymentProviderError);
    expect((thrown as PaymentProviderError).retryable).toBe(false);
    expect((thrown as PaymentProviderError).code).toBe('missing_charge');
    expect(api.transferCalls).toHaveLength(0);
  });
});

describe('StripePaymentProvider — verifyEvent', () => {
  it('accepts a genuinely signed event and normalizes it', async () => {
    const provider = new StripePaymentProvider();
    const event = await signedEvent({
      id: 'evt_provider_ok',
      type: 'payment_intent.succeeded',
      intentId: 'pi_signed',
      status: 'succeeded',
    });

    const envelope = await provider.verifyEvent(event);

    expect(envelope.provider).toBe('stripe');
    expect(envelope.providerEventId).toBe('evt_provider_ok');
    expect(envelope.paymentStatus).toBe('succeeded');
    expect(envelope.objectIds).toEqual({ paymentIntent: 'pi_signed' });
    expect(envelope.livemode).toBe(false);
  });

  it('refuses an event signed with the wrong secret', async () => {
    const provider = new StripePaymentProvider();
    const { payload } = await signedEvent({
      id: 'evt_provider_forged',
      type: 'payment_intent.succeeded',
      intentId: 'pi_forged',
      status: 'succeeded',
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: 'whsec_someone_elses_secret',
    });

    const thrown: unknown = await provider.verifyEvent({ payload, signature }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PaymentProviderError);
    expect((thrown as PaymentProviderError).retryable).toBe(false);
  });
});
