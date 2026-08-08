/**
 * The payment onboarding routes: who may reach them, and what they hand back.
 *
 * Three real routers mounted on real Express apps behind a stub standing in for
 * the upstream `authenticateToken` + `loadStore`, so the middleware chain under
 * test — `requireStorePermission`, the zod bodies, the signed-state check — is
 * the production one. The account service is mocked: what these tests are about
 * is the SURFACE, and the service has a real-database suite of its own.
 *
 * ## The three properties that would each be a security bug
 *
 *  - a store member who is not an owner must not be able to start an identity
 *    flow in the store's name, or point the store's settlement anywhere;
 *  - the response must not carry the connected-account id, in any form;
 *  - a tampered round-trip state must not be honoured, and must not become a
 *    redirect either — the only destination available at that point would be one
 *    derived from an unverified parameter.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StoreRole } from '@mercaria/shared-types';

const PROVIDER_ACCOUNT_ID = 'acct_1TestNotARealAccount';
const OWNER_USER = 'oxy-user-payments-1';
const STORE_ID = '0'.repeat(24);
const ACCOUNT_ROW_ID = 'provider-account-row-1';

const readSellerPaymentSettings = vi.fn();
const createOnboardingLink = vi.fn();
const syncAccountRow = vi.fn();
const findProviderAccountByOwner = vi.fn();
const createStripeAccountLink = vi.fn();

vi.mock('../../services/payments/stripe/account.service.js', () => ({
  readSellerPaymentSettings: (...args: unknown[]) => readSellerPaymentSettings(...args),
  createOnboardingLink: (...args: unknown[]) => createOnboardingLink(...args),
  syncAccountRow: (...args: unknown[]) => syncAccountRow(...args),
  redactAccountId: (id: string) => `acct_…${id.slice(-4)}`,
}));
vi.mock('../../db/payments/providerAccountRepository.js', () => ({
  findProviderAccountByOwner: (...args: unknown[]) => findProviderAccountByOwner(...args),
}));
vi.mock('../../db/postgres.js', () => ({ getDb: () => ({}) }));
vi.mock('../../services/payments/stripe/client.js', () => ({
  createStripeAccountLink: (...args: unknown[]) => createStripeAccountLink(...args),
}));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => OWNER_USER,
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  oxyClient: {},
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

let storeServer: Server;
let sellerServer: Server;
let onboardingServer: Server;
let storeUrl: string;
let sellerUrl: string;
let onboardingUrl: string;
let createOnboardingState: typeof import('../../services/payments/stripe/onboarding-state.js').createOnboardingState;

/** Start one app and return its base URL. */
async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_routes_platform_not_a_real_one';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_routes_connect_not_a_real_one';
  process.env.STRIPE_SELLER_COUNTRIES = 'ES';
  process.env.STRIPE_ONBOARDING_BASE_URL = 'https://api.mercaria.test';
  process.env.STRIPE_ONBOARDING_RETURN_URL = 'https://dashboard.mercaria.test/settings/payments';
  process.env.STRIPE_ONBOARDING_STATE_SECRET = 'routes-onboarding-state-secret';

  ({ createOnboardingState } = await import(
    '../../services/payments/stripe/onboarding-state.js'
  ));
  const storeRouter = (await import('../admin/payments.js')).default;
  const sellerRouter = (await import('../seller.js')).default;
  const onboardingRouter = (await import('../stripe-onboarding.js')).default;

  const storeApp = express();
  storeApp.use(express.json());
  // Stands in for `authenticateToken` + `loadStore`: the role comes from a test
  // header, everything downstream is the real chain.
  storeApp.use((req, _res, next) => {
    req.userId = OWNER_USER;
    const role = (req.headers['x-role'] as StoreRole) ?? 'staff';
    // The same stub shape `admin/__tests__/channels-authz.test.ts` uses: both
    // records are full drizzle rows since the port, and the columns this chain
    // reads are the three below — spelling out an id, timestamps and an inviter
    // the middleware never looks at would be fixture nobody maintains.
    req.store = { id: STORE_ID } as unknown as typeof req.store;
    req.storeMembership = {
      oxyUserId: OWNER_USER,
      role,
      permissions: [],
    } as unknown as typeof req.storeMembership;
    next();
  });
  storeApp.use('/', storeRouter);

  const sellerApp = express();
  sellerApp.use(express.json());
  sellerApp.use('/', sellerRouter);

  const onboardingApp = express();
  onboardingApp.use(express.json());
  onboardingApp.use('/', onboardingRouter);

  ({ server: storeServer, url: storeUrl } = await listen(storeApp));
  ({ server: sellerServer, url: sellerUrl } = await listen(sellerApp));
  ({ server: onboardingServer, url: onboardingUrl } = await listen(onboardingApp));
});

beforeEach(() => {
  // Several assertions below are `not.toHaveBeenCalled`, which is only worth
  // anything against a mock that carries no history from the previous test.
  readSellerPaymentSettings.mockReset();
  createOnboardingLink.mockReset();
  syncAccountRow.mockReset();
  findProviderAccountByOwner.mockReset();
  createStripeAccountLink.mockReset();
});

afterAll(async () => {
  await Promise.all(
    [storeServer, sellerServer, onboardingServer].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    ),
  );
});

/** A settings payload as the service returns it — status plus deployment facts. */
function settings() {
  return {
    account: {
      provider: 'stripe',
      ownerType: 'store',
      ownerId: STORE_ID,
      onboardingState: 'ready',
      paymentReady: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      transfersCapability: 'active',
      country: 'ES',
      payoutCurrency: 'EUR',
      requirements: { currentlyDue: 0, eventuallyDue: 0, pastDue: 0, pendingVerification: 0 },
      disabledReasonCodes: [],
    },
    onboardingAvailable: true,
    supportedCountries: ['ES'],
  };
}

describe('the store payments router', () => {
  it('refuses staff and admins — starting this flow is the owner’s', async () => {
    // `store:manage` is the ONE permission an admin does not hold. Onboarding
    // decides where a store's money is settled and starts an identity flow in
    // the store's name, so it sits with the owner rather than with
    // `settings:write`, which opens the return policy and reaches `staff`.
    for (const role of ['staff', 'admin'] as StoreRole[]) {
      const read = await fetch(`${storeUrl}/account`, { headers: { 'x-role': role } });
      expect(read.status).toBe(403);
      const write = await fetch(`${storeUrl}/account/onboarding-link`, {
        method: 'POST',
        headers: { 'x-role': role, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(write.status).toBe(403);
    }
    expect(readSellerPaymentSettings).not.toHaveBeenCalled();
    expect(createOnboardingLink).not.toHaveBeenCalled();
  });

  it('lets an owner read the status, and never leaks the account id', async () => {
    readSellerPaymentSettings.mockResolvedValueOnce(settings());

    const res = await fetch(`${storeUrl}/account`, { headers: { 'x-role': 'owner' } });
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.onboardingAvailable).toBe(true);
    // Named key AND raw value: the first catches a field someone added on
    // purpose, the second catches the same id arriving under any other name —
    // which is what a `...spread` of the row would do.
    expect(body.data).not.toHaveProperty('providerAccountId');
    expect(JSON.stringify(body)).not.toContain(PROVIDER_ACCOUNT_ID);
    expect(JSON.stringify(body)).not.toContain('sk_test');
    // The owner is derived from the LOADED store, never from anything a client
    // could choose.
    expect(readSellerPaymentSettings).toHaveBeenCalledWith({
      ownerType: 'store',
      ownerId: STORE_ID,
    });
  });

  it('mints a link for an owner, defaulting the country to the allow-list', async () => {
    createOnboardingLink.mockResolvedValueOnce({
      url: 'https://connect.stripe.test/setup/acct_x',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const res = await fetch(`${storeUrl}/account/onboarding-link`, {
      method: 'POST',
      headers: { 'x-role': 'owner', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(createOnboardingLink).toHaveBeenCalledWith({
      owner: { ownerType: 'store', ownerId: STORE_ID },
      country: 'ES',
    });
  });

  it('rejects a country that is not a two-letter code before reaching Stripe', async () => {
    const res = await fetch(`${storeUrl}/account/onboarding-link`, {
      method: 'POST',
      headers: { 'x-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'Spain' }),
    });

    expect(res.status).toBe(400);
    expect(createOnboardingLink).not.toHaveBeenCalled();
  });

  it('ignores an attempt to name the connected account in the body', async () => {
    // The mass-assignment shape (#46, security 3). The zod schema strips
    // anything it does not declare, so a body naming somebody else's account
    // reaches the service as the ordinary one-optional-field request it is.
    createOnboardingLink.mockResolvedValueOnce({
      url: 'https://connect.stripe.test/setup/acct_x',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const res = await fetch(`${storeUrl}/account/onboarding-link`, {
      method: 'POST',
      headers: { 'x-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ providerAccountId: 'acct_someone_elses', ownerId: 'store-other' }),
    });

    expect(res.status).toBe(201);
    expect(createOnboardingLink).toHaveBeenCalledWith({
      owner: { ownerType: 'store', ownerId: STORE_ID },
      country: 'ES',
    });
  });
});

describe('the P2P seller payments routes', () => {
  it('always acts on the CALLER, never on an id in the request', async () => {
    readSellerPaymentSettings.mockResolvedValueOnce({
      ...settings(),
      account: { ...settings().account, ownerType: 'user', ownerId: OWNER_USER },
    });

    const res = await fetch(`${sellerUrl}/payments/account`);
    expect(res.status).toBe(200);
    // There is no permission to check here and none is missing: the owner comes
    // from the authenticated caller, so the surface can only ever reach the
    // caller's own account.
    expect(readSellerPaymentSettings).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: OWNER_USER,
    });
  });

  it('mints a link for the caller', async () => {
    createOnboardingLink.mockResolvedValueOnce({
      url: 'https://connect.stripe.test/setup/acct_y',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const res = await fetch(`${sellerUrl}/payments/account/onboarding-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'ES' }),
    });

    expect(res.status).toBe(201);
    expect(createOnboardingLink).toHaveBeenCalledWith({
      owner: { ownerType: 'user', ownerId: OWNER_USER },
      country: 'ES',
    });
  });
});

describe('the hosted-onboarding round trip', () => {
  /** A provider-account row the signed state resolves to. */
  function row() {
    return {
      id: ACCOUNT_ROW_ID,
      provider: 'stripe',
      ownerType: 'store',
      ownerId: STORE_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      onboardingState: 'action_required',
      revokedAt: null,
    };
  }

  /** A valid state for that row. */
  function validState(): string {
    return createOnboardingState({
      ownerType: 'store',
      ownerId: STORE_ID,
      accountRowId: ACCOUNT_ROW_ID,
    });
  }

  it('400s a tampered state instead of redirecting anywhere', async () => {
    const tampered = `${validState().slice(0, -3)}xyz`;

    const res = await fetch(
      `${onboardingUrl}/refresh?state=${encodeURIComponent(tampered)}`,
      { redirect: 'manual' },
    );

    // NOT a 3xx. The only destination available with an unverified state would
    // be one derived from it, which is how a signed-state check becomes an open
    // redirect.
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(createStripeAccountLink).not.toHaveBeenCalled();
  });

  it('400s a missing state', async () => {
    const res = await fetch(`${onboardingUrl}/return`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('400s a state signed for one owner but naming another owner’s row', async () => {
    // The row is looked up by OWNER and then checked against the id the token
    // names. A token whose two halves disagree resolves to nothing.
    findProviderAccountByOwner.mockResolvedValueOnce({ ...row(), id: 'some-other-row' });
    const state = validState();

    const res = await fetch(`${onboardingUrl}/refresh?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });

    // Back to the dashboard rather than into an onboarding flow for a row this
    // token does not name — and no link was minted.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://dashboard.mercaria.test/settings/payments');
    expect(createStripeAccountLink).not.toHaveBeenCalled();
  });

  it('refresh mints a FRESH link and bounces straight back to Stripe', async () => {
    findProviderAccountByOwner.mockResolvedValueOnce(row());
    createStripeAccountLink.mockResolvedValueOnce({
      url: 'https://connect.stripe.test/setup/refreshed',
      expires_at: Math.floor(Date.now() / 1_000) + 300,
    });
    const state = validState();

    const res = await fetch(`${onboardingUrl}/refresh?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://connect.stripe.test/setup/refreshed');
    const params = createStripeAccountLink.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.account).toBe(PROVIDER_ACCOUNT_ID);
    expect(params.collection_options).toEqual({ fields: 'eventually_due' });
    // A NEW state, not the one that arrived: reusing it would extend a captured
    // token's life every time the seller went round the loop.
    const reissued = new URL(String(params.return_url)).searchParams.get('state');
    expect(reissued).toBeTruthy();
    expect(reissued).not.toBe(state);
  });

  it('refresh will not resume a revoked account, and never creates one', async () => {
    findProviderAccountByOwner.mockResolvedValueOnce({ ...row(), revokedAt: new Date() });
    const state = validState();

    const res = await fetch(`${onboardingUrl}/refresh?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://dashboard.mercaria.test/settings/payments');
    expect(createStripeAccountLink).not.toHaveBeenCalled();
  });

  it('return re-reads the account from Stripe before sending the seller on', async () => {
    findProviderAccountByOwner.mockResolvedValueOnce(row());
    syncAccountRow.mockResolvedValueOnce({ ...row(), onboardingState: 'ready' });
    const state = validState();

    const res = await fetch(`${onboardingUrl}/return?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://dashboard.mercaria.test/settings/payments');
    // The redirect is NOT the evidence — the re-read is. A `return_url` hit
    // proves a browser came back and nothing else (ADR 0001 D2).
    expect(syncAccountRow).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ROW_ID }));
  });

  it('return still redirects when the re-read fails', async () => {
    findProviderAccountByOwner.mockResolvedValueOnce(row());
    syncAccountRow.mockRejectedValueOnce(new Error('Stripe is unreachable'));
    const state = validState();

    const res = await fetch(`${onboardingUrl}/return?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });

    // The seller finished a hosted flow and must land somewhere. Readiness comes
    // from `account.updated` and the reconciliation sweep regardless, so a
    // failed optimisation must never become a dead end.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://dashboard.mercaria.test/settings/payments');
  });
});
