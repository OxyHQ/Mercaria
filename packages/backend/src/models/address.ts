/**
 * Address model — a buyer's saved shipping address, keyed by Oxy user id.
 *
 * Used as the shipping destination at checkout (snapshotted onto the order).
 * Exactly one address per user may carry `isDefault: true`; the compound
 * `{oxyUserId, isDefault:-1, createdAt:-1}` index lets the service resolve "the
 * user's default" (or newest) in one indexed read. Promotion of a new default
 * (clearing the old one) is handled in `address.service`.
 */

import mongoose, { Schema, Model } from 'mongoose';

export interface IAddress {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  label?: string;
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema<IAddress>(
  {
    oxyUserId: { type: String, required: true },
    label: { type: String },
    recipientName: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    region: { type: String },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
    phone: { type: String },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

AddressSchema.index({ oxyUserId: 1, isDefault: -1, createdAt: -1 });

export const Address: Model<IAddress> =
  mongoose.models.Address || mongoose.model<IAddress>('Address', AddressSchema);
