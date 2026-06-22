/**
 * Tax-rate model — a store-scoped tax rule (B4).
 *
 * A rate adds (or, when the store's prices are tax-inclusive, informationally
 * backs out) tax on a cart's taxable base. It is matched by `region` (country /
 * region / a postal-code regex) and optionally narrowed to a set of product types
 * (`productTypeScope`); higher `priority` rates are evaluated first when several
 * match. `rateBps` is basis points (800 = 8%).
 *
 * `storeId` is ALWAYS a String (the Store's id), never an ObjectId/ref. No `Money`
 * is stored here — the rate is a scalar; the pricing service produces the actual
 * `Money` tax lines.
 */

import mongoose, { Schema, Model } from 'mongoose';

/** The geographic scope a tax rate applies to. */
export interface ITaxRegion {
  country?: string;
  region?: string;
  postalCodePattern?: string;
}

export interface ITaxRate {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  name: string;
  rateBps: number;
  region: ITaxRegion;
  appliesToShipping: boolean;
  productTypeScope?: string[];
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TaxRegionSchema = new Schema<ITaxRegion>(
  {
    country: { type: String },
    region: { type: String },
    postalCodePattern: { type: String },
  },
  { _id: false },
);

const TaxRateSchema = new Schema<ITaxRate>(
  {
    storeId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    rateBps: { type: Number, required: true },
    region: { type: TaxRegionSchema, default: () => ({}) },
    appliesToShipping: { type: Boolean, default: false },
    productTypeScope: { type: [String], default: undefined },
    priority: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Serves the active-rate load in the pricing service.
TaxRateSchema.index({ storeId: 1, isActive: 1 });
// Serves region-narrowed admin queries.
TaxRateSchema.index({ storeId: 1, 'region.country': 1, 'region.region': 1 });

export const TaxRate: Model<ITaxRate> =
  mongoose.models.TaxRate || mongoose.model<ITaxRate>('TaxRate', TaxRateSchema);
