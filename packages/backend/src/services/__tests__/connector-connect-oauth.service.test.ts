/**
 * Unit tests for `connector-sync.service.connectAndVerify` — the OAuth connect
 * path, used by Shopify (WooCommerce's `exchangeCode` refuses outright).
 *
 * This is the path #302 found unguarded: it wrote `mode: 'pull'` into the upsert
 * with no mode check at all, so a merchant who had connected the WordPress
 * plugin and then authorised the pull connector had their `push_in` row rewritten
 * in place. The id does not move, so nothing looks broken until the plugin's next
 * push 400s on `requirePushInConnection`.
 *
 * What a mock can prove is exactly the half a real database cannot: that the
 * refusal arrives BEFORE `exchangeCode`, which consumes a one-time authorization
 * code and leaves a granted access token on the platform that Mercaria would then
 * store nowhere. What it CANNOT prove is the refusal itself, which is
 * `upsertConnection`'s conditional write — a mocked `insert` has no
 * `onConflictDoUpdate` semantics. That lives in
 * `db/__tests__/connection-mode.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findConnectionByProvider = vi.fn();
const upsertConnection = vi.fn();
const encryptSecret = vi.fn();
const getConnectorProvider = vi.fn();
const exchangeCode = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnectionByProvider: (...args: unknown[]) => findConnectionByProvider(...args),
  upsertConnection: (...args: unknown[]) => upsertConnection(...args),
  recordConnectionWebhookRegistration: vi.fn(),
  findConnectionWebhookFailures: vi.fn().mockResolvedValue(new Map()),
  findConnection: vi.fn(),
  findConnectionById: vi.fn(),
  findConnectionCredentials: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findConnectionsNeedingWebhookRegistration: vi.fn(),
  findPullConnectionsToReconcile: vi.fn(),
  findPushConnections: vi.fn(),
  claimConnectionWebhookRegistration: vi.fn(),
  completeConnectionWebhookRegistration: vi.fn(),
  releaseConnectionWebhookRegistration: vi.fn(),
  disconnectConnection: vi.fn(),
  markConnectionError: vi.fn(),
  markConnectionSynced: vi.fn(),
  touchConnectionLastSync: vi.fn(),
  updateSyncSettings: vi.fn(),
}));
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: vi.fn(),
  finishSyncRun: vi.fn(),
}));
vi.mock('../../lib/connector-crypto.js', () => ({
  encryptSecret: (...args: unknown[]) => encryptSecret(...args),
  decryptSecret: vi.fn(),
}));
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: (...args: unknown[]) => getConnectorProvider(...args),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { connectAndVerify } from '../connector-sync.service.js';

const STORE = '0'.repeat(24);
const SHOP = 'shop.myshopify.com';
const PARAMS = { code: 'auth-code', shopDomain: SHOP, redirectUri: 'https://mercaria.co/cb' };

/** The upserted row the repository hands back — `products: 'off'`, so no backfill is enqueued. */
function upsertedConnection() {
  return {
    id: 'conn-shopify',
    storeId: STORE,
    provider: 'shopify' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    hasCredentials: true,
    shopDomain: SHOP,
    shopCurrency: 'USD',
    scopes: ['read_products'],
    webhookIds: [],
    syncSettingsProducts: 'off' as const,
    syncSettingsOrders: 'off' as const,
    syncSettingsInventory: 'off' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConnectorProvider.mockReturnValue({
    credentialStrategy: 'oauth',
    exchangeCode: (...args: unknown[]) => exchangeCode(...args),
    webhookSecretStrategy: 'shared',
    // Best-effort, exactly as on the API-key path: a provider with no webhook
    // surface logs and returns the connection unchanged.
    registerWebhooks: vi.fn().mockRejectedValue(new Error('no webhook surface in this test')),
    deleteWebhooks: vi.fn(),
  });
  encryptSecret.mockReturnValue({ ciphertext: 'c', iv: 'i', tag: 't' });
  upsertConnection.mockImplementation(() => Promise.resolve(upsertedConnection()));
  exchangeCode.mockResolvedValue({
    accessToken: 'shpat_token',
    externalShopId: 'gid://shopify/Shop/1',
    shopDomain: SHOP,
    shopCurrency: 'USD',
    scopes: ['read_products'],
  });
});

describe('connectAndVerify', () => {
  it('exchanges the code and upserts a pull connection when nothing exists', async () => {
    findConnectionByProvider.mockResolvedValue(null);

    const conn = await connectAndVerify(STORE, 'shopify', PARAMS);

    expect(exchangeCode).toHaveBeenCalledWith({
      shopDomain: SHOP,
      code: 'auth-code',
      redirectUri: 'https://mercaria.co/cb',
    });
    const [storeId, provider, values] = upsertConnection.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(storeId).toBe(STORE);
    expect(provider).toBe('shopify');
    // The value that made the defect: the pull connect asserts a mode.
    expect(values.mode).toBe('pull');
    expect(conn.mode).toBe('pull');
  });

  it('refuses a push_in connection BEFORE burning the authorization code', async () => {
    findConnectionByProvider.mockResolvedValue({ mode: 'push_in' });

    await expect(connectAndVerify(STORE, 'shopify', PARAMS)).rejects.toThrow(
      'A connection already exists for this provider in a different mode',
    );

    // The whole point of reading first on this path. Refusing after the exchange
    // would still be correct — `upsertConnection` refuses either way — but it
    // would consume a single-use code and leave a granted, unrecorded access
    // token on the merchant's Shopify shop.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('proceeds when the existing connection is already in pull mode', async () => {
    findConnectionByProvider.mockResolvedValue({ mode: 'pull' });

    await connectAndVerify(STORE, 'shopify', PARAMS);

    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(upsertConnection).toHaveBeenCalledTimes(1);
  });
});
