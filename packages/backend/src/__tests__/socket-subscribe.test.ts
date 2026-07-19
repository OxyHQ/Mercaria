/**
 * Unit tests for `authorizeAndJoinStore` — the `subscribe-store` membership guard.
 *
 * `authSocket()` proves only the socket's USER identity, so joining a store's
 * live-progress room (`store:${storeId}`) is re-authorized here against store
 * membership. These tests assert a NON-MEMBER is rejected and never joins, a
 * malformed/non-string id is rejected without even querying membership, and a
 * genuine member joins. The Store model + the socket infra deps are mocked so no
 * DB / socket server is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  oxyClient: { authSocket: () => (_socket: unknown, next: () => void) => next() },
}));
vi.mock('../lib/redis.js', () => ({
  getRedisClient: () => null,
  getRedisSubClient: () => null,
}));
vi.mock('../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const storeExists = vi.fn();
vi.mock('../models/store.js', () => ({
  Store: { exists: (...args: unknown[]) => storeExists(...args) },
}));

import { authorizeAndJoinStore } from '../socket.js';

/** A syntactically valid Mongo ObjectId (24 hex chars). */
const VALID_STORE_ID = '0'.repeat(24);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizeAndJoinStore', () => {
  it('joins the store room when the caller is a member', async () => {
    storeExists.mockResolvedValue({ _id: VALID_STORE_ID });
    const join = vi.fn().mockResolvedValue(undefined);

    const joined = await authorizeAndJoinStore({ join }, 'user-1', VALID_STORE_ID);

    expect(joined).toBe(true);
    expect(storeExists).toHaveBeenCalledWith({
      _id: VALID_STORE_ID,
      'members.oxyUserId': 'user-1',
    });
    expect(join).toHaveBeenCalledWith(`store:${VALID_STORE_ID}`);
  });

  it('rejects a NON-member and never joins the room', async () => {
    storeExists.mockResolvedValue(null);
    const join = vi.fn();

    const joined = await authorizeAndJoinStore({ join }, 'intruder', VALID_STORE_ID);

    expect(joined).toBe(false);
    expect(storeExists).toHaveBeenCalledWith({
      _id: VALID_STORE_ID,
      'members.oxyUserId': 'intruder',
    });
    expect(join).not.toHaveBeenCalled();
  });

  it('rejects a malformed store id without querying membership', async () => {
    const join = vi.fn();

    const joined = await authorizeAndJoinStore({ join }, 'user-1', 'not-an-objectid');

    expect(joined).toBe(false);
    expect(storeExists).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('rejects a non-string store id (client cannot smuggle an object filter)', async () => {
    const join = vi.fn();

    const joined = await authorizeAndJoinStore({ join }, 'user-1', { $ne: null });

    expect(joined).toBe(false);
    expect(storeExists).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });
});
