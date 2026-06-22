/**
 * ProductVariant model — a concrete buyable SKU of a `Listing`.
 *
 * P2P listings have exactly one default variant; store products may have many.
 * Inventory carries `available` and `committed` (units reserved by pending
 * orders); `committed` is NEVER exposed on the wire. The `levels` array is a
 * FUTURE multi-location inventory seam — defined here but unused in F1.
 */

import mongoose, { Schema, Model } from 'mongoose';
import { MoneySchema } from './schemas/money-schema.js';

export interface IVariantOptionValue {
  name: string;
  value: string;
}

export interface IInventoryLevel {
  locationId: string;
  available: number;
  committed: number;
}

export interface IProductVariant {
  _id: mongoose.Types.ObjectId;
  listingId: string;
  title: string;
  optionValues: IVariantOptionValue[];
  sku?: string;
  price: { amount: number; currency: string };
  compareAtPrice?: { amount: number; currency: string };
  inventory: {
    tracked: boolean;
    available: number;
    committed: number;
    /** FUTURE multi-location seam — empty/unused in F1. */
    levels?: IInventoryLevel[];
  };
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const VariantOptionValueSchema = new Schema<IVariantOptionValue>(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const InventoryLevelSchema = new Schema<IInventoryLevel>(
  {
    locationId: { type: String, required: true },
    available: { type: Number, default: 0 },
    committed: { type: Number, default: 0 },
  },
  { _id: false },
);

const ProductVariantSchema = new Schema<IProductVariant>(
  {
    listingId: { type: String, required: true },
    title: { type: String, default: 'Default Title' },
    optionValues: { type: [VariantOptionValueSchema], default: [] },
    sku: { type: String },
    price: { type: MoneySchema, required: true },
    compareAtPrice: { type: MoneySchema },
    inventory: {
      tracked: { type: Boolean, default: true },
      available: { type: Number, default: 0 },
      committed: { type: Number, default: 0 },
      levels: { type: [InventoryLevelSchema], default: [] },
    },
    position: { type: Number, default: 0 },
  },
  { timestamps: true },
);

ProductVariantSchema.index({ listingId: 1, position: 1 });
ProductVariantSchema.index({ listingId: 1, 'inventory.available': 1 });
ProductVariantSchema.index({ sku: 1 }, { sparse: true });

export const ProductVariant: Model<IProductVariant> =
  mongoose.models.ProductVariant ||
  mongoose.model<IProductVariant>('ProductVariant', ProductVariantSchema);
