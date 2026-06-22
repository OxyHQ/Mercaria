/**
 * Favorite model — a buyer's saved (wishlisted) listing.
 *
 * Keyed by the buyer's Oxy user id (`oxyUserId` is ALWAYS a String, never a
 * ref) plus the favorited `listingId`. A unique `{oxyUserId, listingId}` index
 * makes the toggle idempotent: a second "save" of the same listing is a no-op
 * write, never a duplicate. The denormalized `Listing.favoriteCount` is bumped
 * by the service on toggle.
 */

import mongoose, { Schema, Model } from 'mongoose';

export interface IFavorite {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  listingId: string;
  createdAt: Date;
  updatedAt: Date;
}

const FavoriteSchema = new Schema<IFavorite>(
  {
    oxyUserId: { type: String, required: true },
    // Cross-collection refs are stored as Strings ecosystem-wide.
    listingId: { type: String, required: true },
  },
  { timestamps: true },
);

FavoriteSchema.index({ oxyUserId: 1, listingId: 1 }, { unique: true });
FavoriteSchema.index({ oxyUserId: 1, createdAt: -1 });
FavoriteSchema.index({ listingId: 1 });

export const Favorite: Model<IFavorite> =
  mongoose.models.Favorite || mongoose.model<IFavorite>('Favorite', FavoriteSchema);
