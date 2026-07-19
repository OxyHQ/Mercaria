/**
 * Unit tests for `connector-sync.service.connectWithApiKey` — the API-key connect
 * path used by WooCommerce. No DB / no network: the Connection model, the crypto
 * helper and the provider registry are mocked. Asserts the credential pair is
 * verified against the provider (as the joined HTTP Basic userinfo), stored
 * ENCRYPTED as `{ consumerKey, consumerSecret }` (never plaintext), and upserted as
 * a `pull` connection; and that an unsupported currency, a mode clash, and a
 * non-api_key provider are all rejected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectionFindOne = vi.fn();
const connectionFindOneAndUpdate = vi.fn();
const encryptSecret = vi.fn();
const getConnectorProvider = vi.fn();
const verifyConnection = vi.fn();

vi.mock('../../models/connection.js', () => ({
  Connection: {
    findOne: (...args: unknown[]) => connectionFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => connectionFindOneAndUpdate(...args),
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  getConnectorProvider.mockReturnValue({
    credentialStrategy: 'api_key',
    verifyConnection: (...args: unknown[]) => verifyConnection(...args),
  });
  encryptSecret.mockReturnValue({ ciphertext: 'c', iv: 'i', tag: 't' });
});

describe('connectWithApiKey', () => {
  it('verifies creds, encrypts the pair, and upserts a pull connection', async () => {
    connectionFindOne.mockResolvedValue(null);
    verifyConnection.mockResolvedValue({
      externalShopId: SITE,
      shopDomain: SITE,
      shopCurrency: 'USD',
    });
    connectionFindOneAndUpdate.mockResolvedValue({
      _id: '1'.repeat(24),
      storeId: STORE,
      provider: 'woocommerce',
      mode: 'pull',
    });

    const conn = await connectWithApiKey(STORE, 'woocommerce', { shopDomain: SITE, ...KEYS });

    // verifyConnection received the joined `consumerKey:consumerSecret` Basic userinfo.
    expect(verifyConnection).toHaveBeenCalledWith({
      accessToken: 'ck_abc:cs_xyz',
      shopDomain: SITE,
    });
    // Credentials encrypted as { consumerKey, consumerSecret } — never plaintext at rest.
    expect(encryptSecret).toHaveBeenCalledWith(JSON.stringify(KEYS));

    const [filter, update] = connectionFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({ storeId: STORE, provider: 'woocommerce' });
    expect(update.$set.mode).toBe('pull');
    expect(update.$set.status).toBe('connected');
    expect(update.$set.shopCurrency).toBe('USD');
    expect(update.$set.credentials).toEqual({ ciphertext: 'c', iv: 'i', tag: 't' });
    expect(conn.mode).toBe('pull');
  });

  it('rejects an unsupported shop currency (no upsert)', async () => {
    connectionFindOne.mockResolvedValue(null);
    verifyConnection.mockResolvedValue({ externalShopId: SITE, shopDomain: SITE, shopCurrency: 'ZZZ' });

    await expect(
      connectWithApiKey(STORE, 'woocommerce', { shopDomain: SITE, ...KEYS }),
    ).rejects.toThrow();
    expect(connectionFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses to hijack an existing connection in a different mode', async () => {
    connectionFindOne.mockResolvedValue({ mode: 'push_in' });

    await expect(
      connectWithApiKey(STORE, 'woocommerce', { shopDomain: SITE, ...KEYS }),
    ).rejects.toThrow();
    expect(verifyConnection).not.toHaveBeenCalled();
  });

  it('rejects a provider that does not use the api_key strategy', async () => {
    getConnectorProvider.mockReturnValue({
      credentialStrategy: 'oauth',
      verifyConnection: (...args: unknown[]) => verifyConnection(...args),
    });

    await expect(
      connectWithApiKey(STORE, 'shopify', { shopDomain: SITE, ...KEYS }),
    ).rejects.toThrow();
    expect(connectionFindOne).not.toHaveBeenCalled();
  });
});
