/**
 * Unit tests for `store-authz` and the access resolution behind it (ADR 0012).
 *
 * Covers the ONE role map (`STORE_ROLE_PERMISSIONS`), the override arithmetic
 * (`(role defaults ∪ granted) − revoked`), `requireStorePermission`, and
 * `loadStore` end to end against a mocked store repository and a mocked Oxy
 * account graph — which is where every decision that matters is made: who is
 * the owning account, when Oxy is asked, that an override never admits
 * anybody, and that an Oxy outage refuses rather than guesses.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  STORE_PERMISSIONS,
  STORE_ROLE_PERMISSIONS,
  effectiveStorePermissions,
  type StoreAccess,
  type StorePermission,
} from '@mercaria/shared-types';

const findStoreById = vi.fn();
const findStorePermissionOverride = vi.fn();
const readCallerAccountRole = vi.fn();

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: (...args: unknown[]) => findStoreById(...args),
  findStorePermissionOverride: (...args: unknown[]) => findStorePermissionOverride(...args),
  findStorePermissionOverridesForUser: vi.fn(),
  findStoresByOwnerAccounts: vi.fn(),
}));
vi.mock('../../services/oxy-account-graph.js', () => ({
  readCallerAccountRole: (...args: unknown[]) => readCallerAccountRole(...args),
  listCallerAccountRoles: vi.fn(),
}));

import { loadStore, requireStorePermission } from '../store-authz.js';
import { resetStoreAccessCacheForTests } from '../../services/store-access.service.js';
import { serviceUnavailable } from '../../lib/errors/error-codes.js';

const STORE_ID = '1'.repeat(24);
const ORG = 'org-acme';
const ALICE = 'person-alice';
const BOB = 'person-bob';

type MockRes = Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };

function mockRes(): MockRes {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as MockRes;
}

/**
 * A request as `authenticateToken` leaves it. `actor` is the chain Oxy
 * reports; omitted means Oxy reported none.
 */
function request(
  userId: string | undefined,
  actor?: { actorAccountId: string; delegated: boolean },
): Request {
  return {
    params: { storeId: STORE_ID },
    userId,
    accessToken: userId ? `bearer-of-${userId}` : undefined,
    ...(actor && userId
      ? { oxyActor: { schemaVersion: 1, effectiveAccountId: userId, ...actor } }
      : {}),
  } as unknown as Request;
}

/** Run `loadStore` and report what it did. */
async function load(req: Request): Promise<{ status: number | null; access?: StoreAccess }> {
  const res = mockRes();
  const next = vi.fn() as unknown as NextFunction;
  await loadStore(req, res, next);
  if ((next as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
    return { status: null, access: req.storeAccess };
  }
  return { status: res.status.mock.calls[0]?.[0] as number };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStoreAccessCacheForTests();
  findStoreById.mockResolvedValue({ id: STORE_ID, oxyAccountId: ORG });
  findStorePermissionOverride.mockResolvedValue(null);
  readCallerAccountRole.mockResolvedValue(null);
});

describe('STORE_ROLE_PERMISSIONS — the one role map', () => {
  it('owner holds all eighteen; admin all but store:manage', () => {
    expect([...STORE_ROLE_PERMISSIONS.owner]).toEqual([...STORE_PERMISSIONS]);
    expect(STORE_PERMISSIONS).toHaveLength(18);
    expect(STORE_ROLE_PERMISSIONS.admin).toHaveLength(17);
    expect(STORE_ROLE_PERMISSIONS.admin).not.toContain('store:manage');
  });

  it('editor runs the catalogue and the shop floor and configures nothing commercial', () => {
    expect([...STORE_ROLE_PERMISSIONS.editor].sort()).toEqual(
      [
        'collections:write',
        'customers:read',
        'customers:write',
        'discounts:write',
        'draft_orders:write',
        'inventory:write',
        'locations:write',
        'orders:fulfill',
        'orders:read',
        'products:read',
        'products:write',
        'stats:read',
      ].sort(),
    );
  });

  it('developer connects channels; billing reads money; viewer reads the trading record', () => {
    expect([...STORE_ROLE_PERMISSIONS.developer].sort()).toEqual(['channels:write', 'products:read']);
    expect([...STORE_ROLE_PERMISSIONS.billing].sort()).toEqual([
      'analytics:read',
      'orders:read',
      'stats:read',
    ]);
    expect([...STORE_ROLE_PERMISSIONS.viewer].sort()).toEqual([
      'orders:read',
      'products:read',
      'stats:read',
    ]);
  });

  it('every permission is held by owner, and nothing outside the vocabulary is held by anyone', () => {
    for (const permissions of Object.values(STORE_ROLE_PERMISSIONS)) {
      for (const permission of permissions) expect(STORE_PERMISSIONS).toContain(permission);
    }
  });

  it('store:manage is the owner’s alone', () => {
    const holders = Object.entries(STORE_ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes('store:manage'))
      .map(([role]) => role);
    expect(holders).toEqual(['owner']);
  });
});

describe('effectiveStorePermissions — (role defaults ∪ granted) − revoked', () => {
  it('adds a grant and removes a revoke', () => {
    const effective = effectiveStorePermissions('editor', {
      granted: ['refunds:write'],
      revoked: ['discounts:write'],
    });
    expect(effective).toContain('refunds:write');
    expect(effective).not.toContain('discounts:write');
    expect(effective).toContain('products:write');
  });

  it('a revoke beats a grant naming the same permission', () => {
    const effective = effectiveStorePermissions('viewer', {
      granted: ['analytics:read'],
      revoked: ['analytics:read'],
    });
    expect(effective).not.toContain('analytics:read');
  });

  it('keeps vocabulary order, so two sets compare meaningfully', () => {
    const effective = effectiveStorePermissions('viewer', { granted: ['store:manage'], revoked: [] });
    expect(effective[0]).toBe('store:manage');
  });
});

describe('requireStorePermission', () => {
  function run(access: StoreAccess | undefined, perm: StorePermission): MockRes & { nextCalled: boolean } {
    const res = mockRes() as MockRes & { nextCalled: boolean };
    res.nextCalled = false;
    requireStorePermission(perm)({ storeAccess: access } as unknown as Request, res, () => {
      res.nextCalled = true;
    });
    return res;
  }

  it('passes when the resolved permissions hold it', () => {
    expect(run({ role: 'editor', permissions: ['products:write'] }, 'products:write').nextCalled).toBe(true);
  });

  it('403s when they do not, naming the permission', () => {
    const res = run({ role: 'admin', permissions: [...STORE_ROLE_PERMISSIONS.admin] }, 'store:manage');
    expect(res.nextCalled).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0]?.[0]?.message).toContain('store:manage');
  });

  it('403s when loadStore attached nothing', () => {
    expect(run(undefined, 'products:read').status).toHaveBeenCalledWith(403);
  });
});

describe('loadStore', () => {
  it('400s a malformed id and 401s a request with no caller', async () => {
    const malformed = { ...request(ALICE), params: { storeId: 'nope' } } as unknown as Request;
    expect((await load(malformed)).status).toBe(400);
    expect((await load(request(undefined))).status).toBe(401);
  });

  it('404s an unknown store before asking Oxy anything', async () => {
    findStoreById.mockResolvedValue(null);
    expect((await load(request(ALICE))).status).toBe(404);
    expect(readCallerAccountRole).not.toHaveBeenCalled();
  });

  it('the owning account acting as itself is the owner, with no round trip', async () => {
    findStoreById.mockResolvedValue({ id: STORE_ID, oxyAccountId: ALICE });
    const { status, access } = await load(request(ALICE, { actorAccountId: ALICE, delegated: false }));
    expect(status).toBeNull();
    expect(access).toEqual({ role: 'owner', permissions: [...STORE_PERMISSIONS] });
    expect(readCallerAccountRole).not.toHaveBeenCalled();
  });

  it('a person operating the owning organization gets THEIR role, not ownership', async () => {
    // The session speaks as ORG, but Oxy authorizes it as Alice — an editor,
    // who holds account:act_as. Ownership here would hand her store:manage.
    readCallerAccountRole.mockResolvedValue('editor');
    const { access } = await load(request(ORG, { actorAccountId: ALICE, delegated: true }));
    expect(readCallerAccountRole).toHaveBeenCalledWith(`bearer-of-${ORG}`, ORG);
    expect(access?.role).toBe('editor');
    expect(access?.permissions).not.toContain('store:manage');
  });

  it('a member gets their role’s permissions, adjusted by their override', async () => {
    readCallerAccountRole.mockResolvedValue('editor');
    findStorePermissionOverride.mockResolvedValue({ granted: ['refunds:write'], revoked: ['discounts:write'] });
    const { access } = await load(request(ALICE, { actorAccountId: ALICE, delegated: false }));
    expect(findStorePermissionOverride).toHaveBeenCalledWith(STORE_ID, ALICE);
    expect(access?.permissions).toContain('refunds:write');
    expect(access?.permissions).not.toContain('discounts:write');
  });

  it('an override never admits somebody with no role', async () => {
    findStorePermissionOverride.mockResolvedValue({ granted: [...STORE_PERMISSIONS], revoked: [] });
    expect((await load(request(BOB, { actorAccountId: BOB, delegated: false }))).status).toBe(403);
  });

  it('FAILS CLOSED with a 503 when Oxy cannot answer', async () => {
    readCallerAccountRole.mockRejectedValue(serviceUnavailable('Oxy is down'));
    expect((await load(request(ALICE, { actorAccountId: ALICE, delegated: false }))).status).toBe(503);
  });

  it('reuses a role per ACTOR, and never shares one between two people', async () => {
    readCallerAccountRole.mockResolvedValue('admin');
    await load(request(ALICE, { actorAccountId: ALICE, delegated: false }));
    await load(request(ALICE, { actorAccountId: ALICE, delegated: false }));
    expect(readCallerAccountRole).toHaveBeenCalledTimes(1);

    // Bob operating the same organization is a different person: asked anew.
    readCallerAccountRole.mockResolvedValue(null);
    expect((await load(request(ORG, { actorAccountId: BOB, delegated: true }))).status).toBe(403);
    expect(readCallerAccountRole).toHaveBeenCalledTimes(2);
  });

  it('never caches a caller whose actor Oxy did not report', async () => {
    readCallerAccountRole.mockResolvedValue('admin');
    await load(request(ALICE));
    await load(request(ALICE));
    expect(readCallerAccountRole).toHaveBeenCalledTimes(2);
  });
});
