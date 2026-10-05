/** Real config/createApp, signatures, published Stripe transport and owned SQL.
 * Provider responses are synthetic; no provider account or live effects are used. */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/postgres.js';
const transport = vi.hoisted(() => ({ fetch: vi.fn(), paths: [] as string[] }));
vi.mock('stripe', async original => {
  const module = await original<typeof import('stripe')>(); const Actual = module.default;
  return { ...module, default: class extends Actual {
    constructor(key: string, options?: ConstructorParameters<typeof Actual>[1]) { super(key, { ...options, httpClient: Actual.createFetchHttpClient(transport.fetch) }); }
  } };
});
const nonce = randomUUID().replaceAll('-', '');
const otherCohortStoreId = randomUUID().replaceAll('-', '').slice(0,24);
const otherCohortCustomer = `cus_second${nonce}`;
const storeId = nonce.slice(0, 24), customer = `cus_${nonce}`, sub = `sub_${nonce}`, invoice = `in_${nonce}`, charge = `ch_${nonce}`, price = `price_${nonce}`;
const secret = 'whsec_owned_fixture';
let db: Database, server: Server, gateway: Server, base: string, planId: string;
const actions = process.env.I08_TEST_ACTIONS === 'true';
let gatewayStatus = 'active';
const receipts = new Map<string, unknown>();
let effects = 0, loseCheckout = false, gatewayCanceled = false;
const gatewayCalls: { path: string; key?: string }[] = [];
let postgres: typeof import('../../db/postgres.js');
let events: typeof import('../../db/schema/payments.js').paymentProviderEvents;
let subscriptionEvents: typeof import('../../db/schema/merchantPlans.js').merchantSubscriptionEvents;
let ledger: typeof import('../../db/schema/ledger.js').ledgerEntries;
let config: typeof import('../../config/index.js').config;
let resetBillingProviders: typeof import('../../services/billing/provider.js').resetBillingProviders;
let outsiderStoreId: string;
const retryInvoice = `in_retry${nonce}`;
const expiredLeaseInvoice = `in_expired${nonce}`;
let balanceAvailable = true;
let platformAccountOverride: string | undefined;
let invoiceWrongCustomer = false;
let invoiceCustomerOverride: string | undefined;
beforeAll(async () => {
  gateway = createServer(async (req, res) => {
    for await (const chunk of req) { expect(Buffer.isBuffer(chunk)).toBe(true); }
    const path = req.url!; const key = req.headers['idempotency-key'] as string | undefined;
    gatewayCalls.push({ path, key });
    let data: unknown;
    if (path === '/auth/service-token') data = { data: { token: 'synthetic-token', expiresIn: 300 } };
    else if (path === '/v1/merchants/me') data = { id: 'merchant-fixture', oxyAppId: 'app-fixture', environment: 'development' };
    else if (path === `/v1/billing/subscriptions/${sub}` || path === `/v1/billing/subscriptions/${sub}/cancel_at_period_end`) {
      if (path.endsWith('/cancel_at_period_end')) {
        if (!key) { res.writeHead(400); res.end(); return; }
        gatewayCanceled = true;
      }
      data = {
      providerSubscriptionId: sub, providerCustomerId: customer, providerPriceId: price, storeId, planId, livemode: false,
      status: gatewayStatus, interval: 'month', cancelAtPeriodEnd: gatewayCanceled, currentPeriodStart: new Date(Date.now()-60_000).toISOString(),
      currentPeriodEnd: new Date(Date.now()+86_400_000).toISOString(), trialEndsAt: null, cancelAt: gatewayCanceled ? new Date(Date.now()+86_400_000).toISOString() : null, cancelledAt: null,
    }; }
    else if (path === '/v1/billing/checkout_sessions' || path === '/v1/billing/portal_sessions') {
      if (!key) { res.writeHead(400); res.end(); return; }
      if (!receipts.has(key)) { effects++; receipts.set(key, { url: 'https://checkout.stripe.com/owned', expiresAt: new Date(Date.now()+60_000).toISOString() }); }
      if (loseCheckout) { loseCheckout = false; res.destroy(); return; }
      data = receipts.get(key);
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as {port:number}).port}`;
  vi.stubEnv('PEABLE_BASE_URL', gatewayUrl); vi.stubEnv('OXY_API_URL', gatewayUrl);
  vi.stubEnv('MERCHANT_BILLING_RETURN_URL', 'https://dashboard.mercaria.co/settings/plan');
  for (const [key,value] of Object.entries({ STRIPE_EVENT_POLL_INTERVAL_MS:'25', STRIPE_ENABLED:'false', STRIPE_SECRET_KEY:'sk_test_fixture', STRIPE_WEBHOOK_SECRET:secret, STRIPE_CONNECT_WEBHOOK_SECRET:'whsec_connect_fixture', MERCHANT_BILLING_ENABLED:String(actions), PEABLE_APP_PUBLIC_KEY:'fixture-public', PEABLE_APP_SECRET:'fixture-secret', MERCHANT_BILLING_PEABLE_COHORT: JSON.stringify({ merchantId:'merchant-fixture', applicationId:'app-fixture', environment:'development', platformAccountId:'acct_fixture', livemode:false, storeIds:[storeId,otherCohortStoreId] }) })) vi.stubEnv(key,value);
  config = (await import('../../config/index.js')).config;
  postgres = await import('../../db/postgres.js'); db = await postgres.connectPostgres();
  ({ paymentProviderEvents:events } = await import('../../db/schema/payments.js'));
  ({ merchantSubscriptionEvents:subscriptionEvents } = await import('../../db/schema/merchantPlans.js'));
  ({ ledgerEntries:ledger } = await import('../../db/schema/ledger.js'));
  const { stores } = await import('../../db/schema/stores.js');
  await db.insert(stores).values({ oxyAccountId: 'oxy-account-fixture', id:storeId, handle:`cohort-${nonce}`, name:'Owned fixture', description:'', brandColor:'#101010' });
  const [outsider] = await db.insert(stores).values({ oxyAccountId: 'oxy-account-fixture',handle:`outside-${nonce}`,name:'Owned outsider',description:'',brandColor:'#101010'}).returning();
  outsiderStoreId = outsider!.id;
  await db.insert(stores).values({ oxyAccountId: 'oxy-account-fixture',id:otherCohortStoreId,handle:`second-${nonce}`,name:'Second cohort',description:'',brandColor:'#101010'});
  const plans = await import('../../db/merchantPlans/planRepository.js');
  const p = await plans.insertMerchantPlan(db,{ planKey:`cohort-${nonce}`,version:1,tier:'paid',name:'Fixture',summary:'synthetic',termsVersion:'v1',createdByOxyUserId:`operator-${nonce}` });
  planId = p.id;
  await plans.insertMerchantPlanPrice(db,{planId:p.id,provider:'stripe',livemode:false,interval:'monthly',unitPrice:{amount:100,currency:'USD'},providerPriceId:price});
  await plans.activateMerchantPlan(db,{id:p.id,approvedByOxyUserId:`approver-${nonce}`});
  await plans.insertMerchantPlanAcceptance(db,{storeId,planKey:p.planKey,planVersion:1,termsVersion:'v1',acceptedByOxyUserId:`payer-${nonce}`});
  const { ensureBillingCustomer } = await import('../../db/merchantPlans/subscriptionRepository.js');
  await ensureBillingCustomer(db,{storeId,provider:'stripe',livemode:false,providerCustomerId:customer});
  await ensureBillingCustomer(db,{storeId:outsider!.id,provider:'stripe',livemode:false,providerCustomerId:'cus_outsider'});
  await ensureBillingCustomer(db,{storeId:otherCohortStoreId,provider:'stripe',livemode:false,providerCustomerId:otherCohortCustomer});
  const { applyProviderSubscriptionState } = await import('../../services/billing/subscription.service.js');
  await applyProviderSubscriptionState({snapshot:{livemode:false,providerSubscriptionId:sub,providerCustomerId:customer,providerPriceId:price,status:'active',interval:'monthly',currentPeriodStart:new Date(Date.now()-60_000),currentPeriodEnd:new Date(Date.now()+86_400_000)},note:'own fixture',providerEventId:`seed-${nonce}`,eventKind:'reconciled'});
  transport.fetch.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname; transport.paths.push(path); expect(options?.method).toBe('GET');
    let data: unknown;
    if(path==='/v1/account') data={id:platformAccountOverride ?? 'acct_fixture'};
    else if(path===`/v1/invoices/${invoice}` || path===`/v1/invoices/${retryInvoice}` || path===`/v1/invoices/${expiredLeaseInvoice}`) data={id:path.split('/').at(-1),customer:invoiceCustomerOverride ?? (invoiceWrongCustomer?'cus_outsider':customer),livemode:false,parent:{subscription_details:{subscription:sub}},payments:{data:[{payment:{charge}}]}};
    else if(path===`/v1/charges/${charge}`) data={id:charge,customer,livemode:false,balance_transaction:balanceAvailable ? {net:97,fee:3,currency:'usd'} : null};
    else throw new Error('Unexpected provider request');
    return new Response(JSON.stringify(data),{status:200});
  });
  await (await import('../../services/billing/register.js')).registerMerchantBillingProvider();
  transport.paths.length = 0;
  ({ resetBillingProviders } = await import('../../services/billing/provider.js'));
  const { createApp } = await import('../../app.js'); server=createApp().listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
},120_000);
afterAll(async()=>{ (await import('../../services/payments/stripe/event-dispatcher.js')).stopStripeEventDispatcher();if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));if(gateway)await new Promise<void>(resolve=>gateway.close(()=>resolve()));resetBillingProviders?.();if(postgres)await postgres.closePostgres();vi.unstubAllEnvs(); });
async function stored(id:string){return db.select().from(events).where(and(eq(events.provider,'stripe'),eq(events.providerEventId,id)));}
async function post(id:string, type='invoice.paid', object:Record<string,unknown>={id:invoice,object:'invoice',customer}, path='/webhooks/stripe') {
  const payload=JSON.stringify({id,object:'event',api_version:'2026-07-29.dahlia',created:Math.floor(Date.now()/1000),livemode:false,type,data:{object},pending_webhooks:1,request:{id:null,idempotency_key:null}});
  const signature=await Stripe.webhooks.generateTestHeaderStringAsync({payload,secret});
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});
  const text = await response.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = { nonJson: true }; }
  return { status: response.status, body };
}
it('keeps actions/general/Connect rails disabled but mounts the signed billing ingress',async()=>{
 expect(config.merchantBilling.enabled).toBe(actions);expect(config.payments.stripe.enabled).toBe(false);
 const response=await fetch(base+'/webhooks/stripe',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});expect(response.status).toBe(400);expect(await response.json()).toEqual({received:false,error:'missing_signature'});expect(transport.paths).toHaveLength(0);
});
it('signed paid invoice settles once in SQL while general Stripe and new actions are off',async()=>{
 const id=`evt_paid${nonce}`;expect((await post(id)).status).toBe(200);
 const rows=await stored(id);expect(rows).toHaveLength(1);expect(rows[0]!.status).toBe('processed');
 const claims=await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,invoice));expect(claims).toHaveLength(1);expect(claims[0]!.ledgerTransactionId).toBeTruthy();
 const entries=await db.select().from(ledger).where(eq(ledger.transactionId,claims[0]!.ledgerTransactionId!));expect(entries.length).toBeGreaterThan(0);expect(entries.reduce((sum,row)=>sum+row.amountMinor,0n)).toBe(0n);
 expect((await post(id)).body).toEqual({received:true,duplicate:true});expect(await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,invoice))).toHaveLength(1);
 expect(transport.paths).toEqual(['/v1/account',`/v1/invoices/${invoice}`,'/v1/account',`/v1/charges/${charge}`]);
});
for(const [label,type,object,path] of [
 ['outsider','invoice.paid',{id:invoice,object:'invoice',customer:'cus_outsider'},'/webhooks/stripe'],
 ['marketplace','payment_intent.succeeded',{id:'pi_outside',object:'payment_intent',customer},'/webhooks/stripe'],
 ['connect','invoice.paid',{id:invoice,object:'invoice',customer},'/webhooks/stripe/connect'],
] as const) it(`refuses ${label} before storage and provider calls`,async()=>{
 const before=transport.paths.length;const id=`evt_${label}${nonce}`;const result=await post(id,type,object,path);
 if(label==='connect')expect(result.status).toBe(404);else expect(result.body).toEqual({received:false,ignored:'billing_cohort_mismatch'});
 expect(await stored(id)).toHaveLength(0);expect(transport.paths).toHaveLength(before);
});
it('a mismatched fresh invoice customer cannot post settlement or request its charge',async()=>{
 invoiceWrongCustomer=true;const before=transport.paths.length;const id=`evt_mismatch${nonce}`;
 try {expect((await post(id)).status).toBe(200);expect((await stored(id))[0]!.status).not.toBe('processed');expect(transport.paths.slice(before)).toEqual(['/v1/account',`/v1/invoices/${invoice}`]);}
 finally {invoiceWrongCustomer=false;}
});

it('uses the real action flag and published gateway SDK, with stable-key recovery', async () => {
  const { startMerchantPlanCheckout, openMerchantBillingPortal, scheduleMerchantSubscriptionCancellation } = await import('../../services/billing/subscription.service.js');
  const input = { storeId, storeName: 'Owned fixture', planId, interval: 'monthly' as const, currency: 'USD' as const,
    actorOxyUserId: `payer-${nonce}`, idempotencyKey: `checkout-${nonce}` };
  const before = effects;
  if (!actions) {
    await expect(startMerchantPlanCheckout(input)).rejects.toThrow('Paid plans are not available');
    await expect(openMerchantBillingPortal({ storeId, idempotencyKey: `portal-${nonce}` })).rejects.toThrow('Paid plans are not available');
    await expect(scheduleMerchantSubscriptionCancellation({ storeId, actorOxyUserId: `payer-${nonce}`, idempotencyKey: `cancel-${nonce}` })).rejects.toThrow('Paid plans are not available');
    expect(effects).toBe(before); return;
  }
  loseCheckout = true;
  await expect(startMerchantPlanCheckout(input)).rejects.toMatchObject({ code: 'billing_outcome_unknown' });
  expect((await startMerchantPlanCheckout(input)).url).toBe('https://checkout.stripe.com/owned');
  expect(effects-before).toBe(1);
  expect(gatewayCalls.filter(c=>c.path==='/v1/billing/checkout_sessions').map(c=>c.key)).toEqual([input.idempotencyKey,input.idempotencyKey]);
  expect((await openMerchantBillingPortal({ storeId, idempotencyKey: `portal-${nonce}` })).url).toBe('https://checkout.stripe.com/owned');
  expect((await scheduleMerchantSubscriptionCancellation({ storeId, actorOxyUserId: `payer-${nonce}`, idempotencyKey: `cancel-${nonce}` })).status).toBe('cancelled');
  expect(gatewayCalls.filter(c=>c.path==='/v1/billing/portal_sessions').map(c=>c.key)).toEqual([`portal-${nonce}`]);
  expect(gatewayCalls.filter(c=>c.path.endsWith('/cancel_at_period_end')).map(c=>c.key)).toEqual([`cancel-${nonce}`]);
});
it('signed lifecycle and failed-invoice events apply current gateway snapshots with actions off/on', async () => {
  gatewayStatus = 'past_due';
  for (const [label,type,object] of [
    ['updated','customer.subscription.updated',{id:sub,object:'subscription',customer}],
    ['failed','invoice.payment_failed',{id:invoice,object:'invoice',customer}],
  ] as const) {
    const id = `evt_${label}${nonce}`;
    expect((await post(id,type,object)).status).toBe(200);expect((await stored(id))[0]!.status).toBe('processed');
    expect((await post(id,type,object)).body).toEqual({received:true,duplicate:true});
  }
  gatewayStatus = 'canceled';
  const id = `evt_deleted${nonce}`;
  expect((await post(id,'customer.subscription.deleted',{id:sub,object:'subscription',customer})).status).toBe(200);
  expect((await stored(id))[0]!.status).toBe('processed');
  const { findSubscriptionByStore } = await import('../../db/merchantPlans/subscriptionRepository.js');
  expect((await findSubscriptionByStore(db,storeId))!.status).toBe('expired');
});

it('a second approved store cannot book an invoice against the first store subscription', async () => {
  invoiceCustomerOverride = otherCohortCustomer;
  const id = `evt_crossstore${nonce}`, before = transport.paths.length;
  try {
    expect((await post(id, 'invoice.paid', { id: invoice, object: 'invoice', customer: otherCohortCustomer })).status).toBe(200);
    expect((await stored(id))[0]!.status).toBe('dead_letter');
    expect(transport.paths.slice(before)).toEqual(['/v1/account', `/v1/invoices/${invoice}`]);
    expect(await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerEventId,id))).toHaveLength(0);
  } finally { invoiceCustomerOverride = undefined; }
});

it('startup without a verified namespace returns retryable503 without storage or effects', async () => {
  const providers = await import('../../services/billing/provider.js');
  const registered = providers.getBillingProvider('stripe')!;
  providers.resetBillingProviders();
  const id = `evt_notready${nonce}`, before = transport.paths.length;
  try {
    expect(await post(id)).toEqual({ status: 503, body: { received: false, error: 'billing_cohort_unavailable' } });
    expect(await stored(id)).toHaveLength(0); expect(transport.paths).toHaveLength(before);
  } finally { providers.registerBillingProvider(registered); }
});

it('durable replay refuses an event from the other mode before provider reads or SQL effects', async () => {
  const { recordProviderEvent, claimProviderEvent, failProviderEvent } = await import('../../db/payments/paymentRepository.js');
  const { replayProviderEvent } = await import('../../services/payments/stripe/event-processor.js');
  const id = `evt_othermode${nonce}`, before = transport.paths.length, gatewayBefore = gatewayCalls.length;
  const storedRow = await recordProviderEvent(db, { provider: 'stripe', providerEventId: id, type: 'invoice.paid',
    livemode: true, objectIds: { invoice, customer }, payloadSummary: {}, expiresAt: new Date(Date.now()+86_400_000) });
  const leaseOwner = `own-replay-${nonce}`;
  expect(await claimProviderEvent(db, { leaseOwner, leaseMs: 60_000, providers: ['stripe'], eventId: storedRow.row.id })).toBeTruthy();
  expect(await failProviderEvent(db, { eventId: storedRow.row.id, leaseOwner, error: 'synthetic transient failure', deadLetter: false, nextAttemptAt: new Date(Date.now()+60_000) })).toBe(true);
  const original = await stored(id);
  expect(await replayProviderEvent(storedRow.row.id)).toBe(false);
  expect(await stored(id)).toEqual(original);
  expect(transport.paths).toHaveLength(before);expect(gatewayCalls).toHaveLength(gatewayBefore);
  expect(await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerEventId,id))).toHaveLength(0);
});

it('the settlement handler itself works independently of webhook mounting and deduplicates the same event', async () => {
  const { STRIPE_BILLING_EVENT_HANDLERS } = await import('../../services/billing/stripe/subscription-events.js');
  const result = await STRIPE_BILLING_EVENT_HANDLERS['invoice.paid']!({ storedEventId: `synthetic-${nonce}`,
    providerEventId: `evt_paid${nonce}`, type: 'invoice.paid', livemode: false, objectIds: { invoice, customer } });
  expect(result).toEqual({ kind: 'applied', note: 'already booked' });
  const claims = await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,invoice));
  expect(claims).toHaveLength(1); expect(claims[0]!.ledgerTransactionId).toBeTruthy();
});

it('a distinct delivery of an already paid invoice creates no second financial posting', async () => {
  const { STRIPE_BILLING_EVENT_HANDLERS } = await import('../../services/billing/stripe/subscription-events.js');
  expect(await STRIPE_BILLING_EVENT_HANDLERS['invoice.paid']!({ storedEventId: `distinct-${nonce}`,
    providerEventId: `evt_distinct${nonce}`, type: 'invoice.paid', livemode: false, objectIds: { invoice, customer } }))
    .toEqual({ kind: 'applied', note: 'already booked' });
  const claims = await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,invoice));
  expect(claims).toHaveLength(1);expect(claims[0]!.ledgerTransactionId).toBeTruthy();
});

async function currentSubscription() {
  const { findSubscriptionByStore } = await import('../../db/merchantPlans/subscriptionRepository.js');
  return (await findSubscriptionByStore(db,storeId))!;
}
it('concurrent distinct events wait on the canonical binding lock and book one invoice', async () => {
  const { merchantSubscriptions } = await import('../../db/schema/merchantPlans.js');
  const { recordSubscriptionInvoicePaid } = await import('../../services/billing/subscription.service.js');
  const subscription = await currentSubscription(), ownInvoice = `in_concurrent${nonce}`;
  let release!: () => void, locked!: () => void, lockPid = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const holder = db.transaction(async tx => {
    await tx.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.id,subscription.id)).for('update');
    const pid = await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);lockPid=pid[0]!.pid;
    locked();await barrier;
  });
  await acquired;
  const writers = ['a','b'].map(label => recordSubscriptionInvoicePaid({ subscriptionId:subscription.id,
    expectedSubscription:subscription,providerEventId:`evt_concurrent_${label}${nonce}`,providerInvoiceId:ownInvoice,
    settlement:{netMinor:97,feeMinor:3,currency:'USD'},note:'owned concurrent fixture' }));
  let blocked = 0;
  try {
    const deadline=Date.now()+5000;
    do {
      const observed = await db.execute<{blocked:number}>(sql`select count(*)::int as blocked from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and pid <> ${lockPid} and cardinality(pg_blocking_pids(pid)) > 0
        and query ilike '%select%merchant_subscriptions%for update%'`);
      blocked=observed[0]!.blocked;
      if(blocked===2)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    } while(Date.now()<deadline);
  } finally { release();await holder; }
  const results = await Promise.all(writers);
  console.log(JSON.stringify({kind:'owned-invoice-concurrency-barrier',blockedCanonicalSelects:blocked}));
  expect(blocked).toBe(2);expect(results.filter(result=>result.booked)).toHaveLength(1);
  const claims=await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,ownInvoice));
  expect(claims).toHaveLength(1);expect(claims[0]!.ledgerTransactionId).toBeTruthy();
});
it('different invoices remain bookable and duplicate event IDs roll back the second posting', async () => {
  const { recordSubscriptionInvoicePaid } = await import('../../services/billing/subscription.service.js');
  const subscription=await currentSubscription();
  const input={subscriptionId:subscription.id,expectedSubscription:subscription,providerEventId:`evt_independent${nonce}`,
    providerInvoiceId:`in_independent${nonce}`,settlement:{netMinor:97,feeMinor:3,currency:'USD' as const},note:'owned independent invoice'};
  expect(await recordSubscriptionInvoicePaid(input)).toEqual({booked:true});
  expect(await recordSubscriptionInvoicePaid({...input,providerInvoiceId:`in_eventduplicate${nonce}`})).toEqual({booked:false});
  expect(await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,`in_eventduplicate${nonce}`))).toHaveLength(0);
});
it('a zero-settlement invoice retains its claim and cannot later book a changed observation', async () => {
  const { recordSubscriptionInvoicePaid } = await import('../../services/billing/subscription.service.js');
  const subscription=await currentSubscription(), ownInvoice=`in_zero${nonce}`;
  const input={subscriptionId:subscription.id,expectedSubscription:subscription,providerEventId:`evt_zero${nonce}`,providerInvoiceId:ownInvoice,note:'owned zero invoice'};
  expect(await recordSubscriptionInvoicePaid(input)).toEqual({booked:false});
  expect(await recordSubscriptionInvoicePaid({...input,providerEventId:`evt_zero_other${nonce}`,settlement:{netMinor:97,feeMinor:3,currency:'USD'}})).toEqual({booked:false});
  const claims=await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,ownInvoice));
  expect(claims).toHaveLength(1);expect(claims[0]!.ledgerTransactionId).toBeNull();
});
it('a changed subscription namespace refuses settlement before any new claim', async () => {
  const { recordSubscriptionInvoicePaid } = await import('../../services/billing/subscription.service.js');
  const subscription=await currentSubscription(), ownInvoice=`in_changed${nonce}`;
  await expect(recordSubscriptionInvoicePaid({subscriptionId:subscription.id,
    expectedSubscription:{...subscription,providerSubscriptionId:`sub_previous${nonce}`},providerEventId:`evt_changed${nonce}`,
    providerInvoiceId:ownInvoice,settlement:{netMinor:97,feeMinor:3,currency:'USD'},note:'owned stale binding'}))
    .rejects.toThrow('Subscription billing binding changed');
  expect(await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,ownInvoice))).toHaveLength(0);
});


it('outsider availability and every action deny before acceptance, customer or remote effects', async () => {
  const { buildMerchantPlanStatus } = await import('../../services/entitlements/projection.js');
  const { startMerchantPlanCheckout, openMerchantBillingPortal, scheduleMerchantSubscriptionCancellation } = await import('../../services/billing/subscription.service.js');
  const { merchantPlanAcceptances, billingCustomers } = await import('../../db/schema/merchantPlans.js');
  const beforeAcceptances = await db.select().from(merchantPlanAcceptances).where(eq(merchantPlanAcceptances.storeId, outsiderStoreId));
  const beforeCustomers = await db.select().from(billingCustomers).where(eq(billingCustomers.storeId, outsiderStoreId));
  const beforeGateway = gatewayCalls.length, beforeStripe = transport.paths.length;
  const view = await buildMerchantPlanStatus({storeId: outsiderStoreId});
  expect(view.billingAvailable).toBe(false);expect(view.portalAvailable).toBe(false);
  await expect(startMerchantPlanCheckout({storeId:outsiderStoreId,storeName:'Owned outsider',planId,interval:'monthly',currency:'USD',actorOxyUserId:`payer-${nonce}`,idempotencyKey:`outside-checkout-${nonce}`})).rejects.toThrow('Paid plans are not available');
  await expect(openMerchantBillingPortal({storeId:outsiderStoreId,idempotencyKey:`outside-portal-${nonce}`})).rejects.toThrow('Paid plans are not available');
  await expect(scheduleMerchantSubscriptionCancellation({storeId:outsiderStoreId,actorOxyUserId:`payer-${nonce}`,idempotencyKey:`outside-cancel-${nonce}`})).rejects.toThrow('Paid plans are not available');
  expect(await db.select().from(merchantPlanAcceptances).where(eq(merchantPlanAcceptances.storeId,outsiderStoreId))).toEqual(beforeAcceptances);
  expect(await db.select().from(billingCustomers).where(eq(billingCustomers.storeId,outsiderStoreId))).toEqual(beforeCustomers);
  expect(gatewayCalls).toHaveLength(beforeGateway);expect(transport.paths).toHaveLength(beforeStripe);
});

it('real starter retries a durable invoice automatically while foreign claims and replay remain untouched', async () => {
  const { recordProviderEvent } = await import('../../db/payments/paymentRepository.js');
  const { replayProviderEvent } = await import('../../services/payments/stripe/event-processor.js');
  const { startStripeEventDispatcher, stopStripeEventDispatcher } = await import('../../services/payments/stripe/event-dispatcher.js');
  const providers = await import('../../services/billing/provider.js');
  const foreign = [];
  for (const [label,type,livemode,providerAccountId,eventCustomer] of [
    ['marketplace','payment_intent.succeeded',false,undefined,customer],
    ['connect','invoice.paid',false,'acct_foreign',customer],
    ['mode','invoice.paid',true,undefined,customer],
    ['outsider','invoice.paid',false,undefined,'cus_outsider'],
    ['external','invoice.paid',false,undefined,'cus_external'],
  ] as const) {
    const {row} = await recordProviderEvent(db,{provider:'stripe',providerEventId:`evt_poll_${label}${nonce}`,type,livemode,
      ...(providerAccountId ? {providerAccountId} : {}), objectIds:{invoice:retryInvoice,customer:eventCustomer},payloadSummary:{},expiresAt:new Date(Date.now()+86400000)});
    // Cover both due received rows and expired processing leases, older than the authorized invoice.
    if(label==='connect') await db.update(events).set({status:'processing',attempts:1,leaseOwner:'owned-expired',leaseUntil:new Date(Date.now()-1000)}).where(eq(events.id,row.id));
    if(label==='mode') await db.update(events).set({status:'failed',lastError:'owned historical failure',nextAttemptAt:new Date(Date.now()-1000)}).where(eq(events.id,row.id));
    foreign.push((await db.select().from(events).where(eq(events.id,row.id)))[0]!);
  }
  const expired = await recordProviderEvent(db,{provider:'stripe',providerEventId:`evt_expired_lease${nonce}`,type:'invoice.paid',livemode:false,
    objectIds:{invoice:expiredLeaseInvoice,customer},payloadSummary:{},expiresAt:new Date(Date.now()+86400000)});
  await db.update(events).set({status:'processing',attempts:1,leaseOwner:'owned-crashed-task',leaseUntil:new Date(Date.now()-1000)}).where(eq(events.id,expired.row.id));
  balanceAvailable=false;
  const eventId=`evt_poll_authorized${nonce}`;
  try { expect((await post(eventId,'invoice.paid',{id:retryInvoice,object:'invoice',customer})).status).toBe(200); }
  finally { balanceAvailable=true; }
  expect((await stored(eventId))[0]!.status).toBe('failed');
  expect(await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,retryInvoice))).toHaveLength(0);
  const registered = providers.getBillingProvider('stripe')!;
  providers.resetBillingProviders();
  startStripeEventDispatcher(); // Same bootstrap order: starter precedes asynchronous namespace registration.
  try {
    platformAccountOverride='acct_wrong';
    try { await expect((await import('../../services/billing/register.js')).registerMerchantBillingProvider()).rejects.toThrow('platform account or mode differs'); }
    finally { platformAccountOverride=undefined; }
    expect(providers.getBillingProvider('stripe')).toBeUndefined();
    await new Promise(resolve=>setTimeout(resolve,100));
    expect((await stored(eventId))[0]!.attempts).toBe(1);
    expect((await db.select().from(events).where(eq(events.id,expired.row.id)))[0]!.leaseOwner).toBe('owned-crashed-task');
    await (await import('../../services/billing/register.js')).registerMerchantBillingProvider();
    const deadline=Date.now()+4000;
    let recovered=false;
    do {
      if((await stored(eventId))[0]!.status==='processed') { recovered=true;break; }
      await new Promise(resolve=>setTimeout(resolve,25));
    } while(Date.now()<deadline);
    expect(recovered).toBe(true);
    expect((await stored(eventId))[0]!.attempts).toBe(2);
    const claims=await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,retryInvoice));
    expect(claims).toHaveLength(1);expect(claims[0]!.ledgerTransactionId).toBeTruthy();
    expect((await db.select().from(events).where(eq(events.id,expired.row.id)))[0]).toMatchObject({status:'processed',attempts:2,leaseOwner:null});
    const expiredClaims=await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.providerInvoiceId,expiredLeaseInvoice));
    expect(expiredClaims).toHaveLength(1);expect(expiredClaims[0]!.ledgerTransactionId).toBeTruthy();
    console.log(JSON.stringify({kind:'owned-cohort-automatic-recovery',actions,newInvoiceClaims:claims.length,expiredLeaseClaims:expiredClaims.length,foreignRows:foreign.length,attempts:(await stored(eventId))[0]!.attempts}));
    for(const original of foreign) {
      expect(await replayProviderEvent(original.id)).toBe(false);
      expect((await db.select().from(events).where(eq(events.id,original.id)))[0]).toEqual(original);
    }
  } finally { stopStripeEventDispatcher();providers.registerBillingProvider(registered); }
},10000);
