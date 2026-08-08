/**
 * Unit tests for `connector-sync.service.connectWithApiKey` — the API-key connect
 * path used by WooCommerce. No DB / no network: the connection repository, the
 * crypto helper and the provider registry are mocked. Asserts the credential pair
 * is verified against the provider (as the joined HTTP Basic userinfo), stored
 * ENCRYPTED as `{ consumerKey, consumerSecret }` (never plaintext), and upserted as
 * a `pull` connection; and that an unsupported currency, a mode clash, and a
 * non-api_key provider are all rejected.
 *
 * The upsert is ONE statement on `UNIQUE(store_id, provider)` now rather than a
 * `findOneAndUpdate` filter plus an update document, so the assertions read the
 * repository call's `(storeId, provider, values)` arguments. The read that
 * remains is the MODE-CLASH check, which is a policy refusal and could not be
 * folded into the upsert without silently hijacking a push-in connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findConnectionByProvider = vi.fn();
const upsertConnection = vi.fn();
const setConnectionWebhooks = vi.fn();
const encryptSecret = vi.fn();
const getConnectorProvider = vi.fn();
const verifyConnection = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnectionByProvider: (...args: unknown[]) => findConnectionByProvider(...args),
  upsertConnection: (...args: unknown[]) => upsertConnection(...args),
  setConnectionWebhooks: (...args: unknown[]) => setConnectionWebhooks(...args),
  findConnection: vi.fn(),
  findConnectionById: vi.fn(),
  findConnectionCredentials: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findPullConnectionsToReconcile: vi.fn(),
  findPushConnections: vi.fn(),
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

import { connectWithApiKey } from '../connector-sync.service.js';

const STORE = '0'.repeat(24);
const KEYS = { consumerKey: 'ck_abc', consumerSecret: 'cs_xyz' };
const SITE = 'https://shop.example.com';

/** The upserted row the repository hands back — flat columns, no envelope on it. */
function upsertedConnection() {
  return {
    id: 'conn-woo',
    storeId: STORE,
    provider: 'woocommerce' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    hasCredentials: true,
    shopDomain: SITE,
    shopCurrency: 'USD',
    scopes: [],
    webhookIds: [],
    syncSettingsProducts: 'off' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConnectorProvider.mockReturnValue({
    credentialStrategy: 'api_key',
    verifyConnection: (...args: unknown[]) => verifyConnection(...args),
    // `registerConnectionWebhooks` runs for real on the connect path; it is
    // best-effort, so a provider with no webhook surface simply logs and returns
    // the connection unchanged.
    webhookSecretStrategy: 'per_connection',
    registerWebhooks: vi.fn().mockRejectedValue(new Error('no webhook surface in this test')),
    deleteWebhooks: vi.fn(),
  });
  encryptSecret.mockReturnValue({ ciphertext: 'c', iv: 'i', tag: 't' });
  upsertConnection.mockImplementation(() => Promise.resolve(upsertedConnection()));
});

describe('connectWithApiKey', () => {
  it('verifies creds, encrypts the pair, and upserts a pull connection', async () => {
    findConnectionByProvider.mockResolvedValue(null);
    verifyConnection.mockResolvedValue({
      externalShopId: SITE,
      shopDomain: SITE,
      shopCurrency: 'USD',
    });

    const conn = await connectWithApiKey(STORE, 'woocommerce', { shopDomain: SITE, ...KEYS });

    // verifyConnection received the joined `consumerKey:consumerSecret` Basic userinfo.
    expect(verifyConnection).toHaveBeenCalledWith({
      accessToken: 'ck_abc:cs_xyz',
      shopDomain: SITE,
    });
    // Credentials encrypted as { consumerKey, consumerSecret } — never plaintext at rest.
    expect(encryptSecret).toHaveBeenCalledWith(JSON.stringify(KEYS));

    // The `findOneAndUpdate` filter + `$set` pair became the upsert's own
    // arguments: the conflict key is stated positionally and the values are the
    // whitelist the repository writes on both the insert and the conflict path.
    const [storeId, provider, values] = upsertConnection.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(storeId).toBe(STORE);
    expect(provider).toBe('woocommerce');
    expect(values.mode).toBe('pull');
    expect(values.status).toBe('connected');
    expect(values.shopCurrency).toBe('USD');
    expect(values.credentials).toEqual({ ciphertext: 'c', iv: 'i', tag: 't' });
    // An API-key provider grants no OAuth scopes, and the empty array is written
    // EXPLICITLY so a reconnect cannot leave a previous grant standing.
    expect(values.scopes).toEqual([]);
    expect(conn.mode).toBe('pull');
  });

  it('rejects an unsupported shop currency (no upsert)', async () => {
    findConnectionByProvider.mockResolvedValue(null);
    verifyConnection.mockResolvedValue({ externalShopId: SITE, shopDomain: SITE, shopCurrency: 'ZZZ' });

    await expect(
      connectWithApiKey(STORE, 'woocommerce', { shopDomain: SITE, ...KEYS }),
    ).rejects.toThrow();
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('refuses to hijack an existing connection in a different mode', async () => {
    findConnectionByProvider.mockResolvedValue({ mode: 'push_in' });

    await expect(
      connectWithApiKey(STORE, 'woocommerce', { shopDomain: SITE, ...KEYS }),
    ).rejects.toThrow();
    expect(verifyConnection).not.toHaveBeenCalled();
    // The clash is why this path still READS before it upserts: an upsert alone
    // would have taken the push-in connection over.
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('rejects a provider that does not use the api_key strategy', async () => {
    getConnectorProvider.mockReturnValue({
      credentialStrategy: 'oauth',
      verifyConnection: (...args: unknown[]) => verifyConnection(...args),
    });

    await expect(
      connectWithApiKey(STORE, 'shopify', { shopDomain: SITE, ...KEYS }),
    ).rejects.toThrow();
    expect(findConnectionByProvider).not.toHaveBeenCalled();
  });
});
