/**
 * InventoryLevel model — per-(variant, location) stock for STORE variants.
 *
 * This standalone collection is the AUTHORITATIVE source of truth for a store
 * variant's stock: it carries `available` (units free to reserve) and `committed`
 * (units reserved by pending orders) at the GRAIN of a single location. The
 * variant's scalar `inventory.{available,committed}` is the denormalized ROLLUP =
 * sum over a variant's level rows, recomputed after every level mutation (so the
 * storefront DTO and listing facets keep reading the scalar unchanged).
 *
 * Race-safe like the variant scalar path: each reserve is a guarded `$inc` against
 * the matching level row (`available: { $gte: qty }`), so at most one concurrent
 * reserve wins. P2P (`ownerType: 'user'`) variants do NOT use this collection —
 * they keep the scalar-only path. `committed` is NEVER exposed on the wire.
 *
 * The interface is named `IInventoryLevelDoc` to avoid clashing with the FUTURE
 * embedded `IInventoryLevel` seam still defined on `product-variant.ts`.
 */

import mongoose, { Schema, Model } from 'mongoose';

export interface IInventoryLevelDoc {
  _id: mongoose.Types.ObjectId;
  variantId: string;
  listingId: string;
  locationId: string;
  available: number;
  committed: number;
  createdAt: Date;
  updatedAt: Date;
}

const InventoryLevelSchema = new Schema<IInventoryLevelDoc>(
  {
    variantId: { type: String, required: true },
    listingId: { type: String, required: true, index: true },
    locationId: { type: String, required: true },
    available: { type: Number, default: 0 },
    committed: { type: Number, default: 0 },
  },
  { timestamps: true },
);

InventoryLevelSchema.index({ variantId: 1, locationId: 1 }, { unique: true });
InventoryLevelSchema.index({ locationId: 1, available: 1 });
InventoryLevelSchema.index({ listingId: 1 });

export const InventoryLevel: Model<IInventoryLevelDoc> =
  mongoose.models.InventoryLevel ||
  mongoose.model<IInventoryLevelDoc>('InventoryLevel', InventoryLevelSchema);
