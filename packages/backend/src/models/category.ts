/**
 * Category model — the marketplace taxonomy.
 *
 * Categories form a tree via `parentId` (the string `_id` of the parent, or
 * `null` for a top-level category). `ancestorSlugs` is a materialized path of
 * every ancestor slug so a listing tagged with a leaf slug can be found by any
 * ancestor without a recursive query.
 */

import mongoose, { Schema, Model } from 'mongoose';

export interface ICategory {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  /** String `_id` of the parent category, or `null` for a top-level category. */
  parentId: string | null;
  /** Materialized path: slugs of all ancestors (root → parent), excluding self. */
  ancestorSlugs: string[];
  /** Resolvable image URL (used directly when no `imageFileId`). */
  imageUrl?: string;
  /** Oxy media file id for the category image, resolved at read time. */
  imageFileId?: string;
  /** Sort position among siblings. */
  position: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CategorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true },
    parentId: { type: String, default: null },
    ancestorSlugs: { type: [String], default: [] },
    imageUrl: { type: String },
    imageFileId: { type: String },
    position: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

CategorySchema.index({ slug: 1 }, { unique: true });
CategorySchema.index({ parentId: 1, position: 1 });
CategorySchema.index({ ancestorSlugs: 1 });

export const Category: Model<ICategory> =
  mongoose.models.Category || mongoose.model<ICategory>('Category', CategorySchema);
