/**
 * `getProfiles` is ONE `users.lookupMany` (deduped, chunked, over the workload
 * token) — never a `users.get` per id — and it tells a failed lookup from a
 * missing account: both are absent from the map, and only the failed ids are
 * logged as a failure, by id.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ lookupMany: vi.fn(), get: vi.fn(), warn: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { users: { lookupMany: sdk.lookupMany, get: sdk.get } },
}));
vi.mock('../../lib/logger.js', () => ({ log: { general: { warn: sdk.warn } } }));

const { getProfiles } = await import('../oxy-user.service.js');

const user = (id: string, displayName?: string) => ({
  id,
  username: `u_${id}`,
  name: displayName === undefined ? {} : { displayName },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getProfiles', () => {
  it('asks Oxy once for the whole batch and maps every found user', async () => {
    sdk.lookupMany.mockResolvedValue({
      found: [user('a', 'Ada'), user('b')],
      missing: [],
      failed: [],
    });
    const profiles = await getProfiles(['a', 'b', 'a', '']);
    expect(sdk.lookupMany).toHaveBeenCalledOnce();
    expect(sdk.get).not.toHaveBeenCalled();
    expect(profiles.get('a')?.displayName).toBe('Ada');
    // No declared name: the handle, never an empty name.
    expect(profiles.get('b')?.displayName).toBe('u_b');
  });

  it('reports the ids whose lookup failed, and only those', async () => {
    const error = Object.assign(new Error('Bad Gateway'), { status: 502 });
    sdk.lookupMany.mockResolvedValue({
      found: [user('a')],
      missing: ['gone'],
      failed: ['b', 'c'],
      error,
    });
    const profiles = await getProfiles(['a', 'b', 'c', 'gone']);
    expect([...profiles.keys()]).toEqual(['a']);
    expect(sdk.warn).toHaveBeenCalledExactlyOnceWith(
      { err: error, failedOxyUserIds: ['b', 'c'] },
      expect.any(String),
    );
  });

  it('asks nothing for an empty batch', async () => {
    expect((await getProfiles(['', ''])).size).toBe(0);
    expect(sdk.lookupMany).not.toHaveBeenCalled();
  });
});
