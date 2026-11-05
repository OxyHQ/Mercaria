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
import { PEABLE_API_VERSION } from '@peable.to/sdk';
import type { PaymentProviderStage } from '../provider.js';
import { PaymentProviderError } from '../provider.js';

/** The gateway's own state, per intent. */
interface FakeIntent {
  id: string;
  status: 'requires_payment_method' | 'succeeded' | 'canceled';
  amount: string;
  currency: string;
  refundedMinor: number;
}

/** An intent as the gateway renders it: the fields the adapter reads. */
function renderIntent(intent: FakeIntent, withClientAction: boolean): Record<string, unknown> {
  return {
    id: intent.id,
    object: 'payment_intent',
    livemode: false,
    status: intent.status,
    amount: intent.amount,
    amount_received: intent.status === 'succeeded' ? intent.amount : '0',
    amount_refunded: String(intent.refundedMinor),
    currency: intent.currency,
    last_payment_error: null,
    // The intent's OWN secret (the payer's), beside the acquirer's in
    // `client_action` — distinct, so a test can tell which one the adapter took.
    client_secret: `${intent.id}_payer_secret`,
    ...(withClientAction
      ? { client_action: { kind: 'client_secret', value: `${intent.id}_secret` } }
      : {}),
  };
}

/** A refund as the gateway renders it. */
function renderRefund(id: string, intentId: string): Record<string, unknown> {
  return {
    id,
    object: 'refund',
    livemode: false,
    payment_intent: intentId,
    status: 'succeeded',
    failure_code: null,
  };
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
/** The `Authorization` header of every gateway request, in order. */
const bearers: (string | undefined)[] = [];
let mintCount = 0;
let identityToken: string | null = null;
function fixtureServiceToken(sequence: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      type: 'service',
      appId: 'fixture',
      credentialId: 'wl_fixture',
      ownerAccountId: 'owner',
      environment: 'development',
      aud: 'oxy-service:6a2f851751b784a86fd0e958',
      iss: 'https://api.oxy.test',
      authority: 'first_party',
      exp: 2_100_000_000,
      jti: String(sequence),
    }),
  ).toString('base64url');
  return `e30.${payload}.fixture`;
}
let rejectRequests = 0;
let forcedStatus: number | null = null;
let dropAfterEffect = false;
let refundLifecycle: 'pending' | 'failed' | null = null;
/** Refuse every settlement read with a permanent 400 — the read, not the refund. */
let refuseSettlementReads = false;

const WEBHOOK_SECRET = 'whsec_contract_peable';

function reset(): void {
  intents.clear();
  refundsByRef.clear();
  transfersByRef.clear();
  intentsByKey.clear();
  nextId = 0;
  failNextStage = null;
  wire.length = 0;
  bearers.length = 0;
  mintCount = 0;
  identityToken = null;
  rejectRequests = 0;
  forcedStatus = null;
  dropAfterEffect = false;
  refundLifecycle = null;
  refuseSettlementReads = false;
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
    const existingIntent = existing === undefined ? undefined : intents.get(existing);
    if (existingIntent) return renderIntent(existingIntent, true);
    nextId += 1;
    const id = `pi_fake_${String(nextId)}`;
    const intent: FakeIntent = {
      id,
      status: 'requires_payment_method',
      amount: String(body.amount),
      currency: String(body.currency),
      refundedMinor: 0,
    };
    intents.set(id, intent);
    intentsByKey.set(key, id);
    return renderIntent(intent, true);
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
    return renderIntent(intent, true);
  }

  const cancelMatch = /^\/v1\/payment_intents\/([^/]+)\/cancel$/.exec(request.path);
  if (request.method === 'POST' && cancelMatch) {
    const intent = intents.get(decodeURIComponent(cancelMatch[1] ?? ''));
    if (!intent) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: 'payment intent not found',
        retryable: false,
      });
    }
    // The real gateway cancels only while nothing is moving money. Cancelling a
    // payment that already took the buyer's money is not a cancellation, it is
    // a refund — and a fake that allowed it would let an adapter through that
    // calls the wrong one.
    if (intent.status !== 'requires_payment_method') {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: `a payment in '${intent.status}' cannot be cancelled`,
        retryable: false,
      });
    }
    intent.status = 'canceled';
    return renderIntent(intent, false);
  }

  const refundListMatch = /^\/v1\/payment_intents\/([^/]+)\/refunds$/.exec(request.path);
  if (request.method === 'GET' && refundListMatch) {
    const intent = intents.get(decodeURIComponent(refundListMatch[1] ?? ''));
    if (!intent) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: 'payment intent not found',
        retryable: false,
      });
    }
    return {
      object: 'list',
      data: [],
      has_more: false,
      url: request.path,
      remaining_refundable: String(Number(intent.amount) - intent.refundedMinor),
    };
  }

  if (request.method === 'POST' && request.path === '/v1/refunds') {
    const ref = String(body.external_ref);
    const intent = intents.get(String(body.payment_intent));
    if (!intent) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'refund',
        message: 'payment intent not found',
        retryable: false,
      });
    }
    // The real gateway refuses a refund unless the payment succeeded. Mirrored
    // here because the contract suite asserts exactly that refusal, and a fake
    // that refunded anything would pass an adapter that never checks.
    if (intent.status !== 'succeeded') {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'refund',
        message: `a refund needs a succeeded payment; this one is '${intent.status}'`,
        retryable: false,
      });
    }
    const existing = refundsByRef.get(ref);
    if (existing) {
      // The converged retry: the SAME refund, and no second movement.
      return renderRefund(existing.id, intent.id);
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
    refundsByRef.set(ref, { id, amount: String(amount), intentId: intent.id });
    return renderRefund(id, intent.id);
  }

  const settlementMatch = /^\/v1\/refunds\/([^/]+)\/settlement$/.exec(request.path);
  if (request.method === 'GET' && settlementMatch) {
    if (refuseSettlementReads) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: 'settlement read refused',
        retryable: false,
      });
    }
    const refundId = decodeURIComponent(settlementMatch[1] ?? '');
    const refund = [...refundsByRef.values()].find((entry) => entry.id === refundId);
    const references = { payment_intent: refund?.intentId ?? '', refund: refundId, dispute: null };
    // A failed refund moved nothing: no figure, never a zero.
    if (!refund || refundLifecycle === 'failed') {
      return {
        object: 'settlement',
        livemode: false,
        ...references,
        status: 'unknown',
        gross: null,
        fee: null,
        net: null,
        currency: null,
        available_on: null,
        exchange_rate: null,
      };
    }
    return {
      object: 'settlement',
      livemode: false,
      ...references,
      status: refundLifecycle === 'pending' ? 'pending' : 'available',
      gross: refund.amount,
      fee: '0',
      net: `-${refund.amount}`,
      currency: 'EUR',
      available_on: null,
      exchange_rate: null,
    };
  }

  if (request.method === 'POST' && request.path === '/v1/transfers') {
    const ref = String(body.external_ref);
    const existing = transfersByRef.get(ref);
    if (existing)
      return { id: existing.id, object: 'transfer', status: 'paid', amount_reversed: '0' };
    nextId += 1;
    const id = `tr_fake_${String(nextId)}`;
    transfersByRef.set(ref, { id, intentId: String(body.payment_intent), reversedMinor: 0 });
    return { id, object: 'transfer', status: 'paid', amount_reversed: '0' };
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
    nextId += 1;
    return {
      id: entry.id,
      object: 'transfer',
      status: 'partially_reversed',
      // CUMULATIVE, which is what the adapter must report back.
      amount_reversed: String(entry.reversedMinor),
      reversal: {
        id: `trr_fake_${String(nextId)}`,
        object: 'transfer_reversal',
        external_ref: String(body.external_ref),
        amount: String(body.amount),
        status: 'succeeded',
      },
    };
  }

  throw new Error(`the fake gateway has no route for ${request.method} ${request.path}`);
}

// Exercise the published SDK, including its token handling and HTTP
// serialization. Only the gateway/provider boundary and Mercaria's Oxy identity
// (below) are synthetic; no local client is mocked.
let gatewayUrl = '';
const gateway = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  bearers.push(req.headers.authorization);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const path = new URL(req.url ?? '/', 'http://gateway.test').pathname;
  const stage: PaymentProviderStage =
    path === '/v1/payment_intents'
      ? 'createPayment'
      : path.endsWith('/cancel')
        ? 'cancel'
        : path === '/v1/refunds' || path.endsWith('/refunds')
          ? 'refund'
          : path.startsWith('/v1/transfers')
            ? 'transfer'
            : 'getStatus';
  const key = req.headers['idempotency-key'];
  try {
    const request: FakeRequest = {
      method: req.method ?? 'GET',
      path,
      stage,
      ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}),
      ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
    };
    wire.push(request);
    if (rejectRequests > 0 || forcedStatus !== null) {
      res.statusCode = forcedStatus ?? 401;
      rejectRequests = Math.max(0, rejectRequests - 1);
      if (dropAfterEffect) {
        dropAfterEffect = false;
        res.writeHead(res.statusCode, { 'content-length': '2000' });
        res.write('{');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.end(
        JSON.stringify({
          error: { type: 'fixture_refusal', message: 'synthetic-sensitive-detail' },
        }),
      );
      return;
    }
    const result = await fakeGateway(request);
    if (dropAfterEffect) {
      dropAfterEffect = false;
      res.writeHead(200, { 'content-length': '2000' });
      res.write('{');
      setTimeout(() => res.destroy(), 10);
      return;
    }
    if (
      refundLifecycle &&
      path === '/v1/refunds' &&
      typeof result === 'object' &&
      result !== null
    ) {
      res.end(
        JSON.stringify({
          ...result,
          status: refundLifecycle,
          failure_code: refundLifecycle === 'failed' ? 'fixture_decline' : null,
        }),
      );
      return;
    }
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error instanceof PaymentProviderError && !error.retryable ? 400 : 503;
    res.end(
      JSON.stringify({ error: { type: 'fixture_error', message: 'Synthetic gateway refusal' } }),
    );
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
  await new Promise<void>((resolve, reject) =>
    gateway.close((error) => (error ? reject(error) : resolve())),
  );
});

// Real shared transport owns the bearer and its single 401 refresh. Only the
// workload mint is replaced; requests still traverse the SDK and HTTP gateway.
vi.mock('../../../middleware/auth.js', async (importOriginal) => {
  const { OxyServer } = await import('@oxy.so/core/server');
  const oxy = new OxyServer({ baseURL: 'https://unused.oxy.test' });
  Object.assign(oxy, {
    workloadServiceToken: async (audience: string) => {
      expect(audience).toBe('oxy-service:6a2f851751b784a86fd0e958');
      const cache = Reflect.get(oxy, 'serviceTokens') as Map<string, { token: string }>;
      const key = JSON.stringify([audience, 'workload-identity', null]);
      if (identityToken === null || !cache.has(key)) {
        mintCount += 1;
        identityToken = fixtureServiceToken(mintCount);
        cache.set(key, { token: identityToken });
      }
      return identityToken;
    },
    invalidateServiceToken: () => {
      identityToken = null;
    },
  });
  return {
    ...(await importOriginal<typeof import('../../../middleware/auth.js')>()),
    oxyClient: oxy,
  };
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
          get baseUrl() {
            return gatewayUrl;
          },
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
   * therefore what the gateway's own event does — the payment reaches
   * `succeeded` — and the adapter reads it back.
   */
  settle: async (provider, { providerObjectId }) => {
    const intent = intents.get(providerObjectId);
    if (intent) intent.status = 'succeeded';
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
      api_version: PEABLE_API_VERSION,
      livemode: false,
      type: status === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.processing',
      created: Math.floor(Date.now() / 1000),
      request: { id: null, idempotency_key: null },
      data: { object: { id: providerObjectId, object: 'payment_intent' } },
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
    if (intent) intent.status = 'succeeded';
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
    expect(wire.slice(-2).map((row) => ({ key: row.idempotencyKey, body: row.body }))).toEqual([
      { key: 'trr:order-rev:3000', body: { amount: '3000', external_ref: 'trr:order-rev:3000' } },
      { key: 'trr:order-rev:2000', body: { amount: '2000', external_ref: 'trr:order-rev:2000' } },
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
    expect(wire.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/transfers',
      stage: 'transfer',
      idempotencyKey: 'tr:order-naming',
      body: {
        payment_intent: sourceId,
        connected_account: 'ca_seller_naming',
        external_ref: 'order-naming',
        amount: '2500',
      },
    });
  });
});

describe('published SDK HTTP parity', () => {
  const request = {
    paymentId: 'pay-http',
    checkoutGroupId: 'group-http',
    amount: { amount: 1000, currency: 'EUR' as const },
    orderIds: ['order-http'],
    metadata: { stable_ref: 'fixture' },
    idempotencyKey: 'pi:pay-http',
  };
  test('preserves body/key and one GET resume with optional client action', async () => {
    const provider = new PeablePaymentProvider();
    const created = await provider.createPayment(request);
    expect(wire).toEqual([
      {
        method: 'POST',
        path: '/v1/payment_intents',
        stage: 'createPayment',
        idempotencyKey: request.idempotencyKey,
        body: {
          rail: 'card',
          amount: '1000',
          currency: 'EUR',
          payment_method_types: ['card'],
          metadata: {
            stable_ref: 'fixture',
            mercaria_payment_id: 'pay-http',
            mercaria_checkout_group_id: 'group-http',
          },
        },
      },
    ]);
    // The payer is handed the gateway intent's OWN secret, never the acquirer's
    // confirmation secret in `client_action.value` (ADR 0009 D13 "As built").
    expect(created.clientAction).toEqual({
      kind: 'client_secret',
      value: `${created.providerObjectId}_payer_secret`,
    });
    const resumed = await provider.resumePayment(created.providerObjectId);
    expect(resumed.clientAction).toEqual(created.clientAction);
    expect(wire.slice(1)).toEqual([
      {
        method: 'GET',
        path: `/v1/payment_intents/${created.providerObjectId}`,
        stage: 'getStatus',
      },
    ]);
    expect(mintCount).toBe(1);
  });
  test('re-mints once on401 with the same operation key; a second401 is final', async () => {
    const provider = new PeablePaymentProvider();
    rejectRequests = 1;
    await provider.createPayment(request);
    expect(mintCount).toBe(2);
    expect(wire).toHaveLength(2);
    // Mercaria's own identity is the bearer, and the 401 invalidated it.
    expect(bearers).toEqual([
      `Bearer ${fixtureServiceToken(1)}`,
      `Bearer ${fixtureServiceToken(2)}`,
    ]);
    expect(wire.map((row) => row.idempotencyKey)).toEqual([
      request.idempotencyKey,
      request.idempotencyKey,
    ]);
    expect(intents.size).toBe(1);
    wire.length = 0;
    rejectRequests = 2;
    await expect(
      provider.createPayment({ ...request, idempotencyKey: 'pi:second' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(wire).toHaveLength(2);
    expect(mintCount).toBe(3);
    expect(intents.size).toBe(1);
  });
  test('lost response never auto-retries; explicit same-key retry converges on one effect', async () => {
    const provider = new PeablePaymentProvider();
    dropAfterEffect = true;
    await expect(provider.createPayment(request)).rejects.toMatchObject({
      retryable: true,
      stage: 'createPayment',
    });
    expect(wire).toHaveLength(1);
    expect(intents.size).toBe(1);
    const recovered = await provider.createPayment(request);
    expect(recovered.providerObjectId).toBe([...intents.keys()][0]);
    expect(wire).toHaveLength(2);
    expect(intents.size).toBe(1);
    expect(wire[0]).toEqual(wire[1]);
  });
  test.each([400, 403, 409, 408, 429, 503])(
    'maps refusal%s without provider text or extra attempts',
    async (status) => {
      const provider = new PeablePaymentProvider();
      forcedStatus = status;
      const result = provider.createPayment(request);
      await expect(result).rejects.toMatchObject({
        provider: 'peable',
        stage: 'createPayment',
        retryable: [408, 429, 503].includes(status),
      });
      await expect(result).rejects.not.toThrow('synthetic-sensitive-detail');
      expect(wire).toHaveLength(1);
      expect(intents.size).toBe(0);
    },
  );
  test.each([400, 403, 409, 408, 429, 503])(
    'interrupted HTTP%s body preserves known refusal classification',
    async (status) => {
      const provider = new PeablePaymentProvider();
      forcedStatus = status;
      dropAfterEffect = true;
      const result = provider.createPayment(request);
      await expect(result).rejects.toMatchObject({
        provider: 'peable',
        stage: 'createPayment',
        retryable: [408, 429, 503].includes(status),
      });
      await expect(result).rejects.not.toThrow('synthetic-sensitive-detail');
      expect(wire).toHaveLength(1);
      expect(intents.size).toBe(0);
      expect(wire[0]?.idempotencyKey).toBe(request.idempotencyKey);
    },
  );
  test('cancel preserves its durable key', async () => {
    const provider = new PeablePaymentProvider();
    const created = await provider.createPayment(request);
    await provider.cancel({
      paymentId: request.paymentId,
      providerObjectId: created.providerObjectId,
      idempotencyKey: 'cancel:pay-http',
    });
    expect(wire.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/payment_intents/${created.providerObjectId}/cancel`,
      stage: 'cancel',
      idempotencyKey: 'cancel:pay-http',
      body: { cancellation_reason: 'abandoned' },
    });
  });
  test.each(['pending', 'failed'] as const)(
    'keeps refund%s distinct from payment lifecycle, with external_ref and key',
    async (state) => {
      const provider = new PeablePaymentProvider();
      const created = await provider.createPayment(request);
      intents.get(created.providerObjectId)!.status = 'succeeded';
      refundLifecycle = state;
      const refundRequest = {
        paymentId: request.paymentId,
        providerObjectId: created.providerObjectId,
        refundId: 'refund-http',
        amount: { amount: 200, currency: 'EUR' as const },
        idempotencyKey: 're:refund-http',
        metadata: {},
      };
      const first = await provider.refund(refundRequest);
      const second = await provider.refund(refundRequest);
      expect(first.state).toBe(state);
      expect(first.status).toBe('partially_refunded');
      expect(second.providerObjectId).toBe(first.providerObjectId);
      expect(refundsByRef.size).toBe(1);
      // The refund, the payment's refund budget it is judged against, and what
      // the refund took off the settlement balance.
      expect(wire.slice(-3)).toEqual([
        {
          method: 'POST',
          path: '/v1/refunds',
          stage: 'refund',
          idempotencyKey: 're:refund-http',
          body: {
            payment_intent: created.providerObjectId,
            external_ref: 'refund-http',
            amount: '200',
          },
        },
        {
          method: 'GET',
          path: `/v1/payment_intents/${created.providerObjectId}/refunds`,
          stage: 'refund',
        },
        {
          method: 'GET',
          path: `/v1/refunds/${first.providerObjectId}/settlement`,
          stage: 'getStatus',
        },
      ]);
      // A pending refund already has its settled figure; a failed one has none.
      if (state === 'failed') expect(first.platform).toBeUndefined();
      else expect(first.platform?.amount).toEqual({ amount: 200, currency: 'EUR' });
    },
  );
  test("states a succeeded refund's settled figure, at the identity rate when nothing converted", async () => {
    const provider = new PeablePaymentProvider();
    const created = await provider.createPayment(request);
    const intent = intents.get(created.providerObjectId);
    if (!intent) throw new Error('the fake gateway lost the intent it created');
    intent.status = 'succeeded';

    const result = await provider.refund({
      paymentId: request.paymentId,
      providerObjectId: created.providerObjectId,
      refundId: 'refund-settled',
      amount: { amount: 300, currency: 'EUR' as const },
      idempotencyKey: 're:refund-settled',
      metadata: {},
    });

    expect(result.state).toBe('succeeded');
    expect(result.platform?.amount).toEqual({ amount: 300, currency: 'EUR' });
    expect(result.platform?.rate).toMatchObject({
      from: 'EUR',
      to: 'EUR',
      rate: 1,
      provider: 'identity',
    });
  });
  test('answers a refund with NO settled figure, never a refusal, when the settlement read fails', async () => {
    const provider = new PeablePaymentProvider();
    const created = await provider.createPayment(request);
    const intent = intents.get(created.providerObjectId);
    if (!intent) throw new Error('the fake gateway lost the intent it created');
    intent.status = 'succeeded';
    refuseSettlementReads = true;

    const result = await provider.refund({
      paymentId: request.paymentId,
      providerObjectId: created.providerObjectId,
      refundId: 'refund-unread',
      amount: { amount: 100, currency: 'EUR' as const },
      idempotencyKey: 're:refund-unread',
      metadata: {},
    });

    // The money moved; a PERMANENT refusal of the read must not make the
    // executor record it as a refund the rail refused. No figure is the answer,
    // and the executor retries `refund_settlement_unavailable`.
    expect(result.state).toBe('succeeded');
    expect(result.platform).toBeUndefined();
  });
});
