/**
 * Listing model — the core sellable product.
 *
 * Owned EITHER by an individual user (`ownerType: 'user'`, `oxyUserId` set) OR
 * by a store (`ownerType: 'store'`, `storeId` set) — enforced as mutually
 * exclusive by a `pre('validate')` hook. Price faceting (`priceRange`,
 * `hasInventory`, `variantCount`) is DENORMALIZED from the listing's variants so
 * browse/sort can run off indexed listing fields without joining variants.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { ListingCondition, ListingStatus, ListingOwnerType } from '@mercaria/shared-types';
import { MoneySchema } from './schemas/money-schema.js';

const OWNER_TYPES: readonly ListingOwnerType[] = ['user', 'store'];
const CONDITIONS: readonly ListingCondition[] = ['new', 'used'];
const STATUSES: readonly ListingStatus[] = ['draft', 'active', 'sold', 'archived'];

export interface IListingImage {
  fileId: string;
  alt?: string;
  position: number;
}

export interface IListingOption {
  name: string;
  values: string[];
}

export interface IGeoPoint {
  type: 'Point';
  /** [lng, lat] per GeoJSON. */
  coordinates: number[];
}

export interface IListing {
  _id: mongoose.Types.ObjectId;
  ownerType: ListingOwnerType;
  oxyUserId?: string;
  storeId?: string;
  title: string;
  description: string;
  condition: ListingCondition;
  status: ListingStatus;
  categoryId?: string;
  /** Denormalized: the listing's category slug plus all its ancestor slugs. */
  categorySlugs: string[];
  images: IListingImage[];
  tags: string[];
  options: IListingOption[];
  /** Denormalized from variants for indexed price faceting. */
  priceRange: {
    min: { amount: number; currency: string };
    max: { amount: number; currency: string };
  };
  hasInventory: boolean;
  variantCount: number;
  /** GeoJSON point, only set for P2P listings with a location. */
  location?: IGeoPoint;
  /** Manufacturer/brand (store products). */
  vendor?: string;
  /** Merchandising product type (store products). */
  productType?: string;
  /** URL-safe handle (store products); unique per store when set. */
  handle?: string;
  /** SEO overrides (store products). */
  seo?: { title?: string; description?: string };
  /** Collection ids this listing belongs to (denormalized membership). */
  collectionIds: string[];
  rating: number;
  reviewCount: number;
  favoriteCount: number;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ListingImageSchema = new Schema<IListingImage>(
  {
    fileId: { type: String, required: true },
    alt: { type: String },
    position: { type: Number, default: 0 },
  },
  { _id: false },
);

const ListingOptionSchema = new Schema<IListingOption>(
  {
    name: { type: String, required: true },
    values: { type: [String], default: [] },
  },
  { _id: false },
);

const ListingSchema = new Schema<IListing>(
  {
    ownerType: { type: String, enum: OWNER_TYPES as string[], required: true },
    oxyUserId: { type: String },
    storeId: { type: String },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    condition: { type: String, enum: CONDITIONS as string[], required: true },
    status: { type: String, enum: STATUSES as string[], default: 'draft' },
    categoryId: { type: String },
    categorySlugs: { type: [String], default: [] },
    images: { type: [ListingImageSchema], default: [] },
    tags: { type: [String], default: [] },
    options: { type: [ListingOptionSchema], default: [] },
    priceRange: {
      min: { type: MoneySchema },
      max: { type: MoneySchema },
    },
    hasInventory: { type: Boolean, default: false },
    variantCount: { type: Number, default: 0 },
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: { type: [Number] },
    },
    vendor: { type: String },
    productType: { type: String },
    handle: { type: String },
    seo: {
      title: { type: String },
      description: { type: String },
    },
    collectionIds: { type: [String], default: [] },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    favoriteCount: { type: Number, default: 0 },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * Enforce that exactly one owner is set, consistent with `ownerType`:
 * - `'user'`  ⇒ `oxyUserId` set, `storeId` unset
 * - `'store'` ⇒ `storeId` set, `oxyUserId` unset
 *
 * Implemented as a synchronous hook that throws on violation — Mongoose 9
 * rejects the validation with the thrown error.
 */
ListingSchema.pre('validate', function preValidate() {
  if (this.ownerType === 'user') {
    if (!this.oxyUserId) {
      throw new Error("Listing ownerType 'user' requires oxyUserId");
    }
    if (this.storeId) {
      throw new Error("Listing ownerType 'user' must not set storeId");
    }
  } else if (this.ownerType === 'store') {
    if (!this.storeId) {
      throw new Error("Listing ownerType 'store' requires storeId");
    }
    if (this.oxyUserId) {
      throw new Error("Listing ownerType 'store' must not set oxyUserId");
    }
  } else {
    throw new Error(`Invalid Listing ownerType: ${String(this.ownerType)}`);
  }
});

ListingSchema.index({ status: 1, publishedAt: -1, _id: -1 });
ListingSchema.index({ status: 1, categoryId: 1, publishedAt: -1, _id: -1 });
ListingSchema.index({ categorySlugs: 1, status: 1, publishedAt: -1 });
ListingSchema.index({ status: 1, 'priceRange.min.amount': 1, publishedAt: -1 });
ListingSchema.index({ ownerType: 1, storeId: 1, status: 1, publishedAt: -1, _id: -1 });
ListingSchema.index({ ownerType: 1, oxyUserId: 1, status: 1, publishedAt: -1, _id: -1 });
ListingSchema.index({ location: '2dsphere' });
ListingSchema.index({ title: 'text', description: 'text', tags: 'text' });
ListingSchema.index({ storeId: 1, vendor: 1 });
ListingSchema.index({ storeId: 1, productType: 1 });
// Partial (not sparse): a compound sparse index still indexes docs where only
// `handle` is missing because `storeId` is always present, so multiple
// handle-less store products would collide on `{ storeId, handle: null }`.
// Index — and enforce per-store uniqueness — only for products that have a handle.
ListingSchema.index(
  { storeId: 1, handle: 1 },
  { unique: true, partialFilterExpression: { handle: { $type: 'string' } } },
);
ListingSchema.index({ collectionIds: 1 });

export const Listing: Model<IListing> =
  mongoose.models.Listing || mongoose.model<IListing>('Listing', ListingSchema);
