/**
 * Customer model — a store-scoped buyer record (B5).
 *
 * The people who buy from a STORE, whether online or in-store at the POS. A
 * customer is either backed by an Oxy account (`oxyUserId`) or a WALK-IN
 * (`isWalkIn`, no Oxy account) created at the register. `storeId` is ALWAYS a
 * String (the Store's id), never an ObjectId/ref. The same Oxy user has ONE
 * customer record PER store they buy from (the `{ storeId, oxyUserId }` unique
 * sparse index). Lifetime aggregates (`stats`) move in lockstep with paid orders
 * — `customer.service.upsertOnPaid` bumps `orderCount`/`totalSpent` exactly once
 * per paid store order. The optional `defaultAddress` mirrors the order
 * `AddressSnapshot` shape.
 */

import mongoose, { Schema, Model } from 'mongoose';
import { MoneySchema } from './schemas/money-schema.js';

/** Default currency seeded onto a customer's `stats.totalSpent` on insert. */
const DEFAULT_CURRENCY = 'FAIR';

/** A persisted `{ amount, currency }` sub-document. */
interface IMoney {
  amount: number;
  currency: string;
}

/** A captured address snapshot for a customer (mirrors the order AddressSnapshot). */
export interface ICustomerAddress {
  label?: string;
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

/** Lifetime aggregates kept in lockstep with paid orders. */
export interface ICustomerStats {
  orderCount: number;
  totalSpent: IMoney;
  lastOrderAt?: Date;
}

export interface ICustomer {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  oxyUserId?: string;
  isWalkIn: boolean;
  displayName?: string;
  email?: string;
  phone?: string;
  defaultAddress?: ICustomerAddress;
  tags: string[];
  groupTags: string[];
  stats: ICustomerStats;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CustomerAddressSchema = new Schema<ICustomerAddress>(
  {
    label: { type: String },
    recipientName: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    region: { type: String },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
    phone: { type: String },
  },
  { _id: false },
);

const CustomerStatsSchema = new Schema<ICustomerStats>(
  {
    orderCount: { type: Number, default: 0 },
    totalSpent: { type: MoneySchema, default: () => ({ amount: 0, currency: DEFAULT_CURRENCY }) },
    lastOrderAt: { type: Date },
  },
  { _id: false },
);

const CustomerSchema = new Schema<ICustomer>(
  {
    storeId: { type: String, required: true, index: true },
    oxyUserId: { type: String },
    isWalkIn: { type: Boolean, default: false },
    displayName: { type: String },
    email: { type: String },
    phone: { type: String },
    defaultAddress: { type: CustomerAddressSchema },
    tags: { type: [String], default: [] },
    groupTags: { type: [String], default: [] },
    stats: { type: CustomerStatsSchema, default: () => ({}) },
    notes: { type: String },
  },
  { timestamps: true },
);

// One Oxy-backed customer record per store (sparse: walk-ins carry no oxyUserId).
CustomerSchema.index({ storeId: 1, oxyUserId: 1 }, { unique: true, sparse: true });
// Find/match a customer by email within a store (sparse: email is optional).
CustomerSchema.index({ storeId: 1, email: 1 }, { sparse: true });
// Filter a store's customers by tag.
CustomerSchema.index({ storeId: 1, tags: 1 });
// List a store's customers, newest first.
CustomerSchema.index({ storeId: 1, createdAt: -1 });

export const Customer: Model<ICustomer> =
  mongoose.models.Customer || mongoose.model<ICustomer>('Customer', CustomerSchema);
