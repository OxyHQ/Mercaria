/** Actual timer, published Peable SDK, loopback synthetic gateway and migrated SQL.
 * No provider network, production authority or commercial activation is implied. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { eq, inArray } from 'drizzle-orm';
import { Peable, type BillingSubscription } from '@peable.to/sdk';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { stores } from '../../../db/schema/stores.js';
import { merchantSubscriptions, merchantSubscriptionEvents } from '../../../db/schema/merchantPlans.js';
import { activateMerchantPlan, insertMerchantPlan, insertMerchantPlanPrice } from '../../../db/merchantPlans/planRepository.js';
import { ensureBillingCustomer } from '../../../db/merchantPlans/subscriptionRepository.js';
import { CohortBillingProvider } from '../peable/adapter.js';
import { registerBillingProvider, resetBillingProviders, type BillingProvider, type BillingSubscriptionSnapshot } from '../provider.js';
import { reconcileMerchantSubscriptions } from '../subscription.service.js';
import { startMerchantSubscriptionReconciler, stopMerchantSubscriptionReconciler } from '../reconciler.js';

const flags = vi.hoisted(() => ({ stripe: false, cohort: '' }));
vi.mock('../../../config/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../config/index.js')>();
  return { ...original, config: { ...original.config,
    payments: { ...original.config.payments, stripe: { ...original.config.payments.stripe, get enabled() { return flags.stripe; } } },
    merchantBilling: { ...original.config.merchantBilling, enabled: false, reconciliationEnabled: true,
      reconciliationBatchSize: 1, reconciliationIntervalMs: 40, get peableCohortJson() { return flags.cohort; } },
  } };
});
let db: Database, server: Server, url: string;
let planId: string;
const nonce = randomUUID().replaceAll('-', '');
const ownedStores = [nonce.slice(0, 23) + '1', nonce.slice(0, 23) + '2'];
const outsiderStore = nonce.slice(0, 23) + '3';
const wrongModeStore = nonce.slice(0, 23) + '4';
const refs = ['outside', 'first', 'later', 'wrongmode'].map(label => `sub_${label}${nonce}`);
const snapshots = new Map<string, BillingSubscription>();
const calls: string[] = [];
const failures = new Set<string>();
let cohortProvider: CohortBillingProvider;
const legacyRead = vi.fn(async (ref: string): Promise<BillingSubscriptionSnapshot> => {
  calls.push(`legacy:${ref}`);
  if (!flags.stripe) throw new Error('Synthetic legacy rail is disabled');
  if (failures.has(ref)) throw new Error('Synthetic unavailable provider');
  const s = snapshots.get(ref);
  if (!s) throw new Error('Unknown synthetic subscription');
  return { ...s, status: 'paused', interval: 'monthly', currentPeriodStart: new Date(s.currentPeriodStart), currentPeriodEnd: new Date(s.currentPeriodEnd),
    trialEndsAt: undefined, cancelAt: undefined, cancelledAt: undefined };
});
const legacy: BillingProvider = { id: 'stripe', livemode: false,
  ensureCustomer: async () => { throw new Error('No mutations allowed'); },
  createCheckoutSession: async () => { throw new Error('No mutations allowed'); },
  createPortalSession: async () => { throw new Error('No mutations allowed'); },
  cancelAtPeriodEnd: async () => { throw new Error('No mutations allowed'); },
  retrieveSubscription: legacyRead,
};

beforeAll(async () => {
  db = await connectPostgres();
  await db.insert(stores).values([...ownedStores, outsiderStore, wrongModeStore].map((id, index) => ({ id, oxyAccountId: `fixture-${nonce}`, handle: `reconcile-${nonce}-${index}`, name: 'Own fixture', description: '', brandColor: '#101010' })));
  const plan = await insertMerchantPlan(db, { planKey: `reconcile-${nonce}`, version: 1, tier: 'paid', name: 'Synthetic fixture', summary: 'Not for sale', termsVersion: 'fixture', createdByOxyUserId: `fixture-${nonce}` });
  planId = plan.id;
  for (const livemode of [false, true]) await insertMerchantPlanPrice(db, { planId, provider: 'stripe', livemode, interval: 'monthly', unitPrice: { amount: 100, currency: 'USD' }, providerPriceId: `price_${livemode ? 'live' : 'test'}${nonce}` });
  await activateMerchantPlan(db, { id: planId, approvedByOxyUserId: `fixture-${nonce}` });
  const rowStores = [outsiderStore, ...ownedStores, wrongModeStore];
  for (let index = 0; index < rowStores.length; index++) {
    const storeId = rowStores[index]!; const livemode = index === 3;
    const customerId = `cus_${index}${nonce}`;
    const customer = await ensureBillingCustomer(db, { storeId, provider: 'stripe', livemode, providerCustomerId: customerId });
    const start = new Date(Date.now() - 60_000); const end = new Date(Date.now() + 86_400_000);
    await db.insert(merchantSubscriptions).values({ id: `00000000-0000-7000-800${index}-${nonce.slice(-12)}`, storeId, planId, billingCustomerId: customer.row.id, provider: 'stripe', livemode,
      providerSubscriptionId: refs[index]!, status: 'active', interval: 'monthly', currentPeriodStart: start, currentPeriodEnd: end,
      acceptedTermsVersion: 'fixture', acceptedByOxyUserId: `fixture-${nonce}`, acceptedAt: start });
    snapshots.set(refs[index]!, { providerSubscriptionId: refs[index]!, providerCustomerId: customerId,
      providerPriceId: `price_${livemode ? 'live' : 'test'}${nonce}`, storeId, planId, livemode, status: 'paused', interval: 'month',
      currentPeriodStart: start.toISOString(), currentPeriodEnd: end.toISOString(), trialEndsAt: null, cancelAt: null, cancelledAt: null, cancelAtPeriodEnd: false });
  }
  server = createServer(async (req, res) => {
    for await (const chunk of req) expect(Buffer.isBuffer(chunk)).toBe(true);
    if (req.method !== 'GET' && req.url !== '/auth/service-token') { res.writeHead(405); res.end(); return; }
    if (req.url === '/auth/service-token') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { token: 'synthetic-token', expiresIn: 300 } })); return; }
    if (req.url === '/v1/merchants/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'merchant-fixture', oxyAppId: 'app-fixture', environment: 'development' })); return; }
    const ref = req.url?.replace('/v1/billing/subscriptions/', '') ?? '';
    calls.push(ref);
    res.writeHead(failures.has(ref) ? 503 : snapshots.has(ref) ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failures.has(ref) ? { error: { type: 'api_error', message: 'synthetic unavailable' } } : snapshots.get(ref)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback gateway failed');
  url = `http://127.0.0.1:${address.port}`;
  const cohort = { merchantId: 'merchant-fixture', applicationId: 'app-fixture', environment: 'development' as const,
    platformAccountId: 'acct_fixture', livemode: false, storeIds: ownedStores };
  flags.cohort = JSON.stringify(cohort);
  cohortProvider = new CohortBillingProvider(legacy, new Peable({ publicKey: 'fixture-public', secret: 'fixture-secret', baseURL: url, oxyApiUrl: url }), cohort, async ref => {
    const s = snapshots.get(ref); if (!s) throw new Error('Unknown fixture'); return { id: ref, customerId: s.providerCustomerId, livemode: s.livemode };
  });
}, 120_000);

beforeEach(async () => {
  stopMerchantSubscriptionReconciler(); calls.length = 0; failures.clear(); legacyRead.mockClear(); flags.stripe = false;
  resetBillingProviders(); registerBillingProvider(cohortProvider);
  await db.update(merchantSubscriptions).set({ status: 'active' }).where(inArray(merchantSubscriptions.storeId, [...ownedStores, outsiderStore, wrongModeStore]));
});
afterEach(() => stopMerchantSubscriptionReconciler());
afterAll(async () => { stopMerchantSubscriptionReconciler(); resetBillingProviders(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await closePostgres(); });
const rows = () => db.select().from(merchantSubscriptions).where(inArray(merchantSubscriptions.storeId, [outsiderStore, wrongModeStore]));

it('selects the registered cohort before LIMIT and does not visit older foreign or other-mode rows', async () => {
  const foreign = await rows(); expect(foreign).toHaveLength(2);
  expect(await reconcileMerchantSubscriptions({ limit: 1 })).toMatchObject({ examined: 1, applied: 1, failed: 0 });
  expect(calls).toEqual([refs[1]]); expect(legacyRead).not.toHaveBeenCalled(); expect(await rows()).toEqual(foreign);
});

it('the actual timer advances beyond a failing first eligible subscription and reaches the next one with actions OFF', async () => {
  failures.add(refs[1]!); const foreign = await rows();
  startMerchantSubscriptionReconciler();
  try {
    await vi.waitFor(async () => {
      const [later] = await db.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.storeId, ownedStores[1]!));
      expect(later?.status).toBe('paused');
    }, { timeout: 5_000, interval: 25 });
  } finally { stopMerchantSubscriptionReconciler(); }
  expect(calls).toContain(refs[1]); expect(calls).toContain(refs[2]); expect(legacyRead).not.toHaveBeenCalled(); expect(await rows()).toEqual(foreign);
});

it('keeps general Stripe-enabled reconciliation for noncohort stores while excluding the other key mode', async () => {
  flags.stripe = true;
  // Another suite's subscription is eligible under the general rail but has no
  // snapshot in this fixture. Its failure must not become a whole-DB assertion.
  const foreignStore = nonce.slice(0, 23) + '5';
  const foreignRef = `sub_shared${nonce}`;
  await db.insert(stores).values({ id: foreignStore, oxyAccountId: `fixture-${nonce}`, handle: `reconcile-shared-${nonce}`, name: 'Other fixture', description: '', brandColor: '#101010' });
  const customer = await ensureBillingCustomer(db, { storeId: foreignStore, provider: 'stripe', livemode: false, providerCustomerId: `cus_shared${nonce}` });
  await db.insert(merchantSubscriptions).values({ id: `00000000-0000-7000-7fff-${nonce.slice(-12)}`, storeId: foreignStore, planId, billingCustomerId: customer.row.id,
    provider: 'stripe', livemode: false, providerSubscriptionId: foreignRef, status: 'active', interval: 'monthly',
    currentPeriodStart: new Date(Date.now() - 60_000), currentPeriodEnd: new Date(Date.now() + 86_400_000),
    acceptedTermsVersion: 'fixture', acceptedByOxyUserId: `fixture-${nonce}`, acceptedAt: new Date() });
  const [foreignBefore] = await db.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.storeId, foreignStore));
  const [wrongModeBefore] = await db.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.storeId, wrongModeStore));
  let afterId: string | undefined;
  let exhausted = false;
  // Traverse the general namespace; other suites may legitimately own rows.
  // Bound the fixture sweep and assert our effects, not global row counts.
  for (let page = 0; page < 50; page++) {
    const result = await reconcileMerchantSubscriptions({ limit: 100, afterId });
    afterId = result.nextAfterId ?? undefined;
    if (!afterId) { exhausted = true; break; }
  }
  expect(exhausted).toBe(true);
  expect(legacyRead).toHaveBeenCalledWith(refs[0]); expect(calls).not.toContain(`legacy:${refs[3]}`);
  expect(calls).toContain(refs[1]); expect(calls).toContain(refs[2]);
  expect(legacyRead).toHaveBeenCalledWith(foreignRef);
  const owned = await db.select().from(merchantSubscriptions).where(inArray(merchantSubscriptions.storeId, [outsiderStore, ...ownedStores]));
  expect(owned).toHaveLength(3); expect(owned.every(row => row.status === 'paused')).toBe(true);
  expect(await db.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.storeId, foreignStore))).toEqual([foreignBefore]);
  expect(await db.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.storeId, wrongModeStore))).toEqual([wrongModeBefore]);
});

it('does no provider read or subscription write before the cohort is registered', async () => {
  resetBillingProviders(); registerBillingProvider(legacy);
  const before = await db.select().from(merchantSubscriptions).where(inArray(merchantSubscriptions.storeId, [...ownedStores, outsiderStore, wrongModeStore]));
  expect(before).toHaveLength(4);
  expect(await reconcileMerchantSubscriptions({ limit: 10 })).toMatchObject({ examined: 0, applied: 0, failed: 0 });
  expect(calls).toEqual([]);
  expect(await db.select().from(merchantSubscriptions).where(inArray(merchantSubscriptions.storeId, [...ownedStores, outsiderStore, wrongModeStore]))).toEqual(before);
});


it('the actual timer advances the local grace audit beyond already-announced rows without a billing provider', async () => {
  resetBillingProviders();
  const ids = [...ownedStores, outsiderStore, wrongModeStore];
  await db.update(merchantSubscriptions).set({ status: 'past_due', graceExpiresAt: new Date(Date.now() - 60_000) })
    .where(inArray(merchantSubscriptions.storeId, ids));
  const subscriptions = await db.select().from(merchantSubscriptions).where(inArray(merchantSubscriptions.storeId, ids));
  expect(subscriptions).toHaveLength(4);
  startMerchantSubscriptionReconciler();
  try {
    await vi.waitFor(async () => {
      const audit = await db.select().from(merchantSubscriptionEvents)
        .where(inArray(merchantSubscriptionEvents.subscriptionId, subscriptions.map(row => row.id)));
      expect(audit.filter(row => row.kind === 'grace_expired')).toHaveLength(4);
    }, { timeout: 5_000, interval: 25 });
  } finally { stopMerchantSubscriptionReconciler(); }
  expect(calls).toEqual([]);
  expect(await db.select().from(merchantSubscriptions).where(inArray(merchantSubscriptions.storeId, ids))).toEqual(subscriptions);
});
