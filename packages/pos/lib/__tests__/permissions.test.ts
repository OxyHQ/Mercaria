/**
 * The POS's client-side permission mirror, executed (#469).
 *
 * ## Why this exists in BOTH apps rather than once
 *
 * `packages/pos/lib/permissions.ts` and `packages/dashboard/lib/permissions.ts`
 * are byte-identical copies of the backend's role → default-permission matrix,
 * and each is a separate package with its own `tsconfig.json`. Testing one and
 * trusting the other is precisely the assumption two copies exist to violate:
 * the copies drift one at a time, in unrelated PRs, and the second one is the
 * one nobody looks at. Each package checks the code IT compiles.
 *
 * ## What a test buys that nothing else here can
 *
 * The mirror's `ALL_PERMISSIONS` is typed `readonly StorePermission[]`, and a
 * SUBSET of a union is assignable to an array of it — so a permission added to
 * `@mercaria/shared-types` and to the backend matrix but omitted here is invisible
 * to `tsc`, to lint, to every scanning gate and to `expo export`. The register
 * simply never offers the affordance, to the store OWNER included, and the
 * natural diagnosis is a backend bug.
 *
 * Measured: `analytics:read` (#86) was missing from both mirrors. Fixed in the
 * change that adds this file.
 *
 * The table below transcribes the BACKEND's matrix — the authority
 * `lib/permissions.ts` names in its own docblock — rather than restating this
 * module, and its exhaustiveness is a `tsc` error rather than a count, so a
 * permission added later cannot pass by silence.
 */

import { describe, expect, it } from 'vitest';
import type { Store, StoreMember, StorePermission, StoreRole } from '@mercaria/shared-types';
import { effectivePermissions, findMembership, hasPermission } from '../permissions';

/** Which roles hold a permission BY DEFAULT, before explicit grants. */
interface RoleExpectation {
  readonly owner: boolean;
  readonly admin: boolean;
  readonly staff: boolean;
}

/**
 * `packages/backend/src/middleware/store-authz.ts`'s B7 matrix, transcribed.
 *
 * Annotated (not `satisfies`) so a missing key is a `tsc` error here.
 */
const BACKEND_MATRIX: Record<StorePermission, RoleExpectation> = {
  'store:manage': { owner: true, admin: false, staff: false },
  'members:manage': { owner: true, admin: true, staff: false },
  'settings:write': { owner: true, admin: true, staff: false },
  'discounts:write': { owner: true, admin: true, staff: false },
  'refunds:write': { owner: true, admin: true, staff: false },
  'locations:write': { owner: true, admin: true, staff: false },
  'collections:write': { owner: true, admin: true, staff: false },
  'channels:write': { owner: true, admin: true, staff: false },
  'analytics:read': { owner: true, admin: true, staff: false },
  'products:read': { owner: true, admin: true, staff: true },
  'products:write': { owner: true, admin: true, staff: true },
  'inventory:write': { owner: true, admin: true, staff: true },
  'orders:read': { owner: true, admin: true, staff: true },
  'orders:fulfill': { owner: true, admin: true, staff: true },
  'stats:read': { owner: true, admin: true, staff: true },
  'customers:read': { owner: true, admin: true, staff: true },
  'customers:write': { owner: true, admin: true, staff: true },
  'draft_orders:write': { owner: true, admin: true, staff: true },
};

/**
 * The counts the backend's docblock states in prose (18/18, 17/18, 9/18).
 *
 * Literals rather than sums over the table: derived from it they would agree
 * with any table at all. Two independent statements, so an edit must defeat both.
 */
const DOCUMENTED_COUNTS: Record<StoreRole, number> = { owner: 18, admin: 17, staff: 9 };

function expectedFor(role: StoreRole): string[] {
  return Object.entries(BACKEND_MATRIX)
    .filter(([, roles]) => roles[role])
    .map(([permission]) => permission)
    .sort();
}

function memberWith(role: StoreRole, grants: StorePermission[] = []): StoreMember {
  return { oxyUserId: 'oxy_member', role, permissions: grants, joinedAt: '2026-01-01T00:00:00.000Z' };
}

function actualFor(role: StoreRole, grants: StorePermission[] = []): string[] {
  return [...effectivePermissions(memberWith(role, grants))].sort();
}

const ROLES: readonly StoreRole[] = ['owner', 'admin', 'staff'];

describe('the POS mirror agrees with the backend role matrix', () => {
  for (const role of ROLES) {
    it(`${role} holds exactly the permissions the backend grants it`, () => {
      expect(actualFor(role)).toEqual(expectedFor(role));
    });

    it(`${role}'s default set is the documented size`, () => {
      expect(expectedFor(role)).toHaveLength(DOCUMENTED_COUNTS[role]);
      expect(actualFor(role)).toHaveLength(DOCUMENTED_COUNTS[role]);
    });
  }

  it('store:manage is the ONE permission an admin does not hold', () => {
    const admin = actualFor('admin');
    expect(actualFor('owner').filter((permission) => !admin.includes(permission))).toEqual([
      'store:manage',
    ]);
  });

  it('an owner holds every permission the type admits', () => {
    expect(actualFor('owner').sort()).toEqual(Object.keys(BACKEND_MATRIX).sort());
  });

  it('a staff member keeps the shop-floor set the register actually needs', () => {
    // The POS runs as staff far more often than the dashboard does, so these
    // four are the ones a narrowing of the staff row would strand mid-sale.
    for (const permission of ['products:read', 'orders:read', 'customers:write', 'draft_orders:write']) {
      expect(actualFor('staff')).toContain(permission);
    }
  });
});

describe('effective permissions are role defaults UNIONed with explicit grants', () => {
  it('an explicit grant adds to a staff default set without removing one', () => {
    const granted = actualFor('staff', ['refunds:write']);
    expect(granted).toContain('refunds:write');
    for (const permission of actualFor('staff')) {
      expect(granted).toContain(permission);
    }
  });

  it('a grant a role already holds changes nothing', () => {
    expect(actualFor('staff', ['products:read'])).toEqual(actualFor('staff'));
  });
});

describe('membership lookup', () => {
  const cashier = memberWith('staff');
  const store: Store = {
    id: 'store_1',
    handle: 'a-shop',
    name: 'Fixture',
    description: '',
    brandColor: '#000000',
    textTone: 'light',
    status: 'active',
    members: [cashier],
    policies: { returnWindowDays: 30 },
    defaultCurrency: 'FAIR',
    rating: 0,
    reviewCount: 0,
    productCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('finds a member by their Oxy account id', () => {
    expect(findMembership(store, 'oxy_member')).toEqual(cashier);
  });

  it('answers null for a non-member rather than the first member', () => {
    expect(findMembership(store, 'oxy_stranger')).toBeNull();
  });

  it('answers null when the store or the caller is absent', () => {
    expect(findMembership(undefined, 'oxy_member')).toBeNull();
    expect(findMembership(store, undefined)).toBeNull();
  });

  it('hasPermission refuses a caller with no membership', () => {
    expect(hasPermission(store, 'oxy_stranger', 'products:read')).toBe(false);
    expect(hasPermission(undefined, 'oxy_member', 'products:read')).toBe(false);
  });

  it('hasPermission reads the membership it finds, not the first one', () => {
    const twoMembers: Store = {
      ...store,
      members: [cashier, { ...memberWith('owner'), oxyUserId: 'oxy_owner' }],
    };
    expect(hasPermission(twoMembers, 'oxy_owner', 'refunds:write')).toBe(true);
    expect(hasPermission(twoMembers, 'oxy_member', 'refunds:write')).toBe(false);
  });
});
