/**
 * Location model — a physical or virtual place a STORE stocks inventory.
 *
 * Only `ownerType: 'store'` listings use locations: a store variant stocks at N
 * locations through the standalone `InventoryLevel` collection, and the variant's
 * scalar `inventory.{available,committed}` is the denormalized ROLLUP across those
 * levels. Every store has exactly one `isDefault` location (created with the store
 * and by the migration backfill); single-location stores route all stock there.
 *
 * `storeId` is ALWAYS a String (the Store's id), never an ObjectId/ref. The
 * optional embedded `address` mirrors the order `AddressSnapshot` shape.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { LocationType } from '@mercaria/shared-types';

const LOCATION_TYPES: readonly LocationType[] = ['warehouse', 'retail', 'pop_up', 'virtual'];

export type { LocationType };

/** An optional physical address for a location (mirrors the order AddressSnapshot). */
export interface ILocationAddress {
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

export interface ILocation {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  name: string;
  type: LocationType;
  address?: ILocationAddress;
  isDefault: boolean;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const LocationAddressSchema = new Schema<ILocationAddress>(
  {
    label: { type: String },
    recipientName: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    region: { type: String },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
    phone: { type: String },
  },
  { _id: false },
);

const LocationSchema = new Schema<ILocation>(
  {
    storeId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: LOCATION_TYPES as string[], default: 'warehouse' },
    address: { type: LocationAddressSchema },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    fulfillsOnlineOrders: { type: Boolean, default: true },
  },
  { timestamps: true },
);

LocationSchema.index({ storeId: 1, isDefault: -1 });
LocationSchema.index({ storeId: 1, isActive: 1 });

export const Location: Model<ILocation> =
  mongoose.models.Location || mongoose.model<ILocation>('Location', LocationSchema);
