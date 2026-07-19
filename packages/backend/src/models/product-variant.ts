/**
 * ProductVariant model — a concrete buyable SKU of a `Listing`.
 *
 * P2P listings have exactly one default variant; store products may have many.
 * Inventory carries `available` and `committed` (units reserved by pending
 * orders); `committed` is NEVER exposed on the wire. The `levels` array is a
 * FUTURE multi-location inventory seam — defined here but unused in F1.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { ConnectorProviderId } from '@mercaria/shared-types';
import { MoneySchema } from './schemas/money-schema.js';

export interface IVariantOptionValue {
  name: string;
  value: string;
}

/**
 * Connector provenance of a variant synced from an external commerce platform.
 * Carries the platform's own variant + inventory-item ids so the connector
 * inventory sync (pull job + `inventory_levels/update` webhook) can map a platform
 * `inventory_item_id` straight back to this Mercaria variant WITHOUT relying on a
 * SKU match. Present only on connector-sourced variants; unset for merchant/P2P
 * variants.
 */
export interface IProductVariantSource {
  connectionId: string;
  provider: ConnectorProviderId;
  /** The platform's own variant id (e.g. Shopify variant id). */
  externalVariantId?: string;
  /** The platform's inventory-item id — the key of an inventory-level update. */
  externalInventoryItemId?: string;
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
  barcode?: string;
  price: { amount: number; currency: string };
  compareAtPrice?: { amount: number; currency: string };
  inventory: {
    tracked: boolean;
    available: number;
    committed: number;
    /** FUTURE multi-location seam — empty/unused in F1. */
    levels?: IInventoryLevel[];
  };
  /** Connector provenance — present only on variants synced from an external platform. */
  source?: IProductVariantSource;
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

const CONNECTOR_PROVIDERS: readonly ConnectorProviderId[] = [
  'shopify',
  'woocommerce',
  'etsy',
  'prestashop',
  'magento',
];

const ProductVariantSourceSchema = new Schema<IProductVariantSource>(
  {
    connectionId: { type: String, required: true },
    provider: { type: String, enum: CONNECTOR_PROVIDERS as string[], required: true },
    externalVariantId: { type: String },
    externalInventoryItemId: { type: String },
  },
  { _id: false },
);

const ProductVariantSchema = new Schema<IProductVariant>(
  {
    listingId: { type: String, required: true },
    title: { type: String, default: 'Default Title' },
    optionValues: { type: [VariantOptionValueSchema], default: [] },
    sku: { type: String },
    barcode: { type: String },
    price: { type: MoneySchema, required: true },
    compareAtPrice: { type: MoneySchema },
    inventory: {
      tracked: { type: Boolean, default: true },
      available: { type: Number, default: 0 },
      committed: { type: Number, default: 0 },
      levels: { type: [InventoryLevelSchema], default: [] },
    },
    source: { type: ProductVariantSourceSchema },
    position: { type: Number, default: 0 },
  },
  { timestamps: true },
);

ProductVariantSchema.index({ listingId: 1, position: 1 });
ProductVariantSchema.index({ listingId: 1, 'inventory.available': 1 });
ProductVariantSchema.index({ sku: 1 }, { sparse: true });
ProductVariantSchema.index({ barcode: 1 }, { sparse: true });
// Map a connector `inventory_item_id` straight back to its Mercaria variant for
// the inventory pull job + `inventory_levels/update` webhook. Partial (not sparse):
// restrict the index to connector-sourced variants that carry an inventory-item id.
ProductVariantSchema.index(
  { 'source.connectionId': 1, 'source.externalInventoryItemId': 1 },
  { partialFilterExpression: { 'source.externalInventoryItemId': { $type: 'string' } } },
);

export const ProductVariant: Model<IProductVariant> =
  mongoose.models.ProductVariant ||
  mongoose.model<IProductVariant>('ProductVariant', ProductVariantSchema);
