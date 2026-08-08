/**
 * Unit tests for `channel-key.service` — mint / list / revoke / verify the
 * long-lived, store-scoped channel API keys.
 *
 * No DB: the channel-key and connection REPOSITORIES are mocked with a tiny
 * in-memory store, so a key genuinely ROUND-TRIPS through the real hashing +
 * constant-time verification (`verifySecret` is NOT mocked). The tests assert:
 * the key format + one-time plaintext, generate→verify success, `lastUsedAt`
 * refresh, revoked/unknown/wrong-secret rejection, cross-store isolation on
 * verify AND revoke, the push-in binding check at generate time, and that listed
 * metadata never leaks the secret.
 *
 * ## The stub is repositories, not query chains — and it keeps `hash` apart
 *
 * The Mongoose stub had to reproduce `.find().sort().select()` and a `$exists`
 * matcher. The repository boundary has neither: the fake below stores rows and
 * answers four plain functions. It also mirrors the PROTECTED-column split that
 * the real code has — `findActiveChannelApiKeys` / `insertChannelApiKey` /
 * `revokeChannelApiKey` return rows WITHOUT `hash`, and only
 * `findVerificationCandidates` carries it. That is what makes
 * "listed metadata never leaks the secret" a real assertion here rather than a
 * property of a fixture that happened not to include it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MercariaError } from '../../lib/errors/error-codes.js';

/** A stored key row, digest included — the fake's own storage shape. */
interface StoredKey {
  id: string;
  storeId: string;
  connectionId: string | null;
  hash: string;
  prefix: string;
  label: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const insertChannelApiKey = vi.fn();
const findActiveChannelApiKeys = vi.fn();
const revokeChannelApiKey = vi.fn();
const findVerificationCandidates = vi.fn();
const touchChannelApiKeyLastUsed = vi.fn();
const findConnection = vi.fn();

vi.mock('../../db/connectors/channelApiKeyRepository.js', () => ({
  insertChannelApiKey: (...args: unknown[]) => insertChannelApiKey(...args),
  findActiveChannelApiKeys: (...args: unknown[]) => findActiveChannelApiKeys(...args),
  revokeChannelApiKey: (...args: unknown[]) => revokeChannelApiKey(...args),
  findVerificationCandidates: (...args: unknown[]) => findVerificationCandidates(...args),
  touchChannelApiKeyLastUsed: (...args: unknown[]) => touchChannelApiKeyLastUsed(...args),
}));
vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnection: (...args: unknown[]) => findConnection(...args),
}));

import { generateKey, listKeys, revokeKey, verifyKey } from '../channel-key.service.js';

const STORE_A = 'store-a';
const STORE_B = 'store-b';
const USER = 'user-1';

let rows: StoredKey[] = [];
let idCounter = 0;

/**
 * A row as the PUBLIC reads return it — `hash` withheld.
 *
 * The real reads go through `publicColumns`, so the digest is absent from the
 * row TYPE and cannot be serialized by accident. The fake reproduces that at
 * runtime by deleting it, which is what lets the DTO assertions below mean
 * something.
 */
function publicRow(row: StoredKey): Omit<StoredKey, 'hash'> {
  return {
    id: row.id,
    storeId: row.storeId,
    connectionId: row.connectionId,
    prefix: row.prefix,
    label: row.label,
    scopes: row.scopes,
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  idCounter = 0;

  insertChannelApiKey.mockImplementation((values: Omit<StoredKey, 'id'>) => {
    idCounter += 1;
    const row: StoredKey = {
      id: `key-${idCounter}`,
      storeId: values.storeId,
      connectionId: values.connectionId ?? null,
      hash: values.hash,
      prefix: values.prefix,
      label: values.label,
      scopes: [...values.scopes],
      createdBy: values.createdBy,
      lastUsedAt: null,
      revokedAt: null,
      // Monotonic, so the newest-first ordering below is deterministic.
      createdAt: new Date(Date.now() + idCounter),
      updatedAt: new Date(),
    };
    rows.push(row);
    return Promise.resolve(publicRow(row));
  });

  findActiveChannelApiKeys.mockImplementation((storeId: string) =>
    Promise.resolve(
      rows
        .filter((row) => row.storeId === storeId && row.revokedAt === null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(publicRow),
    ),
  );

  // The `revoked_at IS NULL` guard and the update are ONE statement, so a second
  // revoke matches nothing rather than re-stamping — the fake keeps that shape.
  revokeChannelApiKey.mockImplementation((storeId: string, keyId: string) => {
    const row = rows.find(
      (candidate) =>
        candidate.id === keyId && candidate.storeId === storeId && candidate.revokedAt === null,
    );
    if (!row) return Promise.resolve(null);
    row.revokedAt = new Date();
    return Promise.resolve(publicRow(row));
  });

  findVerificationCandidates.mockImplementation((prefix: string) =>
    Promise.resolve(
      rows
        .filter((row) => row.prefix === prefix && row.revokedAt === null)
        .map((row) => ({
          id: row.id,
          storeId: row.storeId,
          connectionId: row.connectionId,
          hash: row.hash,
        })),
    ),
  );

  touchChannelApiKeyLastUsed.mockImplementation((keyId: string) => {
    const row = rows.find((candidate) => candidate.id === keyId);
    if (row) row.lastUsedAt = new Date();
    return Promise.resolve(undefined);
  });
});

describe('generateKey', () => {
  it('mints a well-formed key and returns the plaintext exactly once', async () => {
    const { key, apiKey } = await generateKey(STORE_A, { label: 'WordPress plugin' }, USER);

    expect(key).toMatch(/^mck_[0-9a-f]{64}$/);
    expect(key.length).toBe(68);
    // The plaintext never appears in the stored row or the metadata DTO.
    expect(JSON.stringify(apiKey)).not.toContain(key);
    expect(apiKey.prefix).toBe(key.slice(0, 12));
    // The column's DDL default is the EMPTY array (Mongoose defaulted it to the
    // full set), so this asserts the service writes the scopes explicitly.
    expect(apiKey.scopes).toEqual(['channels:write']);
    expect(apiKey.storeId).toBe(STORE_A);
    expect(apiKey.createdBy).toBe(USER);
    // Stored form is the sha256 hash, never the plaintext.
    expect(rows[0].hash).not.toBe(key);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds to a push-in connection when given a valid one', async () => {
    findConnection.mockResolvedValue({ id: 'conn-1', mode: 'push_in' });
    const { apiKey } = await generateKey(
      STORE_A,
      { label: 'Bound', connectionId: 'conn-1' },
      USER,
    );
    // The store scope IS the authorization — the read is `(storeId, connectionId)`.
    expect(findConnection).toHaveBeenCalledWith(STORE_A, 'conn-1');
    expect(apiKey.connectionId).toBe('conn-1');
  });

  it('rejects a connection that is not push-in (400)', async () => {
    findConnection.mockResolvedValue({ id: 'conn-1', mode: 'pull' });
    await expect(
      generateKey(STORE_A, { label: 'x', connectionId: 'conn-1' }, USER),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a connection that is not in the store (404)', async () => {
    findConnection.mockResolvedValue(null);
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

  it('trims the label before storing it — Mongoose had no trim here either', async () => {
    // `trim: true` is Mongoose APPLICATION behaviour with no Postgres counterpart,
    // so a port has to re-apply every normalization at the call site. This model
    // declared none and the service already trimmed; the assertion pins that the
    // trim did not travel out of the service with the schema.
    const { apiKey } = await generateKey(STORE_A, { label: '  Spaced  ' }, USER);
    expect(apiKey.label).toBe('Spaced');
    expect(rows[0].label).toBe('Spaced');
  });
});

describe('verifyKey', () => {
  it('round-trips: a freshly minted key verifies and refreshes lastUsedAt', async () => {
    const { key } = await generateKey(STORE_A, { label: 'plugin' }, USER);
    expect(rows[0].lastUsedAt).toBeNull();

    const resolved = await verifyKey(key);
    expect(resolved).not.toBeNull();
    expect(resolved?.storeId).toBe(STORE_A);
    expect(resolved?.keyId).toBe('key-1');
    expect(resolved?.connectionId).toBeUndefined();
    // lastUsedAt was stamped.
    expect(rows[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('narrows on the PUBLIC prefix, never on the digest', async () => {
    // `UNIQUE(hash)` would make a single indexed equality lookup work; using it
    // would put the accept decision in the database's index instead of the
    // constant-time compare. The candidate read is keyed on the prefix, and this
    // is what would catch that being "optimized".
    const { key } = await generateKey(STORE_A, { label: 'plugin' }, USER);
    await verifyKey(key);
    expect(findVerificationCandidates).toHaveBeenCalledWith(key.slice(0, 12));
  });

  it('resolves the bound connection id for a connection-scoped key', async () => {
    findConnection.mockResolvedValue({ id: 'conn-1', mode: 'push_in' });
    const { key } = await generateKey(STORE_A, { label: 'Bound', connectionId: 'conn-1' }, USER);
    const resolved = await verifyKey(key);
    expect(resolved?.connectionId).toBe('conn-1');
  });

  it('rejects a revoked key — whose ROW is still there', async () => {
    const { key, apiKey } = await generateKey(STORE_A, { label: 'plugin' }, USER);
    await revokeKey(STORE_A, apiKey.id);

    expect(await verifyKey(key)).toBeNull();
    // Revocation stamps `revoked_at`; it never deletes, so the audit trail of who
    // minted the key and when it was last used outlives the key itself.
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
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
    // comparison fails. This is the case that distinguishes "narrowed by prefix"
    // from "decided by prefix".
    const forged = `${key.slice(0, 12)}${'0'.repeat(56)}`;
    expect(forged.length).toBe(68);
    expect(await verifyKey(forged)).toBeNull();
    expect(touchChannelApiKeyLastUsed).not.toHaveBeenCalled();
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
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it('rejects a cross-store revoke (404) and leaves the key active', async () => {
    const { apiKey, key } = await generateKey(STORE_A, { label: 'a' }, USER);
    await expect(revokeKey(STORE_B, apiKey.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The key still verifies — the foreign revoke did nothing.
    expect(await verifyKey(key)).not.toBeNull();
  });

  it('rejects revoking an already-revoked key (404) and keeps the FIRST timestamp', async () => {
    const { apiKey } = await generateKey(STORE_A, { label: 'a' }, USER);
    await revokeKey(STORE_A, apiKey.id);
    const stampedAt = rows[0].revokedAt;

    await expect(revokeKey(STORE_A, apiKey.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The `revoked_at IS NULL` guard is part of the UPDATE, so the second attempt
    // matched nothing rather than re-stamping — which is what keeps the audit
    // trail saying when the key was ACTUALLY revoked.
    expect(revokeChannelApiKey).toHaveBeenCalledTimes(2);
    expect(rows[0].revokedAt).toBe(stampedAt);
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
    // No secret material is present on the DTO — and the row it was built from
    // did not carry any, because the read went through `publicColumns`.
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
