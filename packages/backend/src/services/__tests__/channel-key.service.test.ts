/**
 * Unit tests for `channel-key.service` — mint / list / revoke / verify the
 * long-lived, store-scoped channel API keys.
 *
 * No DB: the `ChannelApiKey` and `Connection` models are mocked with a tiny
 * in-memory store so a key genuinely ROUND-TRIPS through the real hashing +
 * constant-time verification (`verifySecret` is NOT mocked). The tests assert:
 * the key format + one-time plaintext, generate→verify success, `lastUsedAt`
 * refresh, revoked/unknown/wrong-secret rejection, cross-store isolation on
 * verify AND revoke, the push-in binding check at generate time, and that listed
 * metadata never leaks the secret.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MercariaError } from '../../lib/errors/error-codes.js';

interface KeyDoc {
  _id: string;
  storeId: string;
  connectionId?: string;
  hash: string;
  prefix: string;
  label: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const keyCreate = vi.fn();
const keyFind = vi.fn();
const keyFindOneAndUpdate = vi.fn();
const keyUpdateOne = vi.fn();
const connectionFindOne = vi.fn();

vi.mock('../../models/channel-api-key.js', () => ({
  ChannelApiKey: {
    create: (...args: unknown[]) => keyCreate(...args),
    find: (...args: unknown[]) => keyFind(...args),
    findOneAndUpdate: (...args: unknown[]) => keyFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => keyUpdateOne(...args),
  },
}));
vi.mock('../../models/connection.js', () => ({
  Connection: { findOne: (...args: unknown[]) => connectionFindOne(...args) },
}));

import { generateKey, listKeys, revokeKey, verifyKey } from '../channel-key.service.js';

const STORE_A = 'store-a';
const STORE_B = 'store-b';
const USER = 'user-1';

let docs: KeyDoc[] = [];
let idCounter = 0;

/** A filter matcher supporting `{ $exists }` and strict equality. */
function matches(doc: KeyDoc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = (doc as unknown as Record<string, unknown>)[field];
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      const present = actual !== undefined && actual !== null;
      return (expected as { $exists: boolean }).$exists ? present : !present;
    }
    return String(actual) === String(expected);
  });
}

/** A minimal chainable query supporting `.sort()`/`.select()` and `await`. */
function makeQuery(getResults: () => KeyDoc[]) {
  let sortDesc = false;
  const query = {
    sort(spec: Record<string, number>) {
      if (spec.createdAt === -1) sortDesc = true;
      return query;
    },
    select() {
      return query;
    },
    then<T>(resolve: (value: KeyDoc[]) => T, reject?: (reason: unknown) => T) {
      let out = getResults();
      if (sortDesc) {
        out = [...out].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return Promise.resolve(out).then(resolve, reject);
    },
  };
  return query;
}

/** A `Connection.findOne(...).select(...)` result stub. */
function connectionResult(result: { _id: string; mode: string } | null) {
  return { select: () => Promise.resolve(result) };
}

beforeEach(() => {
  vi.clearAllMocks();
  docs = [];
  idCounter = 0;

  keyCreate.mockImplementation((input: Partial<KeyDoc>) => {
    idCounter += 1;
    const doc: KeyDoc = {
      _id: `key-${idCounter}`,
      storeId: String(input.storeId),
      hash: String(input.hash),
      prefix: String(input.prefix),
      label: String(input.label),
      scopes: [...(input.scopes ?? [])],
      createdBy: String(input.createdBy),
      createdAt: new Date(Date.now() + idCounter),
      updatedAt: new Date(),
    };
    if (input.connectionId !== undefined) doc.connectionId = input.connectionId;
    docs.push(doc);
    return Promise.resolve(doc);
  });

  keyFind.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(() => docs.filter((d) => matches(d, filter))),
  );

  keyFindOneAndUpdate.mockImplementation(
    (filter: Record<string, unknown>, update: { $set: Partial<KeyDoc> }) => {
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return Promise.resolve(null);
      Object.assign(doc, update.$set);
      return Promise.resolve(doc);
    },
  );

  keyUpdateOne.mockImplementation(
    (filter: Record<string, unknown>, update: { $set: Partial<KeyDoc> }) => {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) Object.assign(doc, update.$set);
      return Promise.resolve({ matchedCount: doc ? 1 : 0 });
    },
  );
});

describe('generateKey', () => {
  it('mints a well-formed key and returns the plaintext exactly once', async () => {
    const { key, apiKey } = await generateKey(STORE_A, { label: 'WordPress plugin' }, USER);

    expect(key).toMatch(/^mck_[0-9a-f]{64}$/);
    expect(key.length).toBe(68);
    // The plaintext never appears in the stored doc or the metadata DTO.
    expect(JSON.stringify(apiKey)).not.toContain(key);
    expect(apiKey.prefix).toBe(key.slice(0, 12));
    expect(apiKey.scopes).toEqual(['channels:write']);
    expect(apiKey.storeId).toBe(STORE_A);
    expect(apiKey.createdBy).toBe(USER);
    // Stored form is the sha256 hash, never the plaintext.
    expect(docs[0].hash).not.toBe(key);
    expect(docs[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds to a push-in connection when given a valid one', async () => {
    connectionFindOne.mockReturnValue(connectionResult({ _id: 'conn-1', mode: 'push_in' }));
    const { apiKey } = await generateKey(
      STORE_A,
      { label: 'Bound', connectionId: 'conn-1' },
      USER,
    );
    expect(apiKey.connectionId).toBe('conn-1');
  });

  it('rejects a connection that is not push-in (400)', async () => {
    connectionFindOne.mockReturnValue(connectionResult({ _id: 'conn-1', mode: 'pull' }));
    await expect(
      generateKey(STORE_A, { label: 'x', connectionId: 'conn-1' }, USER),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a connection that is not in the store (404)', async () => {
    connectionFindOne.mockReturnValue(connectionResult(null));
    await expect(
      generateKey(STORE_A, { label: 'x', connectionId: 'conn-x' }, USER),
    ).rejects.toBeInstanceOf(MercariaError);
    await expect(
      generateKey(STORE_A, { label: 'x', connectionId: 'conn-x' }, USER),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a blank label (400)', async () => {
    await expect(generateKey(STORE_A, { label: '   ' }, USER)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('verifyKey', () => {
  it('round-trips: a freshly minted key verifies and refreshes lastUsedAt', async () => {
    const { key } = await generateKey(STORE_A, { label: 'plugin' }, USER);
    expect(docs[0].lastUsedAt).toBeUndefined();

    const resolved = await verifyKey(key);
    expect(resolved).not.toBeNull();
    expect(resolved?.storeId).toBe(STORE_A);
    expect(resolved?.keyId).toBe('key-1');
    expect(resolved?.connectionId).toBeUndefined();
    // lastUsedAt was stamped.
    expect(docs[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('resolves the bound connection id for a connection-scoped key', async () => {
    connectionFindOne.mockReturnValue(connectionResult({ _id: 'conn-1', mode: 'push_in' }));
    const { key } = await generateKey(STORE_A, { label: 'Bound', connectionId: 'conn-1' }, USER);
    const resolved = await verifyKey(key);
    expect(resolved?.connectionId).toBe('conn-1');
  });

  it('rejects a revoked key', async () => {
    const { key, apiKey } = await generateKey(STORE_A, { label: 'plugin' }, USER);
    await revokeKey(STORE_A, apiKey.id);
    expect(await verifyKey(key)).toBeNull();
  });

  it('rejects an unknown / malformed key', async () => {
    await generateKey(STORE_A, { label: 'plugin' }, USER);
    expect(await verifyKey(`mck_${'f'.repeat(64)}`)).toBeNull(); // right shape, no match
    expect(await verifyKey('not-a-key')).toBeNull();
    expect(await verifyKey('mck_short')).toBeNull();
    expect(await verifyKey('')).toBeNull();
  });

  it('rejects a key with the right prefix but the wrong secret', async () => {
    const { key } = await generateKey(STORE_A, { label: 'plugin' }, USER);
    // Same 12-char prefix, different tail → a candidate is found but the hash
    // comparison fails.
    const forged = `${key.slice(0, 12)}${'0'.repeat(56)}`;
    expect(forged.length).toBe(68);
    expect(await verifyKey(forged)).toBeNull();
  });

  it('resolves the OWNING store, never a foreign one (cross-store isolation)', async () => {
    const { key } = await generateKey(STORE_A, { label: 'a' }, USER);
    await generateKey(STORE_B, { label: 'b' }, USER);
    const resolved = await verifyKey(key);
    expect(resolved?.storeId).toBe(STORE_A);
  });
});

describe('revokeKey', () => {
  it('revokes a store-owned key', async () => {
    const { apiKey } = await generateKey(STORE_A, { label: 'a' }, USER);
    const revoked = await revokeKey(STORE_A, apiKey.id);
    expect(revoked.id).toBe(apiKey.id);
    expect(docs[0].revokedAt).toBeInstanceOf(Date);
  });

  it('rejects a cross-store revoke (404) and leaves the key active', async () => {
    const { apiKey, key } = await generateKey(STORE_A, { label: 'a' }, USER);
    await expect(revokeKey(STORE_B, apiKey.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The key still verifies — the foreign revoke did nothing.
    expect(await verifyKey(key)).not.toBeNull();
  });

  it('rejects revoking an already-revoked key (404)', async () => {
    const { apiKey } = await generateKey(STORE_A, { label: 'a' }, USER);
    await revokeKey(STORE_A, apiKey.id);
    await expect(revokeKey(STORE_A, apiKey.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('listKeys', () => {
  it('returns metadata only (no hash/secret) and excludes revoked keys', async () => {
    const { apiKey: first } = await generateKey(STORE_A, { label: 'first' }, USER);
    await generateKey(STORE_A, { label: 'second' }, USER);
    await revokeKey(STORE_A, first.id);

    const keys = await listKeys(STORE_A);
    expect(keys).toHaveLength(1);
    expect(keys[0].label).toBe('second');
    // No secret material is present on the DTO.
    expect(Object.keys(keys[0])).not.toContain('hash');
    expect(JSON.stringify(keys)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('scopes the list to the store', async () => {
    await generateKey(STORE_A, { label: 'a' }, USER);
    await generateKey(STORE_B, { label: 'b' }, USER);
    const keys = await listKeys(STORE_A);
    expect(keys).toHaveLength(1);
    expect(keys[0].storeId).toBe(STORE_A);
  });
});
