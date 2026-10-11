/**
 * Unit tests for `authorizeAndJoinStore` — the `subscribe-store` access guard.
 *
 * `authSocket()` proves only the socket's USER identity, so joining a store's
 * live-progress room (`store:${storeId}`) is re-authorized here against the
 * caller's role in the Oxy account that owns the store (ADR 0012), asked with
 * the handshake's own bearer. These tests assert somebody with no role is
 * rejected and never joins, a malformed/non-string id or a missing bearer is
 * rejected without asking anyone, an Oxy outage refuses, and a member joins.
 * The repository, the Oxy account graph and the socket infra are mocked so no
 * DB / socket server is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  oxyClient: { middleware: { socket: () => (_socket: unknown, next: () => void) => next() } },
}));
vi.mock('../lib/redis.js', () => ({
  getSocketAdapterClients: () => null,
}));
vi.mock('../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const findStoreById = vi.fn();
const readCallerAccountRole = vi.fn();
vi.mock('../db/stores/storeRepository.js', () => ({
  findStoreById: (...args: unknown[]) => findStoreById(...args),
  findStorePermissionOverride: vi.fn().mockResolvedValue(null),
  findStorePermissionOverridesForUser: vi.fn(),
  findStoresByOwnerAccounts: vi.fn(),
}));
vi.mock('../services/oxy-account-graph.js', () => ({
  readCallerAccountRole: (...args: unknown[]) => readCallerAccountRole(...args),
  listCallerAccountRoles: vi.fn(),
}));

import { authorizeAndJoinStore } from '../socket.js';
import { serviceUnavailable } from '../lib/errors/error-codes.js';

/** A syntactically valid legacy store id (24 hex chars). */
const VALID_STORE_ID = '0'.repeat(24);
const OWNING_ORG = 'org-socket';
const MEMBER = { userId: 'user-1', accessToken: 'bearer-user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  findStoreById.mockResolvedValue({ id: VALID_STORE_ID, oxyAccountId: OWNING_ORG });
});

describe('authorizeAndJoinStore', () => {
  it('joins the store room when the caller holds a role on the owning account', async () => {
    readCallerAccountRole.mockResolvedValue('viewer');
    const join = vi.fn().mockResolvedValue(undefined);

    const joined = await authorizeAndJoinStore({ join }, MEMBER, VALID_STORE_ID);

    expect(joined).toBe(true);
    expect(readCallerAccountRole).toHaveBeenCalledWith('bearer-user-1', OWNING_ORG);
    expect(join).toHaveBeenCalledWith(`store:${VALID_STORE_ID}`);
  });

  it('rejects somebody with no role and never joins the room', async () => {
    readCallerAccountRole.mockResolvedValue(null);
    const join = vi.fn();

    const joined = await authorizeAndJoinStore(
      { join },
      { userId: 'intruder', accessToken: 'bearer-intruder' },
      VALID_STORE_ID,
    );

    expect(joined).toBe(false);
    expect(join).not.toHaveBeenCalled();
  });

  it('refuses when Oxy cannot answer — the guard fails closed', async () => {
    readCallerAccountRole.mockRejectedValue(serviceUnavailable('Oxy is down'));
    const join = vi.fn();

    await expect(authorizeAndJoinStore({ join }, MEMBER, VALID_STORE_ID)).rejects.toThrow();
    expect(join).not.toHaveBeenCalled();
  });

  it('rejects a handshake with no bearer without asking anyone', async () => {
    const join = vi.fn();

    const joined = await authorizeAndJoinStore(
      { join },
      { userId: 'user-1', accessToken: undefined },
      VALID_STORE_ID,
    );

    expect(joined).toBe(false);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(readCallerAccountRole).not.toHaveBeenCalled();
  });

  it('rejects a malformed store id without querying anything', async () => {
    const join = vi.fn();

    const joined = await authorizeAndJoinStore({ join }, MEMBER, 'not-an-objectid');

    expect(joined).toBe(false);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  // A filter built straight from `rawStoreId` would let an object like
  // `{$ne: null}` act as a query OPERATOR and match any store. A parameterised
  // repository call cannot be smuggled that way, but the guard is kept and so
  // is this test: the type check is the reason it cannot, and deleting the
  // assertion is how a future refactor reintroduces the hole.
  it('rejects a non-string store id (client cannot smuggle an object filter)', async () => {
    const join = vi.fn();

    const joined = await authorizeAndJoinStore({ join }, MEMBER, { $ne: null });

    expect(joined).toBe(false);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });
});
