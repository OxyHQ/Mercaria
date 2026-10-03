/**
 * The Peable rail against `runPaymentProviderContract`, UNMODIFIED.
 *
 * ADR 0009 D18 makes that suite the gate a new rail passes before it carries
 * money, and "unmodified" is the load-bearing word: a suite bent to fit an
 * adapter proves the adapter matches the suite, which is the opposite of what
 * it is for. The only accommodation used is the `settle` hook the suite already
 * offers, because a card rail has no capture step — the buyer confirms
 * client-side and the money moves in one go (ADR 0001 D3).
 *
 * ## What the fake gateway is, and what it is not
 *
 * An in-memory implementation of the GATEWAY's contract, not of the adapter's.
 * It holds intents, refunds and transfers, honours the idempotency the real one
 * honours, and answers in the real one's shapes. That is what makes this suite
 * able to catch the failures that matter here: a wrong field name, an
 * idempotency key that is not derived from a durable id, an amount that does
 * not survive the crossing.
 *
 * It is NOT a substitute for a real gateway call. ADR 0009 D18 lists the three
 * things no test establishes, and this file does not pretend to be any of them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { PaymentProviderStage } from '../provider.js';
import { PaymentProviderError } from '../provider.js';

/** The gateway's own state, per intent. */
interface FakeIntent {
  id: string;
  status: string;
  amount: string;
  currency: string;
  refundedMinor: number;
}

const intents = new Map<string, FakeIntent>();
/** Keyed by the gateway's own idempotency: `(merchant, externalRef)`. */
const refundsByRef = new Map<string, { id: string; amount: string; intentId: string }>();
const transfersByRef = new Map<string, { id: string; intentId: string; reversedMinor: number }>();
/** Keyed by `Idempotency-Key`, which is what the create path converges on. */
const intentsByKey = new Map<string, string>();
let nextId = 0;
let failNextStage: PaymentProviderStage | null = null;
const wire: FakeRequest[] = [];
let mintCount = 0;
let rejectRequests = 0;
let forcedStatus: number | null = null;
let dropAfterEffect = false;
let refundLifecycle: 'pending' | 'failed' | null = null;

const WEBHOOK_SECRET = 'whsec_contract_peable';

function reset(): void {
  intents.clear();
  refundsByRef.clear();
  transfersByRef.clear();
  intentsByKey.clear();
  nextId = 0;
  failNextStage = null;
  wire.length = 0; mintCount = 0; rejectRequests = 0; forcedStatus = null; dropAfterEffect = false; refundLifecycle = null;
}

interface FakeRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  stage: PaymentProviderStage;
  idempotencyKey?: string;
}

/**
 * The fake gateway.
 *
 * Every branch mirrors a real route, including the two status codes that carry
 * meaning — a converged create answers with the SAME object rather than a new
 * one, which is the property the adapter's idempotency depends on.
 */
async function fakeGateway(request: FakeRequest): Promise<unknown> {
  if (failNextStage !== null && failNextStage === request.stage) {
    failNextStage = null;
    throw new PaymentProviderError({
      provider: 'peable',
      stage: request.stage,
      message: 'injected gateway failure',
      retryable: true,
    });
  }

  const body = request.body ?? {};

  if (request.method === 'POST' && request.path === '/v1/payment_intents') {
    const key = request.idempotencyKey ?? '';
    const existing = intentsByKey.get(key);
    if (existing !== undefined) {
      const intent = intents.get(existing);
      return { ...intent, client_action: { kind: 'client_secret', value: `${existing}_secret` } };
    }
    nextId += 1;
    const id = `pi_fake_${String(nextId)}`;
    intents.set(id, {
      id,
      status: 'created',
      amount: String(body.amount),
      currency: String(body.currency),
      refundedMinor: 0,
    });
    intentsByKey.set(key, id);
    return { ...intents.get(id), client_action: { kind: 'client_secret', value: `${id}_secret` } };
  }

  const intentMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(request.path);
  if (request.method === 'GET' && intentMatch) {
    const intent = intents.get(decodeURIComponent(intentMatch[1] ?? ''));
    if (!intent) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: 'payment intent not found',
        retryable: false,
      });
    }
    return { ...intent, client_action: { kind: 'client_secret', value: `${intent.id}_secret` } };
  }

  const rejectMatch = /^\/v1\/payment_intents\/([^/]+)\/reject$/.exec(request.path);
  if (request.method === 'POST' && rejectMatch) {
    const intent = intents.get(decodeURIComponent(rejectMatch[1] ?? ''));
    if (!intent) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: 'payment intent not found',
        retryable: false,
      });
    }
    // The real gateway's `LEGAL_SOURCES` allows `card_canceled` only from
    // `created` and `requires_action`. Cancelling a payment that already took
    // the buyer's money is not a cancellation, it is a refund — and a fake that
    // allowed it would let an adapter through that calls the wrong one.
    if (intent.status !== 'created' && intent.status !== 'requires_action') {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: `a payment in '${intent.status}' cannot be cancelled`,
        retryable: false,
      });
    }
    intent.status = 'rejected';
    return { ...intent };
  }

  if (request.method === 'POST' && request.path === '/v1/refunds') {
    const ref = String(body.externalRef);
    const intent = intents.get(String(body.paymentIntentId));
    if (!intent) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'refund',
        message: 'payment intent not found',
        retryable: false,
      });
    }
    // The real gateway refuses a refund unless the payment settled. Mirrored
    // here because the contract suite asserts exactly that refusal, and a fake
    // that refunded anything would pass an adapter that never checks.
    if (intent.status !== 'settled' && intent.status !== 'partially_refunded') {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'refund',
        message: `a refund needs a settled payment; this one is '${intent.status}'`,
        retryable: false,
      });
    }
    const existing = refundsByRef.get(ref);
    if (existing) {
      // The converged retry: the SAME refund, and no second movement.
      return {
        id: existing.id,
        status: 'succeeded',
        paymentStatus: intent.status,
        failureCode: null,
      };
    }
    const amount = Number(body.amount);
    if (intent.refundedMinor + amount > Number(intent.amount)) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'refund',
        message: 'a refund exceeds the remaining balance',
        retryable: false,
      });
    }
    nextId += 1;
    const id = `re_fake_${String(nextId)}`;
    intent.refundedMinor += amount;
    intent.status =
      intent.refundedMinor >= Number(intent.amount) ? 'refunded' : 'partially_refunded';
    refundsByRef.set(ref, { id, amount: String(amount), intentId: intent.id });
    return { id, status: 'succeeded', paymentStatus: intent.status, failureCode: null };
  }

  if (request.method === 'POST' && request.path === '/v1/transfers') {
    const ref = String(body.externalRef);
    const existing = transfersByRef.get(ref);
    if (existing) return { id: existing.id, status: 'paid', amountReversed: '0' };
    nextId += 1;
    const id = `tr_fake_${String(nextId)}`;
    transfersByRef.set(ref, { id, intentId: String(body.paymentIntentId), reversedMinor: 0 });
    return { id, status: 'paid', amountReversed: '0' };
  }

  const reversalMatch = /^\/v1\/transfers\/([^/]+)\/reversals$/.exec(request.path);
  if (request.method === 'POST' && reversalMatch) {
    const transferId = decodeURIComponent(reversalMatch[1] ?? '');
    const entry = [...transfersByRef.values()].find((row) => row.id === transferId);
    if (!entry) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'transfer',
        message: 'transfer not found',
        retryable: false,
      });
    }
    entry.reversedMinor += Number(body.amount);
    return {
      id: entry.id,
      status: 'partially_reversed',
      // CUMULATIVE, which is what the adapter must report back.
      amountReversed: String(entry.reversedMinor),
    };
  }

  throw new Error(`the fake gateway has no route for ${request.method} ${request.path}`);
}

// Exercise the published SDK, including token mint and HTTP serialization.
// Only the gateway/provider boundary is synthetic; no local client is mocked.
let gatewayUrl = '';
const gateway = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/auth/service-token') {
    mintCount += 1;
    res.end(JSON.stringify({ data: { token: 'synthetic-service-token', expiresIn: 300 } }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const path = req.url ?? '';
  const stage: PaymentProviderStage = path === '/v1/payment_intents' ? 'createPayment'
    : path.endsWith('/reject') ? 'cancel' : path === '/v1/refunds' ? 'refund'
    : path.startsWith('/v1/transfers') ? 'transfer' : 'getStatus';
  const key = req.headers['idempotency-key'];
  try {
    const request: FakeRequest = { method: req.method ?? 'GET', path, stage,
      ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}),
      ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
    };
    wire.push(request);
    if (rejectRequests > 0 || forcedStatus !== null) {
      res.statusCode = forcedStatus ?? 401;
      rejectRequests = Math.max(0, rejectRequests - 1);
      res.end(JSON.stringify({ error: { type: 'fixture_refusal', message: 'synthetic-sensitive-detail' } }));
      return;
    }
    const result = await fakeGateway(request);
    if (dropAfterEffect) {
      dropAfterEffect = false;
      res.writeHead(200, { 'content-length': '2000' }); res.write('{');
      setTimeout(() => res.destroy(), 10); return;
    }
    if (refundLifecycle && path === '/v1/refunds' && typeof result === 'object' && result !== null) {
      res.end(JSON.stringify({ ...result, status: refundLifecycle, failureCode: refundLifecycle === 'failed' ? 'fixture_decline' : null }));
      return;
    }
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error instanceof PaymentProviderError && !error.retryable ? 400 : 503;
    res.end(JSON.stringify({ error: { type: 'fixture_error', message: 'Synthetic gateway refusal' } }));
  }
});
beforeAll(async () => {
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('Missing local gateway port');
  gatewayUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  gateway.closeAllConnections();
  await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()));
});

vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      payments: {
        ...actual.config.payments,
        peable: {
          enabled: true,
          get baseUrl() { return gatewayUrl; },
          get oxyApiUrl() { return gatewayUrl; },
          publicKey: 'pk',
          secret: 'sk',
          webhookSecret: WEBHOOK_SECRET,
          livemode: false,
        },
      },
    },
  };
});

const { PeablePaymentProvider } = await import('../peable/peable-provider.js');
const { runPaymentProviderContract } = await import('./provider-contract.js');

beforeEach(() => {
  reset();
});

runPaymentProviderContract({
  name: 'PeablePaymentProvider',
  createProvider: () => new PeablePaymentProvider(),
  injectFailure: (_provider, stage) => {
    failNextStage = stage;
  },
  /**
   * Declaring these does NOT skip a check — it INVERTS one. The suite asserts
   * each rejects non-retryably with the declared reason in the message, so
   * "this rail has no capture" is pinned as firmly as "this rail captures
   * correctly" would be.
   *
   * My first adapter returned a read from both instead, and the suite caught
   * it: an operation that reports success having done nothing is exactly the
   * green nothing a contract suite exists to refuse.
   */
  unsupported: {
    authorize: 'authorized by the buyer, client-side',
    capture: 'capture automatically on confirmation',
  },
  /**
   * A card rail has NO capture step: the buyer confirms client-side and the
   * money is captured in the same movement (ADR 0001 D3). Settling here is
   * therefore what the gateway's own event does — the payment reaches `settled`
   * — and the adapter reads it back.
   */
  settle: async (provider, { providerObjectId }) => {
    const intent = intents.get(providerObjectId);
    if (intent) intent.status = 'settled';
    await provider.getStatus(providerObjectId);
  },
  signEventFor: (_provider, { providerObjectId, status }) => {
    // A DISTINCT id per event. The suite's convergence case sends a duplicate
    // and then an out-of-order event, and asserts the second carries a
    // different id — a fixed id would make the two indistinguishable and hide
    // the very thing being checked.
    nextId += 1;
    const payload = JSON.stringify({
      id: `evt_contract_${providerObjectId}_${String(nextId)}`,
      object: 'event',
      type: status === 'succeeded' ? 'payment_intent.settled' : 'payment_intent.confirming',
      created: new Date().toISOString(),
      data: { object: { id: providerObjectId } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${String(timestamp)}.${payload}`)
      .digest('hex');
    return { payload, signature: `t=${String(timestamp)},v1=${signature}` };
  },
});

/**
 * Beyond the contract: the half of `SettlingPaymentProvider` the shared suite
 * does not reach.
 *
 * ADR 0009 D18 names this gap explicitly — `runPaymentProviderContract` covers
 * `PaymentProvider` and NOT `createTransfer`/`reverseTransfer`, which is the
 * half that moves sellers' money and takes it back. Writing it was part of this
 * work rather than a follow-up: a settling rail that passed only the shared
 * suite would have proved nothing about the operations a seller's balance
 * depends on.
 */
describe('PeablePaymentProvider settlement', () => {
  const AMOUNT = { amount: 2_500, currency: 'EUR' as const };

  async function settledPayment(): Promise<string> {
    const provider = new PeablePaymentProvider();
    const created = await provider.createPayment({
      paymentId: 'pay-settle-1',
      checkoutGroupId: 'group-settle-1',
      amount: { amount: 10_000, currency: 'EUR' },
      orderIds: ['order-1'],
      idempotencyKey: 'pi:pay-settle-1',
      metadata: {},
    });
    const intent = intents.get(created.providerObjectId);
    if (intent) intent.status = 'settled';
    return created.providerObjectId;
  }

  test('settles a seller order and reports the gateway transfer id', async () => {
    const provider = new PeablePaymentProvider();
    const sourceId = await settledPayment();

    const result = await provider.createTransfer({
      paymentId: 'pay-settle-1',
      orderId: 'order-1',
      sourcePaymentObjectId: sourceId,
      destinationAccountId: 'ca_seller_1',
      amount: AMOUNT,
      groupRef: 'group-settle-1',
      idempotencyKey: 'tr:order-1',
      metadata: {},
    });

    expect(result.providerObjectId).toMatch(/^tr_fake_/);
    expect(result.status).toBe('paid');
  });

  /**
   * Mercaria's ORDER id is the idempotency, durably. A retried settlement
   * converges on the transfer that already paid this seller rather than paying
   * them twice — and unlike an `Idempotency-Key` header the order id cannot be
   * lost by a caller that never saw the response.
   */
  test('a retried settlement of one order converges rather than paying twice', async () => {
    const provider = new PeablePaymentProvider();
    const sourceId = await settledPayment();
    const request = {
      paymentId: 'pay-settle-1',
      orderId: 'order-dup',
      sourcePaymentObjectId: sourceId,
      destinationAccountId: 'ca_seller_1',
      amount: AMOUNT,
      groupRef: 'group-settle-1',
      idempotencyKey: 'tr:order-dup',
      metadata: {},
    };

    const first = await provider.createTransfer(request);
    const second = await provider.createTransfer(request);

    expect(second.providerObjectId).toBe(first.providerObjectId);
    expect(transfersByRef.size).toBe(1);
  });

  /**
   * The CUMULATIVE total, read off the transfer — never this leg.
   *
   * A caller deciding whether a transfer is fully reversed must not have to add
   * up legs it may not all have seen, and reporting this one would make a
   * second partial reversal look like the first.
   */
  test('a reversal reports the cumulative total, not this leg', async () => {
    const provider = new PeablePaymentProvider();
    const sourceId = await settledPayment();
    const transfer = await provider.createTransfer({
      paymentId: 'pay-settle-1',
      orderId: 'order-rev',
      sourcePaymentObjectId: sourceId,
      destinationAccountId: 'ca_seller_1',
      amount: { amount: 10_000, currency: 'EUR' },
      groupRef: 'group-settle-1',
      idempotencyKey: 'tr:order-rev',
      metadata: {},
    });

    const first = await provider.reverseTransfer({
      paymentId: 'pay-settle-1',
      orderId: 'order-rev',
      transferObjectId: transfer.providerObjectId,
      amount: { amount: 3_000, currency: 'EUR' },
      idempotencyKey: 'trr:order-rev:3000',
      metadata: {},
    });
    const second = await provider.reverseTransfer({
      paymentId: 'pay-settle-1',
      orderId: 'order-rev',
      transferObjectId: transfer.providerObjectId,
      amount: { amount: 2_000, currency: 'EUR' },
      idempotencyKey: 'trr:order-rev:2000',
      metadata: {},
    });

    expect(first.totalReversedMinor).toBe(3_000);
    // 5000, not 2000. This is the assertion that fails if the adapter ever
    // starts reporting the leg it just sent.
    expect(second.totalReversedMinor).toBe(5_000);
    expect(wire.slice(-2).map(row => ({ key: row.idempotencyKey, body: row.body }))).toEqual([
      { key: 'trr:order-rev:3000', body: { amount: '3000' } },
      { key: 'trr:order-rev:2000', body: { amount: '2000' } },
    ]);
  });

  /**
   * An amount that cannot survive the crossing is REFUSED, not rounded.
   *
   * `Money.amount` is a JS `number`; above `Number.MAX_SAFE_INTEGER` — reachable
   * in a minor-unit currency — the value is already wrong before it reaches the
   * adapter, and sending it would move an amount nobody chose. Permanent,
   * because no retry makes a number representable.
   */
  test('refuses an amount that is not a safe integer of minor units', async () => {
    const provider = new PeablePaymentProvider();
    const sourceId = await settledPayment();

    const attempt = provider.createTransfer({
      paymentId: 'pay-settle-1',
      orderId: 'order-unsafe',
      sourcePaymentObjectId: sourceId,
      destinationAccountId: 'ca_seller_1',
      amount: { amount: Number.MAX_SAFE_INTEGER + 2, currency: 'EUR' },
      groupRef: 'group-settle-1',
      idempotencyKey: 'tr:order-unsafe',
      metadata: {},
    });

    await expect(attempt).rejects.toThrow(PaymentProviderError);
    await expect(attempt).rejects.toMatchObject({ retryable: false });
    expect(transfersByRef.size).toBe(0);
  });

  /**
   * The seller is named by the GATEWAY's account id (`ca_…`), which is what
   * `provider_accounts.provider_account_id` holds on this rail. Mercaria never
   * learns the acquirer's own id and must not (ADR 0009 D15).
   */
  test('names the seller by the gateway account id and the order by its own ref', async () => {
    const provider = new PeablePaymentProvider();
    const sourceId = await settledPayment();
    await provider.createTransfer({
      paymentId: 'pay-settle-1',
      orderId: 'order-naming',
      sourcePaymentObjectId: sourceId,
      destinationAccountId: 'ca_seller_naming',
      amount: AMOUNT,
      groupRef: 'group-settle-1',
      idempotencyKey: 'tr:order-naming',
      metadata: {},
    });

    expect(transfersByRef.has('order-naming')).toBe(true);
    expect(wire.at(-1)).toEqual({ method: 'POST', path: '/v1/transfers', stage: 'transfer',
      idempotencyKey: 'tr:order-naming', body: { paymentIntentId: sourceId,
        connectedAccountId: 'ca_seller_naming', externalRef: 'order-naming', amount: '2500' } });
  });
});


describe('published SDK HTTP parity', () => {
  const request = {
    paymentId: 'pay-http', checkoutGroupId: 'group-http',
    amount: { amount: 1000, currency: 'EUR' as const }, orderIds: ['order-http'],
    metadata: { stable_ref: 'fixture' }, idempotencyKey: 'pi:pay-http',
  };
  test('preserves body/key and one GET resume with optional client action', async () => {
    const provider = new PeablePaymentProvider();
    const created = await provider.createPayment(request);
    expect(wire).toEqual([{ method: 'POST', path: '/v1/payment_intents', stage: 'createPayment',
      idempotencyKey: request.idempotencyKey, body: { rail: 'card', amount: '1000', currency: 'EUR',
        metadata: { stable_ref: 'fixture', mercaria_payment_id: 'pay-http', mercaria_checkout_group_id: 'group-http' } } }]);
    const resumed = await provider.resumePayment(created.providerObjectId);
    expect(resumed.clientAction).toEqual(created.clientAction);
    expect(wire.slice(1)).toEqual([{ method: 'GET', path: `/v1/payment_intents/${created.providerObjectId}`, stage: 'getStatus' }]);
    expect(mintCount).toBe(1);
  });
  test('re-mints once on401 with the same operation key; a second401 is final', async () => {
    const provider = new PeablePaymentProvider(); rejectRequests = 1;
    await provider.createPayment(request);
    expect(mintCount).toBe(2); expect(wire).toHaveLength(2);
    expect(wire.map(row => row.idempotencyKey)).toEqual([request.idempotencyKey, request.idempotencyKey]);
    expect(intents.size).toBe(1);
    wire.length = 0; rejectRequests = 2;
    await expect(provider.createPayment({ ...request, idempotencyKey: 'pi:second' })).rejects.toMatchObject({ retryable: false });
    expect(wire).toHaveLength(2); expect(mintCount).toBe(3); expect(intents.size).toBe(1);
  });
  test('lost response never auto-retries; explicit same-key retry converges on one effect', async () => {
    const provider = new PeablePaymentProvider(); dropAfterEffect = true;
    await expect(provider.createPayment(request)).rejects.toMatchObject({ retryable: true, stage: 'createPayment' });
    expect(wire).toHaveLength(1); expect(intents.size).toBe(1);
    const recovered = await provider.createPayment(request);
    expect(recovered.providerObjectId).toBe([...intents.keys()][0]);
    expect(wire).toHaveLength(2); expect(intents.size).toBe(1);
    expect(wire[0]).toEqual(wire[1]);
  });
  test.each([400, 403, 409, 408, 429, 503])('maps refusal%s without provider text or extra attempts', async status => {
    const provider = new PeablePaymentProvider(); forcedStatus = status;
    const result = provider.createPayment(request);
    await expect(result).rejects.toMatchObject({ provider: 'peable', stage: 'createPayment', retryable: [408,429,503].includes(status) });
    await expect(result).rejects.not.toThrow('synthetic-sensitive-detail');
    expect(wire).toHaveLength(1); expect(intents.size).toBe(0);
  });
  test('cancel preserves its durable key', async () => {
    const provider = new PeablePaymentProvider(); const created = await provider.createPayment(request);
    await provider.cancel({ paymentId: request.paymentId, providerObjectId: created.providerObjectId, idempotencyKey: 'cancel:pay-http' });
    expect(wire.at(-1)).toEqual({ method: 'POST', path: `/v1/payment_intents/${created.providerObjectId}/reject`, stage: 'cancel', idempotencyKey: 'cancel:pay-http' });
  });
  test.each(['pending', 'failed'] as const)('keeps refund%s distinct from payment lifecycle, with externalRef and key', async state => {
    const provider = new PeablePaymentProvider(); const created = await provider.createPayment(request);
    intents.get(created.providerObjectId)!.status = 'settled'; refundLifecycle = state;
    const refundRequest = { paymentId: request.paymentId, providerObjectId: created.providerObjectId, refundId: 'refund-http',
      amount: { amount: 200, currency: 'EUR' as const }, idempotencyKey: 're:refund-http', metadata: {} };
    const first = await provider.refund(refundRequest); const second = await provider.refund(refundRequest);
    expect(first.state).toBe(state); expect(first.status).toBe('partially_refunded');
    expect(second.providerObjectId).toBe(first.providerObjectId); expect(refundsByRef.size).toBe(1);
    expect(wire.at(-1)).toEqual({ method: 'POST', path: '/v1/refunds', stage: 'refund', idempotencyKey: 're:refund-http',
      body: { paymentIntentId: created.providerObjectId, externalRef: 'refund-http', amount: '200' } });
  });
});
