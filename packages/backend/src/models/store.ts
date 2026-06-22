/**
 * Store model — a seller organization (shop) that lists NEW products.
 *
 * Distinct from an individual P2P seller (`SellerProfile`). Members are embedded
 * with a role + granular permission list; `oxyUserId` is ALWAYS a String (Oxy
 * user id), never an ObjectId/ref.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { StoreRole, StorePermission, TextTone } from '@mercaria/shared-types';
import { CURRENCY_CODES } from './schemas/money-schema.js';

const STORE_ROLES: readonly StoreRole[] = ['owner', 'admin', 'staff'];
const STORE_PERMISSIONS: readonly StorePermission[] = [
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'locations:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
];
const STORE_STATUSES = ['active', 'suspended', 'closed'] as const;
const TEXT_TONES: readonly TextTone[] = ['light', 'dark'];

export interface IStoreMember {
  oxyUserId: string;
  role: StoreRole;
  permissions: StorePermission[];
  invitedBy?: string;
  joinedAt: Date;
}

export interface IStore {
  _id: mongoose.Types.ObjectId;
  handle: string;
  name: string;
  description: string;
  logoFileId?: string;
  coverFileId?: string;
  brandColor: string;
  textTone: TextTone;
  status: (typeof STORE_STATUSES)[number];
  members: IStoreMember[];
  policies: {
    returnWindowDays: number;
    shippingNote?: string;
  };
  defaultCurrency: string;
  rating: number;
  reviewCount: number;
  productCount: number;
  salesCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const StoreMemberSchema = new Schema<IStoreMember>(
  {
    oxyUserId: { type: String, required: true },
    role: { type: String, enum: STORE_ROLES as string[], required: true },
    permissions: { type: [String], default: [] },
    invitedBy: { type: String },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const StoreSchema = new Schema<IStore>(
  {
    handle: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    logoFileId: { type: String },
    coverFileId: { type: String },
    brandColor: { type: String, required: true },
    textTone: { type: String, enum: TEXT_TONES as string[], default: 'light' },
    status: { type: String, enum: STORE_STATUSES as unknown as string[], default: 'active' },
    members: { type: [StoreMemberSchema], default: [] },
    policies: {
      returnWindowDays: { type: Number, default: 30 },
      shippingNote: { type: String },
    },
    defaultCurrency: { type: String, enum: CURRENCY_CODES as string[], default: 'FAIR' },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    productCount: { type: Number, default: 0 },
    salesCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

StoreSchema.index({ handle: 1 }, { unique: true });
StoreSchema.index({ 'members.oxyUserId': 1 });
StoreSchema.index({ status: 1, createdAt: -1 });

// The full permission set every store-permission enum value, exported so seeds
// and member-management can grant an owner all permissions without re-listing.
export const ALL_STORE_PERMISSIONS: readonly StorePermission[] = STORE_PERMISSIONS;

export const Store: Model<IStore> =
  mongoose.models.Store || mongoose.model<IStore>('Store', StoreSchema);
