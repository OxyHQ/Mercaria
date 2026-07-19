/**
 * Cart model — a buyer's basket, one per Oxy user.
 *
 * Each embedded `CartItem` stores ONLY the variant reference + quantity — NEVER
 * a price. Prices and availability are read LIVE from the variant at view/
 * checkout time, so the cart can never serve a stale price. The cart is NOT pinned
 * to a currency: at hydration each variant's NATIVE price is converted into the
 * buyer's PRESENTMENT currency (their preferred currency, or FAIR), so one cart
 * can hold items priced in different native currencies.
 */

import mongoose, { Schema, Model } from 'mongoose';

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
  /** Discount codes pinned to the cart, pending application at checkout (normalized uppercase). */
  pendingDiscountCodes: string[];
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
    pendingDiscountCodes: { type: [String], default: [] },
  },
  { timestamps: true },
);

CartSchema.index({ oxyUserId: 1 }, { unique: true });

export const Cart: Model<ICart> =
  mongoose.models.Cart || mongoose.model<ICart>('Cart', CartSchema);
