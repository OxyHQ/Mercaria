/**
 * Store (shop) admin-facing DTOs for the Mercaria.
 *
 * A `Store` is a seller organization that lists NEW products (Shop/Amazon side),
 * as opposed to an individual P2P seller (`Seller`). This module holds the
 * ADMIN-facing shapes (ownership, permissions, policies). The PUBLIC projection of
 * a store rendered in browse/feed surfaces is `StoreSummary` in `./product`.
 */

import type { Timestamps } from './common';
import type { CurrencyCode } from './money';
import type { TextTone } from './product';
import type { TaxSettings, UpdateTaxSettingsInput } from './tax';

/**
 * Every granular permission a store can hold — the closed set, and the ONE
 * authority for it. The backend renders the CHECK on
 * `store_permission_overrides.granted`/`.revoked` from this tuple and validates
 * request bodies against it, so a permission added here reaches the database,
 * the validator and the role map below together.
 */
export const STORE_PERMISSIONS = [
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'locations:write',
  'collections:write',
  'discounts:write',
  'settings:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
  'customers:read',
  'customers:write',
  'draft_orders:write',
  'refunds:write',
  'channels:write',
  /**
   * Merchant DEMAND analytics (#86 privacy 3) — deliberately NOT `stats:read`.
   *
   * `stats:read` answers "how did my shop trade": my orders, my products, my
   * customers, all of them facts about transactions this store already has.
   * This answers "what is the market doing around my products": how often
   * Mercaria showed them, how many visits it sent, which of them have demand
   * and no offer. That is a commercial-strategy surface rather than a
   * shop-floor one, and #86 asks for an EXPLICIT permission — so only `owner`,
   * `admin` and `billing` hold it by default, and anyone else needs a grant.
   */
  'analytics:read',
] as const;

/** A granular permission on a store. */
export type StorePermission = (typeof STORE_PERMISSIONS)[number];

/**
 * The roles an Oxy account membership carries (`AccountRole` in
 * `@oxy.so/core`). A store is owned by an Oxy account (ADR 0012) and Oxy decides
 * who belongs to it and in which role; Mercaria only maps that role onto its own
 * permissions. The backend asserts at compile time that this tuple is exactly
 * Oxy's, so a role Oxy adds fails `tsc` here instead of resolving to nothing.
 */
export const STORE_ACCOUNT_ROLES = ['owner', 'admin', 'editor', 'developer', 'billing', 'viewer'] as const;

/** The caller's role in the Oxy account that owns a store. */
export type StoreAccountRole = (typeof STORE_ACCOUNT_ROLES)[number];

/** Every permission except `store:manage`, the one an `admin` does not hold. */
const ADMIN_STORE_PERMISSIONS = STORE_PERMISSIONS.filter((p) => p !== 'store:manage');

/**
 * Oxy account role → the store permissions it holds by default. The ONE map;
 * no client keeps a copy, because the API returns each caller's resolved
 * permissions on the store itself (`Store.access`).
 *
 * | permission         | owner | admin | editor | developer | billing | viewer |
 * |--------------------|:-----:|:-----:|:------:|:---------:|:-------:|:------:|
 * | store:manage       |   ✓   |       |        |           |         |        |
 * | members:manage     |   ✓   |   ✓   |        |           |         |        |
 * | settings:write     |   ✓   |   ✓   |        |           |         |        |
 * | refunds:write      |   ✓   |   ✓   |        |           |         |        |
 * | channels:write     |   ✓   |   ✓   |        |     ✓     |         |        |
 * | analytics:read     |   ✓   |   ✓   |        |           |    ✓    |        |
 * | discounts:write    |   ✓   |   ✓   |   ✓    |           |         |        |
 * | locations:write    |   ✓   |   ✓   |   ✓    |           |         |        |
 * | collections:write  |   ✓   |   ✓   |   ✓    |           |         |        |
 * | products:write     |   ✓   |   ✓   |   ✓    |           |         |        |
 * | inventory:write    |   ✓   |   ✓   |   ✓    |           |         |        |
 * | orders:fulfill     |   ✓   |   ✓   |   ✓    |           |         |        |
 * | customers:read     |   ✓   |   ✓   |   ✓    |           |         |        |
 * | customers:write    |   ✓   |   ✓   |   ✓    |           |         |        |
 * | draft_orders:write |   ✓   |   ✓   |   ✓    |           |         |        |
 * | products:read      |   ✓   |   ✓   |   ✓    |     ✓     |         |   ✓    |
 * | orders:read        |   ✓   |   ✓   |   ✓    |           |    ✓    |   ✓    |
 * | stats:read         |   ✓   |   ✓   |   ✓    |           |    ✓    |   ✓    |
 *
 * - `editor` runs the catalogue AND the shop floor. It carries the six
 *   operational permissions the retired `staff` role held (fulfil orders, serve
 *   customers, ring up POS draft orders, read the shop's own stats) on top of
 *   catalogue upkeep, because `staff` is the role every existing non-owner
 *   member holds and Oxy has no `staff`: converting a store to an organization
 *   maps `staff` to `editor`, and an editor who could not ring up a sale would
 *   strand every POS cashier the conversion moves.
 * - `developer` connects sales channels and reads the catalogue it syncs.
 * - `billing` reads money in (orders, stats, demand analytics). Payment
 *   onboarding and fee acceptance are `store:manage` (a binding commercial act)
 *   and refunds move money out, so neither is billing's by default.
 * - `viewer` is read-only, and only for the shop's own trading record: it does
 *   NOT read customers (buyer personal data) or demand analytics (#86 asks for
 *   an explicit grant).
 */
export const STORE_ROLE_PERMISSIONS: Readonly<Record<StoreAccountRole, readonly StorePermission[]>> = {
  owner: STORE_PERMISSIONS,
  admin: ADMIN_STORE_PERMISSIONS,
  editor: [
    'products:read',
    'products:write',
    'inventory:write',
    'collections:write',
    'locations:write',
    'discounts:write',
    'orders:read',
    'orders:fulfill',
    'stats:read',
    'customers:read',
    'customers:write',
    'draft_orders:write',
  ],
  developer: ['channels:write', 'products:read'],
  billing: ['stats:read', 'analytics:read', 'orders:read'],
  viewer: ['products:read', 'orders:read', 'stats:read'],
};

/** A per-person exception to the role map: what to add, and what to take away. */
export interface StorePermissionDelta {
  granted: readonly StorePermission[];
  revoked: readonly StorePermission[];
}

/**
 * A role's effective permissions: `(role defaults ∪ granted) − revoked`, in
 * {@link STORE_PERMISSIONS} order. A revoke beats a grant naming the same
 * permission — the two disagreeing can only be a mistake, and the narrower
 * reading is the safe one (Oxy resolves its own member deltas the same way).
 */
export function effectiveStorePermissions(
  role: StoreAccountRole,
  delta: StorePermissionDelta | null,
): StorePermission[] {
  const held = new Set<StorePermission>(STORE_ROLE_PERMISSIONS[role]);
  for (const permission of delta?.granted ?? []) held.add(permission);
  for (const permission of delta?.revoked ?? []) held.delete(permission);
  return STORE_PERMISSIONS.filter((permission) => held.has(permission));
}

/**
 * What the CALLER may do on a store, resolved by the API: their role in the
 * owning Oxy account and the permissions that role plus their override yields.
 * Clients gate affordances on `permissions`; the server authorizes every write.
 */
export interface StoreAccess {
  role: StoreAccountRole;
  permissions: StorePermission[];
}

/** One per-person permission exception on a store (`store_permission_overrides`). */
export interface StorePermissionOverride extends StorePermissionDelta {
  /** The Oxy account (a person) the exception applies to. */
  oxyUserId: string;
  granted: StorePermission[];
  revoked: StorePermission[];
  /** The Oxy account that last wrote it, when Oxy reported the actor. */
  updatedByOxyUserId: string | null;
  /** ISO-8601. */
  updatedAt: string;
}

/** Body of `PUT /admin/stores/:storeId/permission-overrides/:oxyUserId`. */
export interface SetStorePermissionOverrideInput {
  granted: StorePermission[];
  revoked: StorePermission[];
}

/** Body of `PATCH /admin/stores/:storeId/owner-account`. */
export interface TransferStoreOwnerAccountInput {
  /** The Oxy account (usually `kind=organization`) that will own the store. */
  oxyAccountId: string;
}

/**
 * Store-wide policy documents + the return window. `returnWindowDays` and
 * `shippingNote` predate B7; the three long-form policy bodies are added in B7.
 */
export interface StorePolicies {
  /** Return window in days. */
  returnWindowDays: number;
  /** Optional free-form shipping note. */
  shippingNote?: string;
  /** Long-form refund policy body, when set. */
  refundPolicy?: string;
  /** Long-form privacy policy body, when set. */
  privacyPolicy?: string;
  /** Long-form terms-of-service body, when set. */
  termsOfService?: string;
}

/**
 * Store notification preferences (B7). Controls the store-facing alerts the
 * backend may raise; defaults are on so a store opts OUT rather than in.
 */
export interface StoreNotificationSettings {
  /** Whether to raise low-stock alerts for tracked variants. */
  lowStockAlerts: boolean;
  /** Whether to send the store order-confirmation/update emails. */
  orderEmails: boolean;
  /**
   * Per-store low-stock threshold override (units `available` at or below which
   * a tracked variant is "low stock"). Absent ⇒ the platform default applies.
   */
  lowStockThreshold?: number;
}

/** A seller organization (shop). */
export interface Store extends Timestamps {
  /** Stable store id. */
  id: string;
  /** Unique handle (without leading @), used to build the `/m/<handle>` route. */
  handle: string;
  /** Display name of the shop. */
  name: string;
  /** Long-form store description. */
  description: string;
  /** Oxy media file id (or absolute URL) of the store logo/wordmark. */
  logoFileId?: string;
  /** Oxy media file id (or absolute URL) of the store cover image. */
  coverFileId?: string;
  /** Solid brand color (full CSS color string, e.g. `#1D4ED8`). */
  brandColor: string;
  /** Which text tone reads best over this store's brand color/cover. */
  textTone: TextTone;
  /** Lifecycle status. */
  status: 'active' | 'suspended' | 'closed';
  /**
   * The Oxy account that owns the store — usually `kind=organization`. Who may
   * act for the store is that account's membership, which Oxy owns (ADR 0012).
   */
  oxyAccountId: string;
  /** The caller's own access to this store. */
  access: StoreAccess;
  /** Store-wide policies. */
  policies: StorePolicies;
  /** Default currency for new products in this store. */
  defaultCurrency: CurrencyCode;
  /**
   * Store-level tax behavior. Optional for back-compat reads (stores created
   * before B4 may lack it; the API falls back to defaults).
   */
  taxSettings?: TaxSettings;
  /**
   * Store notification preferences. Optional for back-compat reads (stores
   * created before B7 may lack it; the API falls back to the on-by-default shape).
   */
  notificationSettings?: StoreNotificationSettings;
  /** Aggregate rating, 0–5. */
  rating: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount: number;
  /** Number of active products the store has listed. */
  productCount: number;
}

/** Payload accepted when creating a new store. */
export interface CreateStoreInput {
  /**
   * The Oxy account that will own the store. Omitted: the caller's effective
   * account. Naming another account requires the caller to be its owner or admin.
   */
  oxyAccountId?: string;
  name: string;
  description?: string;
  brandColor?: string;
  logoFileId?: string;
  coverFileId?: string;
  defaultCurrency?: CurrencyCode;
}

/** Partial policy payload accepted by the core update + settings update paths. */
export type UpdateStorePoliciesInput = {
  returnWindowDays?: number;
  shippingNote?: string;
  refundPolicy?: string;
  privacyPolicy?: string;
  termsOfService?: string;
};

/** Partial notification-settings payload accepted by the settings update path. */
export type UpdateStoreNotificationSettingsInput = Partial<StoreNotificationSettings>;

/** Partial payload accepted when updating an existing store's core profile. */
export type UpdateStoreInput = Partial<Omit<CreateStoreInput, 'oxyAccountId'>> & {
  textTone?: TextTone;
  policies?: UpdateStorePoliciesInput;
  status?: Store['status'];
  taxSettings?: UpdateTaxSettingsInput;
};

/**
 * Partial payload accepted by `PATCH /admin/stores/:storeId/settings` (B7).
 * Updates the store's policies, notification preferences and (optionally) tax
 * settings in one call. At least one field must be supplied.
 */
export interface UpdateStoreSettingsInput {
  policies?: UpdateStorePoliciesInput;
  notificationSettings?: UpdateStoreNotificationSettingsInput;
  taxSettings?: UpdateTaxSettingsInput;
}

