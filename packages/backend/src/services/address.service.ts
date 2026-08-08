/**
 * Address service — the buyer's saved shipping addresses.
 *
 * All operations are scoped to `oxyUserId`. The first address a buyer creates
 * becomes their default automatically; promoting a later one clears the previous
 * default.
 *
 * ## Ported to Postgres — the single-default rule stopped being a convention
 *
 * `addresses_oxy_user_id_default_key` is a partial unique index on
 * `(oxy_user_id) WHERE is_default`, so two defaults for one buyer are no longer
 * representable. That moves three things out of this service and into the
 * repository, where they belong with the constraint they have to satisfy:
 *
 *  - **The demote and the promote are ONE transaction.** Mongo ran them as two
 *    independent statements, so a half-finished promotion could persist — a buyer
 *    with two defaults, or with none. Postgres checks the index per statement, so
 *    demote-then-promote inside one transaction is fine and either half alone is
 *    not.
 *  - **Delete-and-promote is one transaction too**, and the delete decides
 *    existence itself (`DELETE … RETURNING`) instead of a read followed by a
 *    write that two concurrent callers could both reach.
 *  - **"The first address is the default" is settled against the index.** It is a
 *    read-then-write with no row to lock, so the repository resolves the residual
 *    race by re-inserting as non-default — losing it means the address was not
 *    first.
 *
 * The absent/NULL distinction is the other change: Mongo left an unset optional
 * field ABSENT and Postgres stores NULL, so {@link toDTO} omits a field that is
 * null rather than emitting `null` for it. An empty string is never written —
 * it is a real value and would print a blank line on a shipping label.
 */

import type {
  Address as AddressDTO,
  CreateAddressInput,
  UpdateAddressInput,
} from '@mercaria/shared-types';
import {
  deleteAddress,
  findAddressesByUser,
  insertAddress,
  updateAddress,
  type AddressRecord,
} from '../db/buyers/addressRepository.js';
import { notFound } from '../lib/errors/error-codes.js';

/** Serialize an `addresses` row to the wire `Address` DTO. */
function toDTO(row: AddressRecord): AddressDTO {
  const dto: AddressDTO = {
    id: row.id,
    recipientName: row.recipientName,
    line1: row.line1,
    city: row.city,
    postalCode: row.postalCode,
    country: row.country,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // NULL is what Mongo left ABSENT, so an unset field stays off the DTO rather
  // than arriving as an explicit null the client would have to special-case.
  if (row.label !== null) dto.label = row.label;
  if (row.line2 !== null) dto.line2 = row.line2;
  if (row.region !== null) dto.region = row.region;
  if (row.phone !== null) dto.phone = row.phone;
  return dto;
}

/** List the buyer's addresses, default first then newest. */
export async function list(oxyUserId: string): Promise<AddressDTO[]> {
  const rows = await findAddressesByUser(oxyUserId);
  return rows.map(toDTO);
}

/**
 * Create an address for the buyer. The buyer's FIRST address becomes their
 * default automatically; subsequent ones do not.
 */
export async function create(
  oxyUserId: string,
  input: CreateAddressInput,
): Promise<AddressDTO> {
  return toDTO(await insertAddress(oxyUserId, input));
}

/**
 * Update an address (scoped to the buyer). Setting `isDefault: true` promotes
 * this address and clears the previous default. Setting it `false` is allowed
 * but does not auto-promote another address — a buyer may deliberately have no
 * default, and choosing one for them would override what they just did.
 */
export async function update(
  oxyUserId: string,
  addressId: string,
  patch: UpdateAddressInput,
): Promise<AddressDTO> {
  const row = await updateAddress(oxyUserId, addressId, patch);
  if (!row) {
    throw notFound('Address not found');
  }
  return toDTO(row);
}

/**
 * Remove an address (scoped to the buyer). If the removed address was the
 * default, the buyer's newest remaining address (if any) is promoted so they
 * always have a default while at least one address exists.
 */
export async function remove(oxyUserId: string, addressId: string): Promise<void> {
  const { deleted } = await deleteAddress(oxyUserId, addressId);
  if (!deleted) {
    throw notFound('Address not found');
  }
}
