/**
 * Merchant plans paid in FairCoin (Peable ADR 0021 D3), end to end against
 * migrated SQL: the published Peable SDK, the real adapter, a loopback gateway
 * that answers native subscriptions, invoices and the payments that paid them,
 * and the real event handlers.
 *
 * 1. A subscription whose FIRST payment is still confirming is `incomplete` —
 *    never "ended" — and grants nothing until the rail reports it `active`.
 * 2. `invoice.paid` books what the payment actually received: a card payment as
 *    fiat through `provider_clearing`; a FairCoin payment as FAIR in
 *    `faircoin_received`, priced at the quote, with no fiat clearing at all.
 * 3. A FairCoin-started plan renews by INVOICE (`send_invoice`): the row keeps
 *    how each renewal is collected, and the plan view says when the next
 *    invoice falls due rather than that the plan renews automatically.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { and, eq } from 'drizzle-orm';
import { Peable } from '@peable.to/sdk';
import { PEABLE_TRANSPORT } from '../../../payments/peable/client.js';
import { closePostgres, connectPostgres, type Database } from '../../../../db/postgres.js';
import { stores } from '../../../../db/schema/stores.js';
import { ledgerEntries } from '../../../../db/schema/ledger.js';
import {
  merchantSubscriptionEvents,
  merchantSubscriptions,
} from '../../../../db/schema/merchantPlans.js';
import {
  activateMerchantPlan,
  insertMerchantPlan,
  insertMerchantPlanAcceptance,
  insertMerchantPlanPrice,
} from '../../../../db/merchantPlans/planRepository.js';
import { ensureBillingCustomer } from '../../../../db/merchantPlans/subscriptionRepository.js';
import { registerBillingProvider, resetBillingProviders } from '../../provider.js';
import { resolveMerchantEntitlements } from '../../../entitlements/resolve.js';
import { buildMerchantPlanStatus } from '../../../entitlements/projection.js';
import { PeableBillingProvider } from '../native-billing.js';
import { routePeableEvent } from '../../../payments/peable/event-router.js';
import type { PeableEventContext } from '../../../payments/peable/event-router.js';

let db: Database;
let server: Server;
let planId: string;
const nonce = randomUUID().replaceAll('-', '');
const store = {
  faircoin: `${nonce.slice(0, 23)}f`,
  card: `${nonce.slice(0, 23)}c`,
  lapsed: `${nonce.slice(0, 23)}l`,
} as const;
const customer = {
  faircoin: `cus_fc${nonce}`,
  card: `cus_cd${nonce}`,
  lapsed: `cus_lp${nonce}`,
} as const;
const sub = {
  faircoin: `sub_fc${nonce}`,
  card: `sub_cd${nonce}`,
  lapsed: `sub_lp${nonce}`,
} as const;
const testPrice = `price_fc${nonce}`;
const quotedAt = Math.floor(Date.now() / 1000) - 120;
/** 12.99 USD at 0.2 USD per FAIR: 64.95 ⊜, in FAIR's 10⁻⁸ minor units. */
const FAIR_RECEIVED = 6_495_000_000;

/** What the loopback gateway answers, by object id. */
const subscriptions = new Map<string, Record<string, unknown>>();
const invoices = new Map<string, Record<string, unknown>>();
const payments = new Map<string, Record<string, unknown>>();

function nativeSubscription(ref: string, cus: string, status: string) {
  const start = Math.floor((Date.now() - 60_000) / 1000);
  return {
    id: ref,
    object: 'subscription',
    livemode: false,
    customer: cus,
    status,
    items: {
      object: 'list',
      data: [{ price: { id: testPrice, recurring: { interval: 'month', interval_count: 1 } } }],
      has_more: false,
    },
    current_period_start: start,
    current_period_end: start + 30 * 86_400,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    collection_method: 'charge_automatically',
    days_until_due: null,
  };
}

function paidInvoice(id: string, cus: string, subscription: string, payment: string | null) {
  return {
    id,
    object: 'invoice',
    livemode: false,
    customer: cus,
    subscription,
    status: 'paid',
    // A quoted FairCoin payment records the QUOTE's fiat amount here, never the
    // FAIR figure (Peable ADR 0021 D3) — which is why the rail cannot be read
    // from the invoice.
    amount_paid: '1299',
    currency: 'usd',
    payment_intent: payment,
  };
}

function cardPayment(id: string) {
  return {
    id,
    object: 'payment_intent',
    livemode: false,
    status: 'succeeded',
    rail: 'card',
    payment_method_types: ['card'],
    amount: '1299',
    amount_received: '1299',
    currency: 'usd',
    faircoin: null,
  };
}

function faircoinPayment(id: string, quoteAmount = '1299') {
  return {
    id,
    object: 'payment_intent',
    livemode: false,
    status: 'succeeded',
    rail: 'faircoin',
    payment_method_types: ['faircoin'],
    amount: String(FAIR_RECEIVED),
    amount_received: String(FAIR_RECEIVED),
    currency: 'FAIR',
    faircoin: {
      network: 'testnet',
      address: 'fLx9bJ3Wv2kq8mT4sR6nZ1cY7pD5eH0aG',
      txid: `tx${nonce}`,
      confirmations: 6,
      required_confirmations: 6,
      quote: {
        currency: 'USD',
        amount: quoteAmount,
        rate: '0.2',
        price: { source: 'wfair-base', usd_per_fair: '0.2', observed_at: quotedAt - 30 },
        reference_rates: null,
        quoted_at: quotedAt,
        expires_at: quotedAt + 600,
      },
    },
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
    Object.values(store).map((id, index) => ({
      id,
      oxyAccountId: `fixture-${nonce}`,
      handle: `faircoin-plans-${nonce}-${index}`,
      name: 'Own fixture',
      description: '',
      brandColor: '#101010',
    })),
  );
  const plan = await insertMerchantPlan(db, {
    planKey: `faircoin-${nonce}`,
    version: 1,
    tier: 'paid',
    name: 'Synthetic fixture',
    summary: 'Not for sale',
    termsVersion: 'fixture',
    createdByOxyUserId: `fixture-${nonce}`,
  });
  planId = plan.id;
  await insertMerchantPlanPrice(db, {
    planId,
    provider: 'peable',
    livemode: false,
    interval: 'monthly',
    unitPrice: { amount: 1299, currency: 'USD' },
    providerPriceId: testPrice,
  });
  await activateMerchantPlan(db, { id: planId, approvedByOxyUserId: `fixture-${nonce}` });
  for (const key of ['faircoin', 'card', 'lapsed'] as const) {
    await ensureBillingCustomer(db, {
      storeId: store[key],
      provider: 'peable',
      livemode: false,
      providerCustomerId: customer[key],
    });
    await insertMerchantPlanAcceptance(db, {
      storeId: store[key],
      planKey: plan.planKey,
      planVersion: plan.version,
      termsVersion: plan.termsVersion,
      acceptedByOxyUserId: `fixture-${nonce}`,
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
    const [, , collection, id] = path.split('/');
    const source =
      collection === 'subscriptions'
        ? subscriptions
        : collection === 'invoices'
          ? invoices
          : collection === 'payment_intents'
            ? payments
            : undefined;
    const object = id ? source?.get(id) : undefined;
    if (req.method !== 'GET' || !object) {
      json(404, {
        error: { type: 'invalid_request_error', code: 'resource_missing', message: 'x' },
      });
      return;
    }
    json(200, object);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback gateway failed');
  const url = `http://127.0.0.1:${address.port}`;
  resetBillingProviders();
  registerBillingProvider(
    new PeableBillingProvider(
      new Peable({
        publicKey: 'fixture-public',
        secret: 'fixture-secret',
        baseURL: url,
        oxyApiUrl: url,
        ...PEABLE_TRANSPORT,
      }),
      false,
    ),
  );
}, 120_000);

beforeEach(() => {
  subscriptions.clear();
  invoices.clear();
  payments.clear();
});

afterAll(async () => {
  resetBillingProviders();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

/** Deliver one event through the real router, as the Peable webhook drain does. */
async function deliver(type: string, objectIds: PeableEventContext['objectIds']) {
  const handler = routePeableEvent(type);
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler({
    storedEventId: randomUUID(),
    providerEventId: `evt_${randomUUID().replaceAll('-', '')}`,
    type,
    objectIds,
  });
}

const statusOf = async (storeId: string) =>
  (
    await db
      .select({ status: merchantSubscriptions.status })
      .from(merchantSubscriptions)
      .where(eq(merchantSubscriptions.storeId, storeId))
  )[0]?.status;

async function claimFor(invoiceId: string) {
  const rows = await db
    .select()
    .from(merchantSubscriptionEvents)
    .where(
      and(
        eq(merchantSubscriptionEvents.kind, 'invoice_paid'),
        eq(merchantSubscriptionEvents.providerInvoiceId, invoiceId),
      ),
    );
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error('no claim');
  return row;
}

async function entriesOf(transactionId: string | null) {
  if (!transactionId) throw new Error('nothing was booked');
  const rows = await db
    .select({
      account: ledgerEntries.account,
      currency: ledgerEntries.currency,
      amountMinor: ledgerEntries.amountMinor,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, transactionId));
  return rows.sort((a, b) => a.account.localeCompare(b.account));
}

it('a first payment still confirming is `incomplete`, not ended, and grants the plan only once active', async () => {
  subscriptions.set(
    sub.faircoin,
    nativeSubscription(sub.faircoin, customer.faircoin, 'incomplete'),
  );
  expect(
    await deliver('customer.subscription.created', {
      subscription: sub.faircoin,
      customer: customer.faircoin,
    }),
  ).toMatchObject({ kind: 'applied', note: 'subscription incomplete' });
  expect(await statusOf(store.faircoin)).toBe('incomplete');

  // The store keeps what it had — no paid plan before the rail says it is paid.
  const pending = await resolveMerchantEntitlements(store.faircoin, { fresh: true });
  expect(pending.subscriptionStatus).toBe('incomplete');
  expect(pending.planId).not.toBe(planId);

  subscriptions.set(sub.faircoin, nativeSubscription(sub.faircoin, customer.faircoin, 'active'));
  await deliver('customer.subscription.updated', {
    subscription: sub.faircoin,
    customer: customer.faircoin,
  });
  expect(await statusOf(store.faircoin)).toBe('active');
  const paid = await resolveMerchantEntitlements(store.faircoin, { fresh: true });
  expect(paid.planId).toBe(planId);

  const trail = await db
    .select({
      from: merchantSubscriptionEvents.fromStatus,
      to: merchantSubscriptionEvents.toStatus,
    })
    .from(merchantSubscriptionEvents)
    .innerJoin(
      merchantSubscriptions,
      eq(merchantSubscriptions.id, merchantSubscriptionEvents.subscriptionId),
    )
    .where(eq(merchantSubscriptions.storeId, store.faircoin));
  expect(trail).toContainEqual({ from: 'incomplete', to: 'active' });
});

it('a first payment that never completes lapses to `expired` and never entitles', async () => {
  subscriptions.set(sub.lapsed, nativeSubscription(sub.lapsed, customer.lapsed, 'incomplete'));
  await deliver('customer.subscription.created', {
    subscription: sub.lapsed,
    customer: customer.lapsed,
  });
  expect(await statusOf(store.lapsed)).toBe('incomplete');

  subscriptions.set(
    sub.lapsed,
    nativeSubscription(sub.lapsed, customer.lapsed, 'incomplete_expired'),
  );
  await deliver('customer.subscription.deleted', {
    subscription: sub.lapsed,
    customer: customer.lapsed,
  });
  expect(await statusOf(store.lapsed)).toBe('expired');
  expect((await resolveMerchantEntitlements(store.lapsed, { fresh: true })).planId).not.toBe(
    planId,
  );
});

it('invoice.paid books a CARD-paid invoice as fiat through provider_clearing, as before', async () => {
  subscriptions.set(sub.card, nativeSubscription(sub.card, customer.card, 'active'));
  await deliver('customer.subscription.created', {
    subscription: sub.card,
    customer: customer.card,
  });
  const invoiceId = `in_cd${nonce}`;
  const paymentId = `pi_cd${nonce}`;
  invoices.set(invoiceId, paidInvoice(invoiceId, customer.card, sub.card, paymentId));
  payments.set(paymentId, cardPayment(paymentId));

  expect(
    await deliver('invoice.paid', { invoice: invoiceId, subscription: sub.card }),
  ).toMatchObject({
    kind: 'applied',
    note: expect.stringMatching(/^booked to subscription_revenue/),
  });

  const claim = await claimFor(invoiceId);
  expect(claim).toMatchObject({
    amountAmount: 1299,
    amountCurrency: 'USD',
    providerPaymentId: paymentId,
    quotedAmount: null,
    quotedCurrency: null,
    quotedAt: null,
  });
  expect(await entriesOf(claim.ledgerTransactionId)).toEqual([
    { account: 'provider_clearing', currency: 'USD', amountMinor: 1299n },
    { account: 'subscription_revenue', currency: 'USD', amountMinor: -1299n },
  ]);
});

it('invoice.paid books a FAIRCOIN-paid invoice as the FAIR received, priced at the quote, with no fiat clearing', async () => {
  // The subscription is the one the previous-but-one test activated.
  subscriptions.set(sub.faircoin, nativeSubscription(sub.faircoin, customer.faircoin, 'active'));
  const invoiceId = `in_fc${nonce}`;
  const paymentId = `pi_fc${nonce}`;
  invoices.set(invoiceId, paidInvoice(invoiceId, customer.faircoin, sub.faircoin, paymentId));
  payments.set(paymentId, faircoinPayment(paymentId));
  const context = { invoice: invoiceId, subscription: sub.faircoin };

  const outcome = await deliver('invoice.paid', context);
  expect(outcome).toMatchObject({ kind: 'applied' });
  expect(outcome.note).toMatch(/faircoin_received/);
  expect(outcome.note).toMatch(/no fiat moved/);

  const claim = await claimFor(invoiceId);
  expect(claim).toMatchObject({
    // What arrived, in the unit it arrived in…
    amountAmount: FAIR_RECEIVED,
    amountCurrency: 'FAIR',
    providerPaymentId: paymentId,
    // …and the fiat it was priced at, kept beside it, never converted into it.
    quotedAmount: 1299,
    quotedCurrency: 'USD',
  });
  expect(claim.quotedAt?.getTime()).toBe(quotedAt * 1000);

  const entries = await entriesOf(claim.ledgerTransactionId);
  expect(entries).toEqual([
    { account: 'faircoin_received', currency: 'FAIR', amountMinor: BigInt(FAIR_RECEIVED) },
    { account: 'subscription_revenue', currency: 'FAIR', amountMinor: -BigInt(FAIR_RECEIVED) },
  ]);
  // No fiat leg and no clearing: the coins are in the `oxy` organization's own
  // wallet, which Peable never held.
  expect(entries.some((entry) => entry.account === 'provider_clearing')).toBe(false);
  expect(entries.some((entry) => entry.currency !== 'FAIR')).toBe(false);

  // A second delivery converges on the one booking.
  expect(await deliver('invoice.paid', context)).toMatchObject({ note: 'already booked' });
  await claimFor(invoiceId);
});

it('refuses to book a paid invoice it cannot attribute to a rail, and waits for an unsettled payment', async () => {
  subscriptions.set(sub.card, nativeSubscription(sub.card, customer.card, 'active'));

  const unnamed = `in_np${nonce}`;
  invoices.set(unnamed, paidInvoice(unnamed, customer.card, sub.card, null));
  await expect(deliver('invoice.paid', { invoice: unnamed })).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(/names no payment/),
  });

  const confirming = `in_pr${nonce}`;
  const confirmingPayment = `pi_pr${nonce}`;
  invoices.set(
    confirming,
    paidInvoice(confirming, customer.faircoin, sub.faircoin, confirmingPayment),
  );
  payments.set(confirmingPayment, { ...faircoinPayment(confirmingPayment), status: 'processing' });
  await expect(deliver('invoice.paid', { invoice: confirming })).rejects.toMatchObject({
    retryable: true,
  });

  const mispriced = `in_mq${nonce}`;
  const mispricedPayment = `pi_mq${nonce}`;
  invoices.set(
    mispriced,
    paidInvoice(mispriced, customer.faircoin, sub.faircoin, mispricedPayment),
  );
  payments.set(mispricedPayment, faircoinPayment(mispricedPayment, '999'));
  await expect(deliver('invoice.paid', { invoice: mispriced })).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(/quote is not for the amount/),
  });

  for (const invoiceId of [unnamed, confirming, mispriced]) {
    const rows = await db
      .select({ id: merchantSubscriptionEvents.id })
      .from(merchantSubscriptionEvents)
      .where(eq(merchantSubscriptionEvents.providerInvoiceId, invoiceId));
    expect(rows).toHaveLength(0);
  }
});

it('the database refuses a quote on anything but FAIR received for a paid invoice', async () => {
  const [subscription] = await db
    .select({ id: merchantSubscriptions.id })
    .from(merchantSubscriptions)
    .where(eq(merchantSubscriptions.storeId, store.card));
  if (!subscription) throw new Error('no subscription');
  await expect(
    db.insert(merchantSubscriptionEvents).values({
      subscriptionId: subscription.id,
      kind: 'invoice_paid',
      note: 'a fiat amount with a FairCoin quote',
      amountAmount: 1299,
      amountCurrency: 'USD',
      quotedAmount: 1299,
      quotedCurrency: 'USD',
      quotedAt: new Date(),
    }),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      constraint_name: 'merchant_subscription_events_quote_faircoin_check',
    }),
  });
});

it('a FairCoin-started plan renews by invoice: the row and the plan view say so, a card plan does not', async () => {
  // Peable ADR 0021 D3: once FairCoin paid the first invoice the rail moves the
  // subscription to `send_invoice`, with the merchant's days until due.
  const invoiced = {
    ...nativeSubscription(sub.faircoin, customer.faircoin, 'active'),
    collection_method: 'send_invoice',
    days_until_due: 30,
  };
  subscriptions.set(sub.faircoin, invoiced);
  await deliver('customer.subscription.updated', {
    subscription: sub.faircoin,
    customer: customer.faircoin,
  });
  const [row] = await db
    .select({
      collectionMethod: merchantSubscriptions.collectionMethod,
      daysUntilDue: merchantSubscriptions.daysUntilDue,
      currentPeriodEnd: merchantSubscriptions.currentPeriodEnd,
    })
    .from(merchantSubscriptions)
    .where(eq(merchantSubscriptions.storeId, store.faircoin));
  expect(row).toMatchObject({ collectionMethod: 'send_invoice', daysUntilDue: 30 });

  const view = (await buildMerchantPlanStatus({ storeId: store.faircoin })).subscription;
  expect(view?.status).toBe('active');
  expect(view?.collectionMethod).toBe('send_invoice');
  const periodEnd = (invoiced.current_period_end as number) * 1000;
  expect(view?.nextInvoiceDueAt).toBe(new Date(periodEnd + 30 * 86_400_000).toISOString());
  expect(row?.currentPeriodEnd?.getTime()).toBe(periodEnd);

  // The card-started plan keeps its saved card, and nothing falls due.
  const card = (await buildMerchantPlanStatus({ storeId: store.card })).subscription;
  expect(card?.collectionMethod).toBe('charge_automatically');
  expect(card?.nextInvoiceDueAt).toBeNull();
});

it('the database refuses days until due on a plan the card renews', async () => {
  await expect(
    db
      .update(merchantSubscriptions)
      .set({ daysUntilDue: 30 })
      .where(eq(merchantSubscriptions.storeId, store.card)),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      constraint_name: 'merchant_subscriptions_days_until_due_check',
    }),
  });
});
