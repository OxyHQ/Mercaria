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
  | 'refunds:write';

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
  policies: {
    /** Return window in days. */
    returnWindowDays: number;
    /** Optional free-form shipping note. */
    shippingNote?: string;
  };
  /** Default currency for new products in this store. */
  defaultCurrency: CurrencyCode;
  /**
   * Store-level tax behavior. Optional for back-compat reads (stores created
   * before B4 may lack it; the API falls back to defaults).
   */
  taxSettings?: TaxSettings;
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

/** Partial payload accepted when updating an existing store. */
export type UpdateStoreInput = Partial<CreateStoreInput> & {
  textTone?: TextTone;
  policies?: {
    returnWindowDays?: number;
    shippingNote?: string;
  };
  status?: Store['status'];
  taxSettings?: UpdateTaxSettingsInput;
};

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
