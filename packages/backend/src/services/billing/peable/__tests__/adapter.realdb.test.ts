/** Candidate SDK + actual HTTP + Mercaria SQL. Oxy/Peable/Stripe responses are synthetic. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Peable, type BillingSubscription } from '@peable.to/sdk';
import { connectPostgres, closePostgres, type Database } from '../../../../db/postgres.js';
import { stores } from '../../../../db/schema/stores.js';
import { activateMerchantPlan, insertMerchantPlan, insertMerchantPlanPrice, insertMerchantPlanAcceptance } from '../../../../db/merchantPlans/planRepository.js';
import { ensureBillingCustomer, findSubscriptionByStore } from '../../../../db/merchantPlans/subscriptionRepository.js';
import { applyProviderSubscriptionState, recordSubscriptionInvoicePaid } from '../../subscription.service.js';
import { CohortBillingProvider } from '../adapter.js';
import { registerBillingProvider, resetBillingProviders, type BillingProvider } from '../../provider.js';
import { startPlanCheckoutHandler, openPlanPortalHandler } from '../../../../controllers/merchant-plans.controller.js';
import { STRIPE_BILLING_EVENT_HANDLERS } from '../../stripe/subscription-events.js';
import { merchantSubscriptionEvents } from '../../../../db/schema/merchantPlans.js';
import { ledgerEntries } from '../../../../db/schema/ledger.js';
const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../../config/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../config/index.js')>();
  return { ...original, config: { ...original.config, merchantBilling: { ...original.config.merchantBilling, get enabled() { return flags.enabled; }, returnUrl: 'https://dashboard.mercaria.co/settings/plan' } } };
});

let db: Database, server: Server, routeServer: Server, url: string, routeUrl: string;
let storeId: string, otherStoreId: string, planId: string;
let snapshot: BillingSubscription;
let behavior: 'normal' | 'lost' | 'foreign-merchant' | 'wrong-store' | 'wrong-plan' | 'wrong-mode' | 'expired' | 'unavailable' | 'result-expired' = 'normal';
const nonce = randomUUID().replaceAll('-', '');
const customer = `cus_${nonce}`;
const price = `price_${nonce}`;
const sub = `sub_${nonce}`;
const calls: { method: string; path: string; key?: string }[] = [];
const receipts = new Map<string, unknown>();
let effects = 0;
let provider: CohortBillingProvider;
let legacy: BillingProvider;
const readStripe = vi.fn(async (ref: string) => ({ id: ref, customerId: customer, livemode: false }));

beforeAll(async () => {
  db = await connectPostgres();
  const inserted = await db.insert(stores).values(['cohort', 'other'].map(label => ({ handle: `billing-${nonce}-${label}`, name: label, description: '', brandColor: '#101010' }))).returning();
  storeId = inserted[0]!.id; otherStoreId = inserted[1]!.id;
  const plan = await insertMerchantPlan(db, { planKey: `i08-${nonce}`, version: 1, tier: 'paid', name: 'Fixture', summary: 'synthetic', termsVersion: 'v1', createdByOxyUserId: `operator-${nonce}` });
  planId = plan.id;
  await insertMerchantPlanPrice(db, { planId, provider: 'stripe', livemode: false, interval: 'monthly', unitPrice: { amount: 100, currency: 'USD' }, providerPriceId: price });
  await activateMerchantPlan(db, { id: planId, approvedByOxyUserId: `approver-${nonce}` });
  await ensureBillingCustomer(db, { storeId, provider: 'stripe', livemode: false, providerCustomerId: customer });
  await ensureBillingCustomer(db, { storeId: otherStoreId, provider: 'stripe', livemode: false, providerCustomerId: `cus_other${nonce}` });
  await insertMerchantPlanAcceptance(db, { storeId, planKey: plan.planKey, planVersion: 1, termsVersion: 'v1', acceptedByOxyUserId: `payer-${nonce}` });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = req.url!; const key = req.headers['idempotency-key'] as string | undefined;
    calls.push({ method: req.method!, path, key });
    const reply = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path === '/auth/service-token') return reply({ data: { token: 'fixture-token', expiresIn: 300 } });
    if (path === '/v1/merchants/me') return reply({ id: behavior === 'foreign-merchant' ? 'foreign' : 'merchant-fixture', oxyAppId: 'app-fixture', environment: 'development' });
    if (behavior === 'result-expired') return reply({ error: { type: 'invalid_request_error', message: 'result_expired' } }, 409);
    if (behavior === 'unavailable') return reply({ error: { type: 'api_error', message: 'DO_NOT_LOG https://private.invalid/token' } }, 503);
    if (path.includes('/subscriptions/')) {
      let value = { ...snapshot };
      if (path.endsWith('/cancel_at_period_end')) value = { ...value, cancelAtPeriodEnd: true, cancelAt: snapshot.currentPeriodEnd };
      if (behavior === 'wrong-store') value.storeId = otherStoreId;
      if (behavior === 'wrong-plan') value.planId = 'foreign';
      if (behavior === 'wrong-mode') value.livemode = true;
      return reply(value);
    }
    if (path === '/v1/billing/customers') return reply({ providerCustomerId: customer });
    if (path === '/v1/billing/checkout_sessions' || path === '/v1/billing/portal_sessions') {
      if (!key) return reply({ error: { type: 'invalid_request_error', message: 'missing key' } }, 400);
      const receipt = receipts.get(key) ?? { url: 'https://checkout.stripe.com/fixture', expiresAt: new Date(Date.now() + (behavior === 'expired' ? -1000 : 60_000)).toISOString() };
      if (!receipts.has(key)) { receipts.set(key, receipt); effects++; }
      if (path.includes('checkout') && (body.storeId !== storeId || body.planId !== planId)) return reply({}, 400);
      if (behavior === 'lost') { behavior = 'normal'; res.destroy(); return; }
      return reply(receipt);
    }
    reply({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = express(); app.use(express.json());
  // Synthetic already-authorized Oxy/store seam. The actual controllers/domain/SDK/SQL run.
  app.use((req, _res, next) => { Object.assign(req, { userId: `payer-${nonce}`, store: { id: storeId, name: 'Fixture' } }); next(); });
  app.post('/admin/stores/:storeId/plan/checkout', startPlanCheckoutHandler);
  app.post('/admin/stores/:storeId/plan/portal', openPlanPortalHandler);
  routeServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => routeServer.on('listening', resolve));
  routeUrl = `http://127.0.0.1:${(routeServer.address() as { port: number }).port}`;
}, 120_000);
afterAll(async () => { resetBillingProviders(); await new Promise<void>(resolve => routeServer.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await closePostgres(); });
beforeEach(() => {
  behavior = 'normal'; flags.enabled = true; resetBillingProviders(); calls.length = 0; readStripe.mockClear();
  snapshot = { providerSubscriptionId: sub, providerCustomerId: customer, providerPriceId: price, storeId, planId, livemode: false, status: 'active', interval: 'month', cancelAtPeriodEnd: false, currentPeriodStart: '2026-10-01T00:00:00.000Z', currentPeriodEnd: '2026-11-01T00:00:00.000Z', trialEndsAt: null, cancelAt: null, cancelledAt: null };
  legacy = { id: 'stripe', livemode: false, ensureCustomer: vi.fn(), createCheckoutSession: vi.fn(), createPortalSession: vi.fn(), retrieveSubscription: vi.fn(), cancelAtPeriodEnd: vi.fn() };
  provider = new CohortBillingProvider(legacy, new Peable({ publicKey: 'fixture-public', secret: 'fixture-secret', baseURL: url, oxyApiUrl: url }), { merchantId: 'merchant-fixture', applicationId: 'app-fixture', environment: 'development', platformAccountId: 'acct_fixture', livemode: false, storeIds: [storeId] }, readStripe);
  registerBillingProvider(provider);
});
const checkout = () => ({ providerCustomerId: customer, providerPriceId: price, trialDays: 0, returnUrl: 'https://dashboard.mercaria.co/settings/plan', storeId, planId, idempotencyKey: `checkout-${randomUUID()}` });
describe('Peable cohort adoption / actual SDK HTTP and SQL', () => {
  it('preserves the customer/store/plan and maps scheduled cancellation without changing rail identity', async () => {
    expect(provider.id).toBe('stripe');
    expect(await provider.ensureCustomer({ storeId, storeName: 'Fixture', idempotencyKey: `customer-${nonce}` })).toEqual({ providerCustomerId: customer });
    const result = await provider.retrieveSubscription(sub);
    expect(result).toMatchObject({ providerCustomerId: customer, providerPriceId: price, status: 'active', interval: 'monthly' });
    expect(result.currentPeriodEnd).toEqual(new Date(snapshot.currentPeriodEnd));
    expect(readStripe).toHaveBeenCalledWith(sub);
    expect((await provider.cancelAtPeriodEnd(sub, `cancel-${nonce}`)).status).toBe('cancelled');
    expect(legacy.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });
  it('keeps one remote effect after a lost response and an explicit same-key retry', async () => {
    behavior = 'lost'; const input = checkout(); const before = effects;
    await expect(provider.createCheckoutSession(input)).rejects.toMatchObject({ code: 'billing_outcome_unknown', retryable: true });
    expect(calls.filter(c => c.path === '/v1/billing/checkout_sessions')).toHaveLength(1);
    expect((await provider.createCheckoutSession(input)).url).toBe('https://checkout.stripe.com/fixture');
    expect(effects - before).toBe(1);
    expect(calls.filter(c => c.path === '/v1/billing/checkout_sessions').map(c => c.key)).toEqual([input.idempotencyKey, input.idempotencyKey]);
    expect(legacy.createCheckoutSession).not.toHaveBeenCalled();
  });
  it('keeps legacy only for SQL-resolved noncohort stores', async () => {
    await provider.ensureCustomer({ storeId: otherStoreId, storeName: 'Other', idempotencyKey: 'other-customer' });
    await provider.createPortalSession({ providerCustomerId: `cus_other${nonce}`, returnUrl: 'https://dashboard.mercaria.co' });
    expect(legacy.ensureCustomer).toHaveBeenCalledTimes(1); expect(legacy.createPortalSession).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
  it('denies unknown customer and invented subscription without falling back or mutating', async () => {
    await expect(provider.createPortalSession({ providerCustomerId: 'cus_unknown', returnUrl: 'https://dashboard.mercaria.co', idempotencyKey: 'portal-unknown' })).rejects.toMatchObject({ code: 'billing_cohort_mismatch' });
    readStripe.mockResolvedValueOnce({ id: 'sub_wrong', customerId: customer, livemode: false });
    await expect(provider.retrieveSubscription('sub_unknown')).rejects.toMatchObject({ code: 'billing_cohort_mismatch' });
    expect(legacy.createPortalSession).not.toHaveBeenCalled(); expect(legacy.retrieveSubscription).not.toHaveBeenCalled();
  });
  for (const mismatch of ['foreign-merchant', 'wrong-store', 'wrong-plan', 'wrong-mode'] as const) {
    it(`rejects ${mismatch} without legacy fallback`, async () => {
      behavior = mismatch;
      await expect(provider.retrieveSubscription(sub)).rejects.toMatchObject({ code: 'billing_cohort_mismatch' });
      expect(legacy.retrieveSubscription).not.toHaveBeenCalled();
    });
  }
  it('requires stable portal/cancel keys before contacting the gateway', async () => {
    await expect(provider.createPortalSession({ providerCustomerId: customer, returnUrl: 'https://dashboard.mercaria.co' })).rejects.toMatchObject({ code: 'idempotency_key_required' });
    await expect(provider.cancelAtPeriodEnd(sub)).rejects.toMatchObject({ code: 'idempotency_key_required' });
    expect(calls).toHaveLength(0);
  });
  it('refuses expired hosted results and sanitizes upstream failure messages', async () => {
    behavior = 'expired'; await expect(provider.createCheckoutSession(checkout())).rejects.toMatchObject({ code: 'billing_cohort_mismatch' });
    behavior = 'unavailable';
    await expect(provider.createPortalSession({ providerCustomerId: customer, returnUrl: 'https://dashboard.mercaria.co', idempotencyKey: 'portal-error' })).rejects.toMatchObject({ message: 'The billing gateway could not complete this request.', retryable: true });
    expect(legacy.createPortalSession).not.toHaveBeenCalled();
  });
  it('passes a caller intent through the actual checkout controller and refuses omission before effects', async () => {
    const post = (key?: string) => fetch(`${routeUrl}/admin/stores/${storeId}/plan/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ planId, interval: 'monthly', currency: 'USD' }) });
    expect((await post()).status).toBe(400); expect(calls).toHaveLength(0);
    expect((await post('bad key')).status).toBe(400); expect(calls).toHaveLength(0);
    const key = `route-${nonce}`;
    expect((await post(key)).status).toBe(200);
    expect(calls.filter(c => c.path === '/v1/billing/checkout_sessions').map(c => c.key)).toEqual([key]);
  });
  it('makes a conclusively expired owner result terminal without replaying another POST', async () => {
    behavior = 'result-expired';
    const response = await fetch(`${routeUrl}/admin/stores/${storeId}/plan/portal`, { method: 'POST', headers: { 'idempotency-key': `expired-${nonce}` } });
    expect(response.status).toBe(400);
    expect(calls.filter(c => c.path === '/v1/billing/portal_sessions')).toHaveLength(1);
    expect(legacy.createPortalSession).not.toHaveBeenCalled();
  });
  it('blocks new actions when disabled but still reconciles the same durable cohort', async () => {
    flags.enabled = false;
    const response = await fetch(`${routeUrl}/admin/stores/${storeId}/plan/portal`, { method: 'POST', headers: { 'idempotency-key': `portal-${nonce}` } });
    expect(response.status).toBe(409); expect(calls).toHaveLength(0);
    expect((await provider.retrieveSubscription(sub)).providerCustomerId).toBe(customer);
    expect(legacy.retrieveSubscription).not.toHaveBeenCalled();
  });
  it('projects a verified snapshot through real Mercaria state and deduplicates the same event', async () => {
    const current = await provider.retrieveSubscription(sub);
    const input = { snapshot: current, providerEventId: `evt_${nonce}`, eventKind: 'reconciled' as const, note: 'synthetic HTTP fixture' };
    const first = await applyProviderSubscriptionState(input);
    expect(first.outcome).toBe('applied');
    expect((await findSubscriptionByStore(db, storeId))?.providerSubscriptionId).toBe(sub);
    expect((await applyProviderSubscriptionState(input)).outcome).toBe('already_applied');
    // An older webhook triggers a fresh retrieve; it cannot supply an older authoritative state.
    snapshot = { ...snapshot, status: 'past_due' };
    const refreshed = await provider.retrieveSubscription(sub);
    expect(refreshed.status).toBe('past_due');
    const handler = STRIPE_BILLING_EVENT_HANDLERS['customer.subscription.updated']!;
    const event = { storedEventId: `stored-${nonce}`, providerEventId: `evt_old_${nonce}`, type: 'customer.subscription.updated', objectIds: { subscription: sub } };
    expect((await handler(event)).kind).toBe('applied');
    expect((await handler(event)).kind).toBe('applied');
    expect((await findSubscriptionByStore(db, storeId))?.status).toBe('past_due');
    expect(await findSubscriptionByStore(db, otherStoreId)).toBeUndefined();
    const subscription = await findSubscriptionByStore(db, storeId);
    const invoice = { subscriptionId: subscription!.id, providerEventId: `evt_invoice_${nonce}`, providerInvoiceId: `in_${nonce}`, settlement: { currency: 'USD' as const, netMinor: 97, feeMinor: 3 }, note: 'synthetic settlement observation; no provider charge' };
    expect(await recordSubscriptionInvoicePaid(invoice)).toEqual({ booked: true });
    expect(await recordSubscriptionInvoicePaid(invoice)).toEqual({ booked: false });
    const receipt = await db.select().from(merchantSubscriptionEvents).where(eq(merchantSubscriptionEvents.providerInvoiceId, invoice.providerInvoiceId));
    expect(receipt).toHaveLength(1); expect(receipt[0]!.subscriptionId).toBe(subscription!.id);
    expect(subscription!.storeId).toBe(storeId);
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, receipt[0]!.ledgerTransactionId!));
    expect(entries.reduce((sum, entry) => sum + entry.amountMinor, 0n)).toBe(0n);
    expect(entries.some(entry => entry.account === 'subscription_revenue')).toBe(true);
  });
});
