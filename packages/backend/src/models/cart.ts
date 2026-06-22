/**
 * Cart model — a buyer's single-currency basket, one per Oxy user.
 *
 * Each embedded `CartItem` stores ONLY the variant reference + quantity — NEVER
 * a price. Prices and availability are read LIVE from the variant at view/
 * checkout time, so the cart can never serve a stale price. The cart's
 * `currency` pins it to a single currency; `cart.service` rejects adding a
 * variant priced in a different currency.
 */

import mongoose, { Schema, Model } from 'mongoose';
import { CURRENCY_CODES } from './schemas/money-schema.js';

export interface ICartItem {
  listingId: string;
  variantId: string;
  quantity: number;
  addedAt: Date;
}

export interface ICart {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  items: ICartItem[];
  /** The single currency every line in this cart shares. */
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const CartItemSchema = new Schema<ICartItem>(
  {
    // Cross-collection refs are stored as Strings ecosystem-wide.
    listingId: { type: String, required: true },
    variantId: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const CartSchema = new Schema<ICart>(
  {
    oxyUserId: { type: String, required: true },
    items: { type: [CartItemSchema], default: [] },
    currency: { type: String, enum: CURRENCY_CODES as string[], required: true },
  },
  { timestamps: true },
);

CartSchema.index({ oxyUserId: 1 }, { unique: true });

export const Cart: Model<ICart> =
  mongoose.models.Cart || mongoose.model<ICart>('Cart', CartSchema);
