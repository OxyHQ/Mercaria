/**
 * The seller payment onboarding routes: who may reach them, and what they hand
 * back.
 *
 * Two real routers on real Express apps behind a stub standing in for the
 * upstream `authenticateToken` + `loadStore`, so the chain under test —
 * `requireStorePermission` and the zod body — is the production one. The
 * Peable account adapter is mocked: these tests are about the SURFACE, and the
 * adapter has a real-database suite of its own
 * (`services/payments/peable/__tests__/seller-onboarding.realdb.test.ts`).
 *
 * ## The properties that would each be a security bug
 *
 *  - a store member who is not an owner must not be able to start an identity
 *    flow in the store's name, or point the store's settlement anywhere;
 *  - the owner is the ROUTE's (the loaded store, the authenticated caller),
 *    never anything in the request;
 *  - the response must not carry the gateway's account id, in any form.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { STORE_ROLE_PERMISSIONS, type StoreAccountRole } from '@mercaria/shared-types';

const PROVIDER_ACCOUNT_ID = 'ca_TestNotARealAccount';
const OWNER_USER = 'oxy-user-payments-1';
const STORE_ID = '0'.repeat(24);

const readSellerPaymentSettings = vi.fn();
const createSellerOnboardingLink = vi.fn();
const refreshSellerAccount = vi.fn();

vi.mock('../../services/payments/peable/accounts.js', () => ({
  readSellerPaymentSettings: (...args: unknown[]) => readSellerPaymentSettings(...args),
  createSellerOnboardingLink: (...args: unknown[]) => createSellerOnboardingLink(...args),
  refreshSellerAccount: (...args: unknown[]) => refreshSellerAccount(...args),
}));
vi.mock('../../db/postgres.js', () => ({ getDb: () => ({}) }));
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
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
let storeUrl: string;
let sellerUrl: string;

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  const storeRouter = (await import('../admin/payments.js')).default;
  const sellerRouter = (await import('../seller.js')).default;

  const storeApp = express();
  storeApp.use(express.json());
  // Stands in for `authenticateToken` + `loadStore`: the role comes from a test
  // header, everything downstream is the real chain.
  storeApp.use((req, _res, next) => {
    req.userId = OWNER_USER;
    const role = (req.headers['x-role'] as StoreAccountRole) ?? 'editor';
    req.store = { id: STORE_ID } as unknown as typeof req.store;
    req.storeAccess = { role, permissions: [...STORE_ROLE_PERMISSIONS[role]] };
    next();
  });
  storeApp.use('/', storeRouter);

  const sellerApp = express();
  sellerApp.use(express.json());
  sellerApp.use('/', sellerRouter);

  ({ server: storeServer, url: storeUrl } = await listen(storeApp));
  ({ server: sellerServer, url: sellerUrl } = await listen(sellerApp));
});

beforeEach(() => {
  readSellerPaymentSettings.mockReset();
  createSellerOnboardingLink.mockReset();
  refreshSellerAccount.mockReset();
});

afterAll(async () => {
  await Promise.all(
    [storeServer, sellerServer].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    ),
  );
});

function settings(ownerType: 'store' | 'user', ownerId: string) {
  return {
    account: {
      provider: 'peable',
      ownerType,
      ownerId,
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
  };
}

const LINK = {
  url: 'https://connect.peable.test/onboarding/x',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

async function post(url: string, body: unknown, role?: StoreAccountRole) {
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) },
    body: JSON.stringify(body),
  });
}

describe('the store payments router', () => {
  it('refuses editors and admins — starting this flow is the owner’s', async () => {
    for (const role of ['editor', 'admin'] as StoreAccountRole[]) {
      expect((await fetch(`${storeUrl}/account`, { headers: { 'x-role': role } })).status).toBe(
        403,
      );
      expect((await post(`${storeUrl}/account/onboarding-link`, {}, role)).status).toBe(403);
      expect((await post(`${storeUrl}/account/refresh`, {}, role)).status).toBe(403);
    }
    expect(readSellerPaymentSettings).not.toHaveBeenCalled();
    expect(createSellerOnboardingLink).not.toHaveBeenCalled();
    expect(refreshSellerAccount).not.toHaveBeenCalled();
  });

  it('lets an owner read the status, and never leaks the account id', async () => {
    readSellerPaymentSettings.mockResolvedValueOnce(settings('store', STORE_ID));

    const res = await fetch(`${storeUrl}/account`, { headers: { 'x-role': 'owner' } });
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.onboardingAvailable).toBe(true);
    expect(body.data).not.toHaveProperty('providerAccountId');
    expect(JSON.stringify(body)).not.toContain(PROVIDER_ACCOUNT_ID);
    expect(readSellerPaymentSettings).toHaveBeenCalledWith({
      ownerType: 'store',
      ownerId: STORE_ID,
    });
  });

  it('mints a link for an owner with the country they chose', async () => {
    createSellerOnboardingLink.mockResolvedValueOnce(LINK);

    const res = await post(`${storeUrl}/account/onboarding-link`, { country: 'ES' }, 'owner');

    expect(res.status).toBe(201);
    expect(createSellerOnboardingLink).toHaveBeenCalledWith({
      owner: { ownerType: 'store', ownerId: STORE_ID },
      country: 'ES',
    });
  });

  it('passes no country when none was given — an existing account needs none', async () => {
    createSellerOnboardingLink.mockResolvedValueOnce(LINK);
    const res = await post(`${storeUrl}/account/onboarding-link`, {}, 'owner');
    expect(res.status).toBe(201);
    expect(createSellerOnboardingLink).toHaveBeenCalledWith({
      owner: { ownerType: 'store', ownerId: STORE_ID },
    });
  });

  it('rejects a country that is not a two-letter code before reaching the gateway', async () => {
    const res = await post(`${storeUrl}/account/onboarding-link`, { country: 'Spain' }, 'owner');
    expect(res.status).toBe(400);
    expect(createSellerOnboardingLink).not.toHaveBeenCalled();
  });

  it('refuses a body that tries to name an account or an owner', async () => {
    // The mass-assignment shape (#46, security 3): refused outright, so the
    // attempt is visible instead of silently stripped.
    const res = await post(
      `${storeUrl}/account/onboarding-link`,
      { providerAccountId: 'ca_someone_elses', ownerId: 'store-other' },
      'owner',
    );
    expect(res.status).toBe(400);
    expect(createSellerOnboardingLink).not.toHaveBeenCalled();
  });

  it('refreshes for an owner', async () => {
    refreshSellerAccount.mockResolvedValueOnce(settings('store', STORE_ID));
    const res = await post(`${storeUrl}/account/refresh`, {}, 'owner');
    expect(res.status).toBe(200);
    expect(refreshSellerAccount).toHaveBeenCalledWith({ ownerType: 'store', ownerId: STORE_ID });
  });
});

describe('the P2P seller payments routes', () => {
  it('always act on the CALLER, never on an id in the request', async () => {
    readSellerPaymentSettings.mockResolvedValueOnce(settings('user', OWNER_USER));
    createSellerOnboardingLink.mockResolvedValueOnce(LINK);
    refreshSellerAccount.mockResolvedValueOnce(settings('user', OWNER_USER));

    expect((await fetch(`${sellerUrl}/payments/account`)).status).toBe(200);
    expect(
      (await post(`${sellerUrl}/payments/account/onboarding-link`, { country: 'ES' })).status,
    ).toBe(201);
    expect((await post(`${sellerUrl}/payments/account/refresh`, {})).status).toBe(200);

    const caller = { ownerType: 'user', ownerId: OWNER_USER };
    expect(readSellerPaymentSettings).toHaveBeenCalledWith(caller);
    expect(createSellerOnboardingLink).toHaveBeenCalledWith({ owner: caller, country: 'ES' });
    expect(refreshSellerAccount).toHaveBeenCalledWith(caller);
  });
});
