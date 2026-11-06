/**
 * Merchant billing on Peable's native engine, end to end against migrated SQL:
 * the published Peable SDK, the real adapter, a loopback gateway that answers
 * native subscriptions and invoices, the reconciliation timer and the event
 * handlers. No provider network, production authority or commercial
 * activation is implied.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { and, eq, inArray } from 'drizzle-orm';
import { Peable } from '@peable.to/sdk';
import { PEABLE_TRANSPORT } from '../../../payments/peable/client.js';
import { closePostgres, connectPostgres, type Database } from '../../../../db/postgres.js';
import { stores } from '../../../../db/schema/stores.js';
import {
  merchantSubscriptionEvents,
  merchantSubscriptions,
} from '../../../../db/schema/merchantPlans.js';
import {
  activateMerchantPlan,
  insertMerchantPlan,
  insertMerchantPlanPrice,
} from '../../../../db/merchantPlans/planRepository.js';
import { ensureBillingCustomer } from '../../../../db/merchantPlans/subscriptionRepository.js';
import {
  BillingProviderError,
  registerBillingProvider,
  resetBillingProviders,
} from '../../provider.js';
import { reconcileMerchantSubscriptions } from '../../subscription.service.js';
import {
  startMerchantSubscriptionReconciler,
  stopMerchantSubscriptionReconciler,
} from '../../reconciler.js';
import { PeableBillingProvider } from '../native-billing.js';
import { PEABLE_BILLING_EVENT_HANDLERS } from '../events.js';
import { routePeableEvent } from '../../../payments/peable/event-router.js';

vi.mock('../../../../config/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../config/index.js')>();
  return {
    ...original,
    config: {
      ...original.config,
      merchantBilling: {
        ...original.config.merchantBilling,
        enabled: false,
        reconciliationEnabled: true,
        reconciliationBatchSize: 1,
        reconciliationIntervalMs: 40,
      },
    },
  };
});

let db: Database;
let server: Server;
let provider: PeableBillingProvider;
let planId: string;
const nonce = randomUUID().replaceAll('-', '');
const ownedStores = [`${nonce.slice(0, 23)}1`, `${nonce.slice(0, 23)}2`] as const;
const liveStore = `${nonce.slice(0, 23)}3`;
const rowStores = [...ownedStores, liveStore] as const;
const refs = [`sub_first${nonce}`, `sub_later${nonce}`, `sub_live${nonce}`] as const;
const customers = [`cus_a${nonce}`, `cus_b${nonce}`, `cus_c${nonce}`] as const;
const testPrice = `price_test${nonce}`;
const invoiceRef = `in_paid${nonce}`;
const paymentRef = `pi_paid${nonce}`;

/** What the loopback gateway answers, by subscription. */
const subscriptions = new Map<string, Record<string, unknown>>();
const failures = new Set<string>();
const reads: string[] = [];
const posts: { path: string; body: string; key: string | undefined }[] = [];

function nativeSubscription(ref: string, customer: string, status: string) {
  const start = Math.floor((Date.now() - 60_000) / 1000);
  return {
    id: ref,
    object: 'subscription',
    livemode: false,
    customer,
    status,
    items: {
      object: 'list',
      data: [{ price: { id: testPrice, recurring: { interval: 'month', interval_count: 1 } } }],
      has_more: false,
    },
    current_period_start: start,
    current_period_end: start + 86_400,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
  };
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

beforeAll(async () => {
  db = await connectPostgres();
  await db.insert(stores).values(
    [...rowStores].map((id, index) => ({
      id,
      oxyAccountId: `fixture-${nonce}`,
      handle: `native-billing-${nonce}-${index}`,
      name: 'Own fixture',
      description: '',
      brandColor: '#101010',
    })),
  );
  const plan = await insertMerchantPlan(db, {
    planKey: `native-${nonce}`,
    version: 1,
    tier: 'paid',
    name: 'Synthetic fixture',
    summary: 'Not for sale',
    termsVersion: 'fixture',
    createdByOxyUserId: `fixture-${nonce}`,
  });
  planId = plan.id;
  for (const livemode of [false, true])
    await insertMerchantPlanPrice(db, {
      planId,
      provider: 'peable',
      livemode,
      interval: 'monthly',
      unitPrice: { amount: 100, currency: 'USD' },
      providerPriceId: livemode ? `price_live${nonce}` : testPrice,
    });
  await activateMerchantPlan(db, { id: planId, approvedByOxyUserId: `fixture-${nonce}` });

  for (const [index, storeId] of rowStores.entries()) {
    const livemode = storeId === liveStore;
    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'peable',
      livemode,
      providerCustomerId: customers[index] ?? '',
    });
    const start = new Date(Date.now() - 60_000);
    await db.insert(merchantSubscriptions).values({
      id: `00000000-0000-7000-800${index}-${nonce.slice(-12)}`,
      storeId,
      planId,
      billingCustomerId: customer.row.id,
      provider: 'peable',
      livemode,
      providerSubscriptionId: refs[index] ?? '',
      status: 'active',
      interval: 'monthly',
      currentPeriodStart: start,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      acceptedTermsVersion: 'fixture',
      acceptedByOxyUserId: `fixture-${nonce}`,
      acceptedAt: start,
    });
  }

  server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const path = req.url?.split('?')[0] ?? '';
    if (path === '/auth/service-token') {
      await bodyOf(req);
      json(200, { data: { token: 'synthetic-token', expiresIn: 300 } });
      return;
    }
    if (req.method === 'POST') {
      const body = await bodyOf(req);
      posts.push({ path, body, key: req.headers['idempotency-key'] as string | undefined });
      if (path === '/v1/checkout_sessions') {
        json(200, {
          id: `cs_${nonce}`,
          object: 'checkout_session',
          ui_mode: 'embedded',
          url: null,
          client_secret: `cs_${nonce}_secret_fixture`,
          amount_total: '1299',
          currency: 'usd',
          livemode: false,
          expires_at: Math.floor(Date.now() / 1000) + 3_600,
        });
        return;
      }
      if (path === '/v1/billing_portal/sessions') {
        json(200, { id: `bps_${nonce}`, url: `https://checkout.peable.to/p/${nonce}` });
        return;
      }
      json(404, { error: { type: 'invalid_request_error', message: 'unknown' } });
      return;
    }
    if (path.startsWith('/v1/subscriptions/')) {
      const ref = path.slice('/v1/subscriptions/'.length);
      reads.push(ref);
      if (failures.has(ref)) {
        json(503, { error: { type: 'api_error', message: 'synthetic unavailable' } });
        return;
      }
      const subscription = subscriptions.get(ref);
      if (!subscription) {
        json(404, {
          error: { type: 'invalid_request_error', code: 'resource_missing', message: 'x' },
        });
        return;
      }
      json(200, subscription);
      return;
    }
    if (path === `/v1/invoices/${invoiceRef}`) {
      json(200, {
        id: invoiceRef,
        object: 'invoice',
        livemode: false,
        customer: customers[0],
        subscription: refs[0],
        status: 'paid',
        amount_paid: '1299',
        currency: 'usd',
        payment_intent: paymentRef,
      });
      return;
    }
    if (path === `/v1/payment_intents/${paymentRef}`) {
      // A card payment: what makes this invoice fiat on the platform balance.
      json(200, {
        id: paymentRef,
        object: 'payment_intent',
        livemode: false,
        status: 'succeeded',
        rail: 'card',
        amount: '1299',
        amount_received: '1299',
        currency: 'usd',
        faircoin: null,
      });
      return;
    }
    json(404, { error: { type: 'invalid_request_error', message: 'unknown' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback gateway failed');
  const url = `http://127.0.0.1:${address.port}`;
  provider = new PeableBillingProvider(
    new Peable({
      publicKey: 'fixture-public',
      secret: 'fixture-secret',
      baseURL: url,
      oxyApiUrl: url,
      ...PEABLE_TRANSPORT,
    }),
    false,
  );
}, 120_000);

beforeEach(async () => {
  stopMerchantSubscriptionReconciler();
  reads.length = 0;
  posts.length = 0;
  failures.clear();
  subscriptions.clear();
  for (const [index, ref] of refs.entries()) {
    subscriptions.set(ref, nativeSubscription(ref, customers[index] ?? '', 'paused'));
  }
  resetBillingProviders();
  registerBillingProvider(provider);
  await db
    .update(merchantSubscriptions)
    .set({ status: 'active' })
    .where(inArray(merchantSubscriptions.storeId, [...rowStores]));
});
afterEach(() => stopMerchantSubscriptionReconciler());
afterAll(async () => {
  stopMerchantSubscriptionReconciler();
  resetBillingProviders();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

const statusOf = async (storeId: string) =>
  (
    await db
      .select({ status: merchantSubscriptions.status })
      .from(merchantSubscriptions)
      .where(eq(merchantSubscriptions.storeId, storeId))
  )[0]?.status;

it('reconciles this mode against the native subscription and never reads the other mode', async () => {
  // Other suites may own `peable` test-mode rows; walk the whole namespace and
  // assert only this file's effects.
  let afterId: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await reconcileMerchantSubscriptions({ limit: 100, afterId });
    afterId = result.nextAfterId ?? undefined;
    if (!afterId) break;
  }
  expect(afterId).toBeUndefined();
  expect(reads).toContain(refs[0]);
  expect(reads).toContain(refs[1]);
  expect(reads).not.toContain(refs[2]);
  expect(await statusOf(ownedStores[0])).toBe('paused');
  expect(await statusOf(ownedStores[1])).toBe('paused');
  expect(await statusOf(liveStore)).toBe('active');
});

it('the actual timer advances beyond a failing subscription with actions OFF', async () => {
  failures.add(refs[0]);
  startMerchantSubscriptionReconciler();
  try {
    await vi.waitFor(async () => expect(await statusOf(ownedStores[1])).toBe('paused'), {
      timeout: 10_000,
      interval: 25,
    });
  } finally {
    stopMerchantSubscriptionReconciler();
  }
  expect(reads).toContain(refs[0]);
  expect(await statusOf(ownedStores[0])).toBe('active');
});

it('a subscription event re-reads the subscription and refuses another customer', async () => {
  const handler = routePeableEvent('customer.subscription.updated');
  expect(handler).toBe(PEABLE_BILLING_EVENT_HANDLERS['customer.subscription.updated']);
  if (!handler) throw new Error('no handler for customer.subscription.updated');
  const outcome = await handler({
    storedEventId: randomUUID(),
    providerEventId: `evt_upd${nonce}`,
    type: 'customer.subscription.updated',
    objectIds: { subscription: refs[1], customer: customers[1] },
  });
  expect(outcome).toMatchObject({ kind: 'applied', note: 'subscription paused' });
  expect(await statusOf(ownedStores[1])).toBe('paused');

  await expect(
    handler({
      storedEventId: randomUUID(),
      providerEventId: `evt_mix${nonce}`,
      type: 'customer.subscription.updated',
      objectIds: { subscription: refs[1], customer: customers[0] },
    }),
  ).rejects.toThrow(/different customer/);
});

it('invoice.paid books what the invoice paid exactly once, without a fee leg', async () => {
  const handler = routePeableEvent('invoice.paid');
  if (!handler) throw new Error('no handler for invoice.paid');
  const context = (eventId: string) => ({
    storedEventId: randomUUID(),
    providerEventId: eventId,
    type: 'invoice.paid',
    objectIds: { invoice: invoiceRef, subscription: refs[0], customer: customers[0] },
  });
  expect(await handler(context(`evt_paid1${nonce}`))).toMatchObject({
    kind: 'applied',
    note: expect.stringMatching(/^booked to subscription_revenue/),
  });
  // A different delivery of the same invoice converges on the one booking.
  expect(await handler(context(`evt_paid2${nonce}`))).toMatchObject({
    kind: 'applied',
    note: 'already booked',
  });
  const claims = await db
    .select()
    .from(merchantSubscriptionEvents)
    .where(
      and(
        eq(merchantSubscriptionEvents.kind, 'invoice_paid'),
        eq(merchantSubscriptionEvents.providerInvoiceId, invoiceRef),
      ),
    );
  expect(claims).toHaveLength(1);
  expect(claims[0]?.ledgerTransactionId).toBeTruthy();
  expect(claims[0]).toMatchObject({ amountAmount: 1299, amountCurrency: 'USD' });
});

it('opens an embedded subscription checkout and the native portal, under the caller key', async () => {
  const session = await provider.createCheckoutSession({
    providerCustomerId: customers[0],
    providerPriceId: testPrice,
    trialDays: 0,
    storeId: ownedStores[0],
    planId,
    idempotencyKey: `billing-checkout:${nonce}`,
  });
  // The payer capability for the dashboard's Peable sheet, and the total it was
  // priced at — never a URL to redirect to.
  expect(session).toMatchObject({
    sessionId: `cs_${nonce}`,
    clientSecret: `cs_${nonce}_secret_fixture`,
    amountMinor: 1299,
    currency: 'USD',
    livemode: false,
  });
  expect(session.expiresAt).toBeInstanceOf(Date);
  const portal = await provider.createPortalSession({
    providerCustomerId: customers[0],
    returnUrl: 'https://dashboard.mercaria.co/settings/plan',
  });
  expect(portal.url).toBe(`https://checkout.peable.to/p/${nonce}`);

  const checkout = posts.find((post) => post.path === '/v1/checkout_sessions');
  expect(checkout?.key).toBe(`billing-checkout:${nonce}`);
  // Exactly these fields: no `payment_method_types`, so the session offers card
  // AND FairCoin (Peable ADR 0021 D1) — Mercaria never narrows a plan's methods.
  expect(JSON.parse(checkout?.body ?? '{}')).toEqual({
    mode: 'subscription',
    customer: customers[0],
    ui_mode: 'embedded',
    line_items: [{ price: testPrice, quantity: 1 }],
    client_reference_id: ownedStores[0],
    metadata: { store_id: ownedStores[0], plan_id: planId },
  });
});

it('refuses a plan version with a trial rather than selling it without one', async () => {
  const attempt = provider.createCheckoutSession({
    providerCustomerId: customers[0],
    providerPriceId: testPrice,
    trialDays: 14,
    storeId: ownedStores[0],
    planId,
    idempotencyKey: `billing-trial:${nonce}`,
  });
  await expect(attempt).rejects.toBeInstanceOf(BillingProviderError);
  await expect(attempt).rejects.toMatchObject({ code: 'trial_not_supported' });
  expect(posts).toHaveLength(0);
});

it('refuses a subscription the gateway answers for the other mode', async () => {
  subscriptions.set(refs[0], {
    ...nativeSubscription(refs[0], customers[0], 'active'),
    livemode: true,
  });
  await expect(provider.retrieveSubscription(refs[0])).rejects.toMatchObject({
    code: 'billing_response_invalid',
  });
});
