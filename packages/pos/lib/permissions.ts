import type {
  Store,
  StoreMember,
  StoreRole,
  StorePermission,
} from "@mercaria/shared-types";

/**
 * Client mirror of the backend role → default-permission matrix
 * (`packages/backend/src/middleware/store-authz.ts`). The server is the
 * authority for every gated write; this mirror exists ONLY to hide nav items /
 * actions the caller could not perform anyway, so the UI doesn't surface
 * affordances that would 403. Keep this in lockstep with the backend matrix.
 *
 * `__tests__/permissions.test.ts` is what keeps it there. A permission added to
 * `StorePermission` and omitted here type-checks (a subset is assignable to
 * `readonly StorePermission[]`), so the drift is invisible to `tsc`, lint, every
 * scanning gate and the export — and it hides the affordance from the store
 * OWNER, who is the one member certain to hold it. `analytics:read` (#86) was
 * missing here until #469.
 */
const ALL_PERMISSIONS: readonly StorePermission[] = [
  "store:manage",
  "members:manage",
  "products:read",
  "products:write",
  "inventory:write",
  "locations:write",
  "collections:write",
  "discounts:write",
  "settings:write",
  "orders:read",
  "orders:fulfill",
  "stats:read",
  "customers:read",
  "customers:write",
  "draft_orders:write",
  "refunds:write",
  "channels:write",
  "analytics:read",
];

const ADMIN_PERMISSIONS: readonly StorePermission[] = ALL_PERMISSIONS.filter(
  (p) => p !== "store:manage",
);

const STAFF_PERMISSIONS: readonly StorePermission[] = [
  "products:read",
  "products:write",
  "inventory:write",
  "orders:read",
  "orders:fulfill",
  "stats:read",
  "customers:read",
  "customers:write",
  "draft_orders:write",
];

const ROLE_PERMISSIONS: Record<StoreRole, readonly StorePermission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  staff: STAFF_PERMISSIONS,
};

/** A member's effective permission set: role defaults ∪ explicit grants. */
export function effectivePermissions(member: StoreMember): Set<StorePermission> {
  const effective = new Set<StorePermission>(ROLE_PERMISSIONS[member.role]);
  for (const perm of member.permissions) {
    effective.add(perm);
  }
  return effective;
}

/** Find the caller's membership on a store, or null when they're not a member. */
export function findMembership(
  store: Store | undefined,
  oxyUserId: string | undefined,
): StoreMember | null {
  if (!store || !oxyUserId) {
    return null;
  }
  return store.members.find((m) => m.oxyUserId === oxyUserId) ?? null;
}

/** Whether the caller holds `permission` on `store`. */
export function hasPermission(
  store: Store | undefined,
  oxyUserId: string | undefined,
  permission: StorePermission,
): boolean {
  const membership = findMembership(store, oxyUserId);
  if (!membership) {
    return false;
  }
  return effectivePermissions(membership).has(permission);
}
