/**
 * Address DTOs for the Mercaria buyer commerce flow.
 *
 * Addresses are scoped to an Oxy user and used as shipping destinations at
 * checkout (snapshotted onto the order). Exactly one address per user may be the
 * default (`isDefault`); setting a new default clears the previous one
 * server-side.
 */

import type { Timestamps } from './common';

/** A buyer's saved shipping address. */
export interface Address extends Timestamps {
  /** Stable address id. */
  id: string;
  /** Optional user-supplied label (e.g. `Home`, `Work`). */
  label?: string;
  /** Name of the recipient at this address. */
  recipientName: string;
  /** Primary street line. */
  line1: string;
  /** Secondary street line (apt/suite/unit). */
  line2?: string;
  /** City / locality. */
  city: string;
  /** State / province / region. */
  region?: string;
  /** Postal / ZIP code. */
  postalCode: string;
  /** ISO-3166 alpha-2 country code. */
  country: string;
  /** Contact phone for delivery. */
  phone?: string;
  /** Whether this is the user's default shipping address. */
  isDefault: boolean;
}

/** Body for `POST /addresses` — create a new address. */
export interface CreateAddressInput {
  label?: string;
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

/**
 * Body for `PATCH /addresses/:id` — partial update. `isDefault: true` promotes
 * this address to the default (clearing any previous default).
 */
export type UpdateAddressInput = Partial<CreateAddressInput> & {
  isDefault?: boolean;
};
