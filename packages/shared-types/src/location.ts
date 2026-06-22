/**
 * Location DTOs for the Mercaria store-admin inventory surface.
 *
 * A `Location` is a physical or virtual place a STORE stocks inventory. Only
 * store-owned products use locations; individual P2P sellers do not. Every store
 * has exactly one default location (`isDefault`); setting a new default clears the
 * previous one server-side. Multi-location stock is exposed per-variant as
 * `InventoryLevelDTO` (see `./inventory`).
 */

import type { Timestamps } from './common';

/** The kind of place a location represents. */
export type LocationType = 'warehouse' | 'retail' | 'pop_up' | 'virtual';

/** An optional physical address attached to a location. */
export interface LocationAddress {
  /** Optional label (e.g. `Main warehouse`). */
  label?: string;
  /** Name of the on-site recipient/contact. */
  recipientName: string;
  /** Primary street line. */
  line1: string;
  /** Secondary street line (suite/unit). */
  line2?: string;
  /** City / locality. */
  city: string;
  /** State / province / region. */
  region?: string;
  /** Postal / ZIP code. */
  postalCode: string;
  /** ISO-3166 alpha-2 country code. */
  country: string;
  /** Contact phone. */
  phone?: string;
}

/** A place a store stocks inventory. */
export interface Location extends Timestamps {
  /** Stable location id. */
  id: string;
  /** Owning store id. */
  storeId: string;
  /** Display name of the location. */
  name: string;
  /** The kind of place this represents. */
  type: LocationType;
  /** Optional physical address. */
  address?: LocationAddress;
  /** Whether this is the store's default location (exactly one per store). */
  isDefault: boolean;
  /** Whether the location is active (inactive locations are not chosen for routing). */
  isActive: boolean;
  /** Whether this location fulfils online orders. */
  fulfillsOnlineOrders: boolean;
}

/** Body for `POST /admin/stores/:storeId/locations` — create a location. */
export interface CreateLocationInput {
  name: string;
  type?: LocationType;
  address?: LocationAddress;
  isDefault?: boolean;
  isActive?: boolean;
  fulfillsOnlineOrders?: boolean;
}

/** Body for `PATCH /admin/stores/:storeId/locations/:id` — partial update. */
export type UpdateLocationInput = Partial<CreateLocationInput>;
