/**
 * Store (shop) admin-facing DTOs for the Mercaria.
 *
 * A `Store` is a seller organization that lists NEW products (Shop/Amazon side),
 * as opposed to an individual P2P seller (`Seller`). This module holds the
 * ADMIN-facing shapes (members, permissions, policies). The PUBLIC projection of
 * a store rendered in browse/feed surfaces is `MerchantSummary` in `./product`.
 */

import type { Timestamps } from './common';
import type { CurrencyCode } from './money';
import type { TextTone } from './product';
import type { TaxSettings, UpdateTaxSettingsInput } from './tax';

/** A member's role within a store. */
export type StoreRole = 'owner' | 'admin' | 'staff';

/** A granular permission a store member can hold. */
export type StorePermission =
  | 'store:manage'
  | 'members:manage'
  | 'products:read'
  | 'products:write'
  | 'inventory:write'
  | 'locations:write'
  | 'collections:write'
  | 'discounts:write'
  | 'settings:write'
  | 'orders:read'
  | 'orders:fulfill'
  | 'stats:read'
  | 'customers:read'
  | 'customers:write'
  | 'draft_orders:write'
  | 'refunds:write'
  | 'channels:write';

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

/** A member of a store, backed by an Oxy user account. */
export interface StoreMember {
  /** Owning Oxy user account id. */
  oxyUserId: string;
  /** Role within the store. */
  role: StoreRole;
  /** Granular permissions granted to this member. */
  permissions: StorePermission[];
  /** ISO-8601 time the member joined the store. */
  joinedAt: string;
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
  /** Store members and their roles. */
  members: StoreMember[];
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
export type UpdateStoreInput = Partial<CreateStoreInput> & {
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

/** Payload accepted when inviting a member to a store. */
export interface InviteMemberInput {
  oxyUserId: string;
  role: StoreRole;
  permissions?: StorePermission[];
}

/** Partial payload accepted when updating a store member's role/permissions. */
export interface UpdateMemberInput {
  role?: StoreRole;
  permissions?: StorePermission[];
}
