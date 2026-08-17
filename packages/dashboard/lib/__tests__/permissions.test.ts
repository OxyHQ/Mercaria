/**
 * The dashboard's client-side permission mirror, executed (#469).
 *
 * ## What this file is actually for
 *
 * `lib/permissions.ts` says of itself: "Client mirror of the backend role →
 * default-permission matrix (`packages/backend/src/middleware/store-authz.ts`).
 * … Keep this in lockstep with the backend matrix." Nothing kept it. A
 * permission added to `StorePermission` and to the backend matrix but not to
 * this mirror is invisible to every check this repository runs: the mirror's
 * `ALL_PERMISSIONS` is typed `readonly StorePermission[]`, and a SUBSET of a
 * union is perfectly assignable to an array of it, so `tsc` has nothing to say.
 * Lint, the four scanning gates and `expo export` are all equally blind — the
 * file is valid TypeScript that compiles to a working array.
 *
 * The failure it produces is quiet and points the wrong way: `effectivePermissions`
 * returns a set that is missing the permission, `useActiveStoreContext().can(...)`
 * answers `false`, and the affordance is hidden from the store OWNER — the one
 * member guaranteed to hold it. Nobody sees an error; a merchant sees a screen
 * that does not offer them something they are entitled to, and the natural
 * diagnosis is a backend bug.
 *
 * This file found exactly that: `analytics:read` (#86 merchant demand analytics)
 * was in `StorePermission` and in the backend's `ROLE_PERMISSIONS` for `owner`
 * and `admin`, and in neither client mirror. It is fixed in the same change that
 * adds this test.
 *
 * ## Why the table below is not a re-implementation
 *
 * A test that restates the code under test measures the restatement. This
 * restates the BACKEND's matrix — the authority `lib/permissions.ts` names in
 * its own docblock — which is a genuinely independent second source, and the
 * only way a mirror can be checked at all without importing across a package
 * boundary the `rootDir` decision forbids.
 *
 * Its exhaustiveness is enforced by the TYPE SYSTEM rather than by a count:
 * annotated `Record<StorePermission, RoleExpectation>`, so a permission added to
 * `@mercaria/shared-types` fails `tsc` HERE until somebody states which roles
 * hold it. That is the point — the census must not be satisfiable by silence,
 * and finding fewer permissions must never look the same as there being fewer.
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
 * Annotated (not `satisfies`) so a missing key is a `tsc` error rather than an
 * inferred narrower type.
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
 * The counts the backend's own docblock states in prose (18/18, 17/18, 9/18).
 *
 * Deliberately literals rather than sums over the table: derived from it they
 * would agree with any table at all, including one edited to match a broken
 * mirror. This is the vacuity floor — two independent statements of one fact,
 * and an edit has to defeat both.
 */
const DOCUMENTED_COUNTS: Record<StoreRole, number> = { owner: 18, admin: 17, staff: 9 };

/** Sorted plain strings, so a comparison needs no cast in either direction. */
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

describe('the client mirror agrees with the backend role matrix', () => {
  for (const role of ROLES) {
    it(`${role} holds exactly the permissions the backend grants it`, () => {
      expect(actualFor(role)).toEqual(expectedFor(role));
    });

    it(`${role}'s default set is the documented size`, () => {
      // Guards the table itself: transcribing a row wrongly changes a count.
      expect(expectedFor(role)).toHaveLength(DOCUMENTED_COUNTS[role]);
      expect(actualFor(role)).toHaveLength(DOCUMENTED_COUNTS[role]);
    });
  }

  it('store:manage is the ONE permission an admin does not hold', () => {
    const owner = new Set(actualFor('owner'));
    const missingFromAdmin = [...owner].filter((permission) => !actualFor('admin').includes(permission));
    expect(missingFromAdmin).toEqual(['store:manage']);
  });

  it('an owner holds every permission the type admits', () => {
    // The census's positive control: `Object.keys` of an exhaustively-typed
    // Record IS the full union, so this cannot pass by finding fewer.
    expect(actualFor('owner').sort()).toEqual(Object.keys(BACKEND_MATRIX).sort());
  });
});

describe('effective permissions are role defaults UNIONed with explicit grants', () => {
  it('an explicit grant adds to a staff default set', () => {
    const granted = effectivePermissions(memberWith('staff', ['refunds:write']));
    expect(granted.has('refunds:write')).toBe(true);
    expect(granted.has('products:read')).toBe(true);
  });

  it('a grant a role already holds changes nothing', () => {
    expect(actualFor('staff', ['products:read'])).toEqual(actualFor('staff'));
  });

  it('a grant never removes a default', () => {
    const staff = new Set(actualFor('staff'));
    for (const permission of actualFor('staff', ['refunds:write'])) {
      staff.add(permission);
    }
    expect([...staff].sort()).toEqual(actualFor('staff', ['refunds:write']));
  });

  it('a staff member does not read market demand analytics by default', () => {
    // The distinction #86 draws: `stats:read` is "how did my shop trade",
    // `analytics:read` is "what is the market doing". Staff hold the first.
    expect(actualFor('staff')).toContain('stats:read');
    expect(actualFor('staff')).not.toContain('analytics:read');
  });
});

describe('membership lookup', () => {
  const owner = memberWith('owner');
  const store: Store = {
    id: 'store_1',
    handle: 'a-shop',
    name: 'Fixture',
    description: '',
    brandColor: '#000000',
    textTone: 'light',
    status: 'active',
    members: [owner],
    policies: { returnWindowDays: 30 },
    defaultCurrency: 'FAIR',
    rating: 0,
    reviewCount: 0,
    productCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('finds a member by their Oxy account id', () => {
    expect(findMembership(store, 'oxy_member')).toEqual(owner);
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
    const twoMembers: Store = { ...store, members: [memberWith('staff'), { ...owner, oxyUserId: 'oxy_owner' }] };
    expect(hasPermission(twoMembers, 'oxy_owner', 'store:manage')).toBe(true);
    expect(hasPermission(twoMembers, 'oxy_member', 'store:manage')).toBe(false);
  });
});
