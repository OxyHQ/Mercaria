/**
 * The connector OAuth callback links its connection onto the wizard session the
 * signed `state` names — against a REAL Postgres database and the REAL route.
 *
 * ## The failure this file exists for
 *
 * A Shopify connect LEAVES the dashboard. The merchant authorizes on Shopify,
 * Shopify answers `/channels/oauth/shopify/callback`, and that callback — running
 * with no Oxy session, in no tab the merchant is looking at — creates the
 * connection. Before this, nothing then wrote it back onto the onboarding session
 * the merchant had started from, so `channel_onboarding_sessions.connection_id`
 * stayed NULL forever: `deriveActivationBlockers` reported
 * `connection_not_connected` against a connection whose status was `connected`,
 * the wizard re-rendered its connect step on every reload, and the merchant's own
 * account of it was "nothing reacted". The API-key path (WooCommerce
 * `connect-key`) never had the bug — it answers into the tab that asked, so the
 * client patches the session itself — which is exactly why the OAuth half went
 * unnoticed.
 *
 * ## What is real here, and what is faked
 *
 * Only the SOCKET. `connectAndVerify` is the shipped one, so `upsertConnection`
 * writes a real row through the real encryption and the session's real
 * `ON DELETE restrict` foreign key onto it is exercised; the `state` is minted by
 * the shipped `createOAuthState` under a real secret and Shopify's `hmac` is
 * computed the way `verifyShopifyOAuthCallback` computes it, so both authenticity
 * checks genuinely run. `getConnectorProvider` is the ONE thing mocked (#69's
 * boundary and its reason: connectors are a static registry, and adding a mutable
 * register-a-provider seam for a test's convenience would put it in production).
 *
 * A mocked drizzle call could express none of this: the link is a CAS on
 * `state = 'in_progress'`, the column carries a foreign key, and "the callback
 * did not fail" is only meaningful against a server that could have refused.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const SHOPIFY_SECRET = 'shopify-app-secret-not-a-real-one';
const STATE_SECRET = 's'.repeat(64);

/**
 * The platform, faked at the socket. `exchangeCode` is what the real
 * `connectAndVerify` calls between its two database writes; `registerWebhooks`
 * answers the `reconciled` branch with nothing live, which is the shape a
 * registration that read the platform's list and created nothing returns.
 */
vi.mock('../../connectors/registry.js', () => ({
  isImplementedProvider: (value: string) => value === 'shopify',
  getConnectorProvider: () => ({
    credentialStrategy: 'oauth',
    webhookSecretStrategy: 'app_secret',
    capabilities: {},
    exchangeCode: ({ shopDomain }: { shopDomain: string }) =>
      Promise.resolve({
        accessToken: 'shpat_test_token',
        externalShopId: `gid://shopify/Shop/${shopDomain}`,
        shopDomain,
        shopCurrency: 'USD',
        scopes: ['read_products'],
      }),
    registerWebhooks: () =>
      Promise.resolve({ outcome: 'reconciled', subscriptions: [], failures: [] }),
  }),
}));

// Not under test, and the real limiter runs an optional Oxy token resolve —
// which would put this file on the network. `channels-ingest.test.ts`'s
// precedent, for the same reason.
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

let pg: typeof import('../../db/postgres.js');
let db: import('../../db/postgres.js').Database;
let channelOnboardingSessions: typeof import('../../db/schema/channels.js').channelOnboardingSessions;
let createOAuthState: typeof import('../../connectors/oauth-state.js').createOAuthState;
let openChannelOnboardingSession: typeof import('../../db/channels/channelOnboardingRepository.js').openChannelOnboardingSession;
let closeChannelOnboardingSession: typeof import('../../db/channels/channelOnboardingRepository.js').closeChannelOnboardingSession;
let findConnectionByProvider: typeof import('../../db/connectors/connectionRepository.js').findConnectionByProvider;
let insertStore: typeof import('../../db/stores/storeRepository.js').insertStore;
let deleteTestStores: typeof import('../../db/__tests__/store-teardown.js').deleteTestStores;

const servers: Server[] = [];
let baseUrl: string;

/** Stores created by a test, dropped after it — the database is shared. */
const createdStoreIds: string[] = [];

beforeAll(async () => {
  process.env.CONNECTOR_OAUTH_STATE_SECRET = STATE_SECRET;
  process.env.CONNECTOR_OAUTH_REDIRECT_BASE_URL = 'https://api.mercaria.test';
  process.env.CONNECTOR_ENCRYPTION_KEY = 'e'.repeat(64);
  process.env.SHOPIFY_CLIENT_ID = 'shopify-client-id';
  process.env.SHOPIFY_CLIENT_SECRET = SHOPIFY_SECRET;
  // Unset, so the callback answers its plain success TEXT rather than a 302.
  // The redirect target is a separate decision and is not what this file is for;
  // asserting on the body keeps the cases readable.
  delete process.env.CONNECTOR_OAUTH_SUCCESS_REDIRECT_URL;

  pg = await import('../../db/postgres.js');
  ({ channelOnboardingSessions } = await import('../../db/schema/channels.js'));
  ({ createOAuthState } = await import('../../connectors/oauth-state.js'));
  ({ openChannelOnboardingSession, closeChannelOnboardingSession } = await import(
    '../../db/channels/channelOnboardingRepository.js'
  ));
  ({ findConnectionByProvider } = await import('../../db/connectors/connectionRepository.js'));
  ({ insertStore } = await import('../../db/stores/storeRepository.js'));
  ({ deleteTestStores } = await import('../../db/__tests__/store-teardown.js'));

  db = await pg.connectPostgres();

  const router = (await import('../channels-oauth.js')).default;
  const app = express();
  app.use('/channels/oauth', router);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // Sessions and connections both CASCADE from `stores`, and the session's
    // `ON DELETE restrict` onto a connection settles per STATEMENT — both ends
    // go in the one cascade, so this is enough.
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pg.closePostgres();
});

/** A store with an owner, registered for teardown. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid: v7 is time-ordered, so a truncated suffix collides with
  // `stores_handle_key` for two stores minted in the same millisecond.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `oauth-wizard-${suffix}`,
      name: 'OAuth wizard store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/**
 * Drive the REAL callback the way Shopify does, signing the query the way
 * `verifyShopifyOAuthCallback` verifies it.
 *
 * The signature is reconstructed from that function's own rule (every parameter
 * but `hmac`/`signature`, sorted, `k=v` joined with `&`) rather than hardcoded,
 * so a change to the scheme moves this with it instead of leaving a test for a
 * scheme nobody uses.
 */
async function callback(params: Record<string, string>): Promise<{
  status: number;
  body: string;
}> {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  const hmac = createHmac('sha256', SHOPIFY_SECRET).update(message).digest('hex');
  const query = new URLSearchParams({ ...params, hmac }).toString();
  const res = await fetch(`${baseUrl}/channels/oauth/shopify/callback?${query}`, {
    redirect: 'manual',
  });
  return { status: res.status, body: await res.text() };
}

/** The onboarding session row, read straight from the table. */
async function readSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(channelOnboardingSessions)
    .where(eq(channelOnboardingSessions.id, sessionId))
    .limit(1);
  return row;
}

describe('the OAuth callback and the wizard session', () => {
  it('links the connection it creates onto the session the signed state names', async () => {
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    // The state of the merchant who has just been sent to Shopify: a live
    // session, on the connect step, with no connection.
    expect(session.connectionId).toBeNull();

    const shopDomain = `wizard-${uuidv7()}.myshopify.com`;
    const state = createOAuthState({
      storeId,
      provider: 'shopify',
      userId: 'user-1',
      shopDomain,
      onboardingSessionId: session.id,
    });

    const res = await callback({ code: 'auth-code', state, shop: shopDomain });
    expect(res.status).toBe(200);

    const connection = await findConnectionByProvider(storeId, 'shopify');
    expect(connection?.status).toBe('connected');

    // THE assertion. Before this change it read `null`, and the wizard stayed on
    // its connect step for the rest of the session's life.
    const linked = await readSession(session.id);
    expect(linked.connectionId).toBe(connection?.id);
    // And it is past the credential step, which is what stops the screen
    // re-offering "Continue to Shopify" to somebody who already authorized.
    expect(linked.step).toBe('configure');
    expect(linked.state).toBe('in_progress');
  });

  it('clears `connection_not_connected` — the blocker the merchant was stuck behind', async () => {
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    const { deriveActivationBlockers } = await import(
      '../../services/channels/channel-onboarding.service.js'
    );

    expect(await deriveActivationBlockers(session)).toContain('connection_not_connected');

    const shopDomain = `blocker-${uuidv7()}.myshopify.com`;
    await callback({
      code: 'auth-code',
      shop: shopDomain,
      state: createOAuthState({
        storeId,
        provider: 'shopify',
        userId: 'user-1',
        shopDomain,
        onboardingSessionId: session.id,
      }),
    });

    // Re-derived against the LIVE connection, which is the point of deriving it:
    // the blocker goes with no sweep and no second write.
    const after = await readSession(session.id);
    expect(await deriveActivationBlockers(after)).not.toContain('connection_not_connected');
  });

  it('completes the connect when the state names NO session', async () => {
    // A state minted by the previous image and still in flight through the
    // platform during a rollout, or a connect started outside the wizard. Both
    // must still land — the merchant has already authorized and the code is
    // single-use, so a refusal here is unrecoverable.
    const storeId = await makeStore();
    const shopDomain = `plain-${uuidv7()}.myshopify.com`;

    const res = await callback({
      code: 'auth-code',
      shop: shopDomain,
      state: createOAuthState({ storeId, provider: 'shopify', userId: 'user-1', shopDomain }),
    });

    expect(res.status).toBe(200);
    expect((await findConnectionByProvider(storeId, 'shopify'))?.status).toBe('connected');
  });

  it('will not touch ANOTHER store’s session, and still completes the connect', async () => {
    const storeId = await makeStore();
    const otherStoreId = await makeStore();
    const victim = await openChannelOnboardingSession({
      storeId: otherStoreId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-2',
    });

    // Minted directly rather than through `buildConnectAuthorizeUrl`, which is
    // the point: this models a claim that reached the callback WITHOUT the
    // mint-time check — a stale state, or a forged one. The store scope on the
    // patch is the boundary, and it holds on its own.
    const shopDomain = `cross-${uuidv7()}.myshopify.com`;
    const res = await callback({
      code: 'auth-code',
      shop: shopDomain,
      state: createOAuthState({
        storeId,
        provider: 'shopify',
        userId: 'user-1',
        shopDomain,
        onboardingSessionId: victim.id,
      }),
    });

    expect(res.status).toBe(200);
    expect((await readSession(victim.id)).connectionId).toBeNull();
    expect((await findConnectionByProvider(storeId, 'shopify'))?.status).toBe('connected');
  });

  it('will not reopen a session the merchant already abandoned', async () => {
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    await closeChannelOnboardingSession(storeId, session.id, 'abandoned', new Date());

    const shopDomain = `abandoned-${uuidv7()}.myshopify.com`;
    const res = await callback({
      code: 'auth-code',
      shop: shopDomain,
      state: createOAuthState({
        storeId,
        provider: 'shopify',
        userId: 'user-1',
        shopDomain,
        onboardingSessionId: session.id,
      }),
    });

    // The connect SUCCEEDS — the merchant authorized it and the code is spent —
    // and the finished session is left exactly as it was. The patch's CAS on
    // `in_progress` is what decides, not the read beside it.
    expect(res.status).toBe(200);
    const after = await readSession(session.id);
    expect(after.state).toBe('abandoned');
    expect(after.connectionId).toBeNull();
    expect((await findConnectionByProvider(storeId, 'shopify'))?.status).toBe('connected');
  });

  it('still answers 400 to a tampered state, and creates nothing', async () => {
    // The property the session id had to ride INSIDE the signature to preserve:
    // a caller cannot reach the connect path — or a redirect — by editing what it
    // sent. Named here because the new claim is the one somebody would be
    // tempted to read before verifying.
    const storeId = await makeStore();
    const shopDomain = `tampered-${uuidv7()}.myshopify.com`;
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const token = createOAuthState({
      storeId,
      provider: 'shopify',
      userId: 'user-1',
      shopDomain,
      onboardingSessionId: session.id,
    });
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        storeId,
        provider: 'shopify',
        userId: 'user-1',
        shopDomain,
        onboardingSessionId: session.id,
        nonce: 'forged',
        exp: Date.now() + 60_000,
      }),
      'utf8',
    ).toString('base64url');

    const res = await callback({ code: 'auth-code', shop: shopDomain, state: `${forged}.${sig}` });

    expect(res.status).toBe(400);
    expect(await findConnectionByProvider(storeId, 'shopify')).toBeNull();
    expect((await readSession(session.id)).connectionId).toBeNull();

    // The positive control, and this case needs one more than most: every
    // assertion above is a REFUSAL, and a request the route rejected for some
    // unrelated reason — a shop mismatch, a missing parameter, a fixture that
    // never reached the handler — produces all three just as happily. Replaying
    // the SAME payload under its own signature must connect AND link, which is
    // what pins the 400 to the signature check.
    const honest = await callback({
      code: 'auth-code',
      shop: shopDomain,
      state: `${payload}.${sig}`,
    });
    expect(honest.status).toBe(200);
    expect((await readSession(session.id)).connectionId).not.toBeNull();
  });
});

describe('minting the state', () => {
  it('refuses a session that is not this store’s, before the merchant leaves', async () => {
    const storeId = await makeStore();
    const otherStoreId = await makeStore();
    const foreign = await openChannelOnboardingSession({
      storeId: otherStoreId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-2',
    });
    const { buildConnectAuthorizeUrl } = await import('../../services/connector-sync.service.js');

    // Refused in the request the merchant is watching rather than silently at
    // the callback, where the only symptom is the stall this whole change
    // removes. The callback's own store scope still refuses it independently —
    // see the cross-store case above.
    await expect(
      buildConnectAuthorizeUrl({
        storeId,
        providerId: 'shopify',
        userId: 'user-1',
        shopDomain: 'acme.myshopify.com',
        onboardingSessionId: foreign.id,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a session for a DIFFERENT channel', async () => {
    const storeId = await makeStore();
    const wooSession = await openChannelOnboardingSession({
      storeId,
      channelType: 'woocommerce',
      startedByOxyUserId: 'user-1',
    });
    const { buildConnectAuthorizeUrl } = await import('../../services/connector-sync.service.js');

    await expect(
      buildConnectAuthorizeUrl({
        storeId,
        providerId: 'shopify',
        userId: 'user-1',
        shopDomain: 'acme.myshopify.com',
        onboardingSessionId: wooSession.id,
      }),
    ).rejects.toThrow(/different channel/i);
  });
});
