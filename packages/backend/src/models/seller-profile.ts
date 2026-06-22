/**
 * SellerProfile model — the marketplace-scoped profile of an individual P2P
 * seller, keyed by their Oxy user id.
 *
 * Holds the aggregates Mercaria owns (verification, rating, sales) that are NOT
 * part of the Oxy identity. Display name / username / avatar are NEVER stored
 * here — they are read live from the Oxy profile at hydration time.
 */

import mongoose, { Schema, Model } from 'mongoose';

export interface ISellerProfile {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  isVerified: boolean;
  rating: number;
  reviewCount: number;
  salesCount: number;
  shippingPrefs?: {
    note?: string;
    handlingDays?: number;
  };
  returnPrefs?: {
    accepts?: boolean;
    windowDays?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const SellerProfileSchema = new Schema<ISellerProfile>(
  {
    oxyUserId: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    salesCount: { type: Number, default: 0 },
    shippingPrefs: {
      note: { type: String },
      handlingDays: { type: Number },
    },
    returnPrefs: {
      accepts: { type: Boolean },
      windowDays: { type: Number },
    },
  },
  { timestamps: true },
);

SellerProfileSchema.index({ oxyUserId: 1 }, { unique: true });

export const SellerProfile: Model<ISellerProfile> =
  mongoose.models.SellerProfile ||
  mongoose.model<ISellerProfile>('SellerProfile', SellerProfileSchema);
