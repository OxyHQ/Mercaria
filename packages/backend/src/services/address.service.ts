/**
 * Address service — the buyer's saved shipping addresses.
 *
 * All operations are scoped to `oxyUserId`. The single-default invariant lives
 * here: promoting an address to `isDefault: true` first clears the previous
 * default for that user, so at most one default ever exists. The first address
 * a user creates becomes their default automatically.
 */

import type {
  Address as AddressDTO,
  CreateAddressInput,
  UpdateAddressInput,
} from '@mercaria/shared-types';
import { Address, type IAddress } from '../models/address.js';
import { notFound } from '../lib/errors/error-codes.js';

/** Serialize an `IAddress` document to the wire `Address` DTO. */
function toDTO(doc: IAddress): AddressDTO {
  const dto: AddressDTO = {
    id: String(doc._id),
    recipientName: doc.recipientName,
    line1: doc.line1,
    city: doc.city,
    postalCode: doc.postalCode,
    country: doc.country,
    isDefault: doc.isDefault,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  if (doc.label !== undefined) dto.label = doc.label;
  if (doc.line2 !== undefined) dto.line2 = doc.line2;
  if (doc.region !== undefined) dto.region = doc.region;
  if (doc.phone !== undefined) dto.phone = doc.phone;
  return dto;
}

/** Clear the `isDefault` flag on every OTHER address of the user. */
async function clearOtherDefaults(oxyUserId: string, exceptId?: string): Promise<void> {
  const filter: Record<string, unknown> = { oxyUserId, isDefault: true };
  if (exceptId) {
    filter._id = { $ne: exceptId };
  }
  await Address.updateMany(filter, { $set: { isDefault: false } });
}

/** List the buyer's addresses, default first then newest. */
export async function list(oxyUserId: string): Promise<AddressDTO[]> {
  const docs = await Address.find({ oxyUserId })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean<IAddress[]>();
  return docs.map(toDTO);
}

/**
 * Create an address for the buyer. The user's FIRST address becomes their
 * default automatically; subsequent ones default to non-default.
 */
export async function create(
  oxyUserId: string,
  input: CreateAddressInput,
): Promise<AddressDTO> {
  const hasExisting = await Address.exists({ oxyUserId });
  const isDefault = hasExisting === null;

  const doc = await Address.create({
    oxyUserId,
    label: input.label,
    recipientName: input.recipientName,
    line1: input.line1,
    line2: input.line2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    country: input.country,
    phone: input.phone,
    isDefault,
  });

  return toDTO(doc.toObject());
}

/**
 * Update an address (scoped to the buyer). Setting `isDefault: true` promotes
 * this address and clears the previous default. Setting it `false` is allowed
 * but does not auto-promote another address.
 */
export async function update(
  oxyUserId: string,
  addressId: string,
  patch: UpdateAddressInput,
): Promise<AddressDTO> {
  const doc = await Address.findOne({ _id: addressId, oxyUserId });
  if (!doc) {
    throw notFound('Address not found');
  }

  if (patch.label !== undefined) doc.label = patch.label;
  if (patch.recipientName !== undefined) doc.recipientName = patch.recipientName;
  if (patch.line1 !== undefined) doc.line1 = patch.line1;
  if (patch.line2 !== undefined) doc.line2 = patch.line2;
  if (patch.city !== undefined) doc.city = patch.city;
  if (patch.region !== undefined) doc.region = patch.region;
  if (patch.postalCode !== undefined) doc.postalCode = patch.postalCode;
  if (patch.country !== undefined) doc.country = patch.country;
  if (patch.phone !== undefined) doc.phone = patch.phone;

  if (patch.isDefault === true) {
    await clearOtherDefaults(oxyUserId, addressId);
    doc.isDefault = true;
  } else if (patch.isDefault === false) {
    doc.isDefault = false;
  }

  await doc.save();
  return toDTO(doc.toObject());
}

/**
 * Remove an address (scoped to the buyer). If the removed address was the
 * default, the user's newest remaining address (if any) is promoted to default
 * so the buyer always has a default when at least one address exists.
 */
export async function remove(oxyUserId: string, addressId: string): Promise<void> {
  const doc = await Address.findOne({ _id: addressId, oxyUserId }).lean<IAddress | null>();
  if (!doc) {
    throw notFound('Address not found');
  }

  await Address.deleteOne({ _id: addressId, oxyUserId });

  if (doc.isDefault) {
    const next = await Address.findOne({ oxyUserId }).sort({ createdAt: -1 });
    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }
}
