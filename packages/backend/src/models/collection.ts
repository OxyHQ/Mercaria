/**
 * Collection model — a merchandising grouping of a STORE's products.
 *
 * MANUAL collections hold an ordered, hand-picked `productIds` list. AUTOMATED
 * collections derive membership from `rules` evaluated against each product's
 * denormalized `Listing` fields (title, vendor, productType, tags, categorySlugs,
 * price, inventory). Membership is MATERIALIZED onto each `Listing.collectionIds`
 * (denormalized, like `categorySlugs`) so collection browse reads an indexed
 * listing field without joining the collection per query.
 *
 * `storeId` is ALWAYS a String (the Store's id), never an ObjectId/ref; handles
 * are unique per store.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type {
  CollectionType,
  CollectionSortOrder,
  CollectionRuleField,
  CollectionRuleOperator,
} from '@mercaria/shared-types';

const COLLECTION_TYPES: readonly CollectionType[] = ['manual', 'automated'];
const COLLECTION_SORT_ORDERS: readonly CollectionSortOrder[] = [
  'manual',
  'best_selling',
  'price_asc',
  'price_desc',
  'created_desc',
  'title_asc',
];
const COLLECTION_RULE_FIELDS: readonly CollectionRuleField[] = [
  'title',
  'productType',
  'vendor',
  'tag',
  'price',
  'categorySlug',
  'compareAtPrice',
  'inventory',
];
const COLLECTION_RULE_OPERATORS: readonly CollectionRuleOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'gt',
  'lt',
  'gte',
  'lte',
];

export type {
  CollectionType,
  CollectionSortOrder,
  CollectionRuleField,
  CollectionRuleOperator,
};

/** A single condition in an automated collection's rule set. */
export interface ICollectionRule {
  field: CollectionRuleField;
  operator: CollectionRuleOperator;
  value: string;
}

export interface ICollection {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  title: string;
  handle: string;
  description?: string;
  imageFileId?: string;
  type: CollectionType;
  productIds: string[];
  rules?: {
    appliesDisjunctively: boolean;
    conditions: ICollectionRule[];
  };
  sortOrder: CollectionSortOrder;
  seo?: { title?: string; description?: string };
  isPublished: boolean;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CollectionRuleSchema = new Schema<ICollectionRule>(
  {
    field: { type: String, enum: COLLECTION_RULE_FIELDS as string[], required: true },
    operator: { type: String, enum: COLLECTION_RULE_OPERATORS as string[], required: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const CollectionSchema = new Schema<ICollection>(
  {
    storeId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    handle: { type: String, required: true },
    description: { type: String },
    imageFileId: { type: String },
    type: { type: String, enum: COLLECTION_TYPES as string[], required: true },
    productIds: { type: [String], default: [] },
    rules: {
      appliesDisjunctively: { type: Boolean, default: false },
      conditions: { type: [CollectionRuleSchema], default: [] },
    },
    sortOrder: { type: String, enum: COLLECTION_SORT_ORDERS as string[], default: 'manual' },
    seo: {
      title: { type: String },
      description: { type: String },
    },
    isPublished: { type: Boolean, default: true },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

CollectionSchema.index({ storeId: 1, handle: 1 }, { unique: true });
CollectionSchema.index({ storeId: 1, isPublished: 1 });

export const Collection: Model<ICollection> =
  mongoose.models.Collection || mongoose.model<ICollection>('Collection', CollectionSchema);
