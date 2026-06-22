/**
 * Refund model — money returned for part or all of a paid Order (B6).
 *
 * A refund records per-line amounts computed from each order item's DISCOUNTED
 * net (never gross), an optional refunded shipping cost, and an optional per-line
 * restock that returns units to inventory. `orderId`/`storeId`/`sellerOxyUserId`/
 * `variantId`/`locationId` are ALWAYS Strings (ids), never ObjectIds/refs. A
 * processed money refund lands in `status: 'refunded'`; the other states exist
 * for the return RMA workflow lifecycle. The sparse-unique `rmaNumber` is a
 * human-friendly return-merchandise authorization number; the sparse-unique
 * `idempotencyKey` lets a replayed submit converge on the same refund instead of
 * double-restocking. `refund.service` is the SOLE authority for refund-driven
 * restock — it restocks explicitly per-line and sets the order status directly,
 * NEVER through `order.service.transition`, so a refund can never double-restock.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { RefundType, RefundStatus } from '@mercaria/shared-types';
import { MoneySchema } from './schemas/money-schema.js';

const REFUND_TYPES: readonly RefundType[] = ['refund', 'return'];
const REFUND_STATUSES: readonly RefundStatus[] = [
  'requested',
  'approved',
  'restocked',
  'refunded',
  'rejected',
  'cancelled',
];

/** A persisted `{ amount, currency }` sub-document. */
interface IMoney {
  amount: number;
  currency: string;
}

/** One refunded line: the variant, quantity, computed amount and restock flag. */
export interface IRefundLineItem {
  variantId: string;
  quantity: number;
  amount: IMoney;
  restock: boolean;
  /** The store location the units were restocked at; absent → default location. */
  locationId?: string;
}

export interface IRefund {
  _id: mongoose.Types.ObjectId;
  orderId: string;
  storeId?: string;
  sellerOxyUserId?: string;
  type: RefundType;
  status: RefundStatus;
  reason?: string;
  lineItems: IRefundLineItem[];
  refundShipping?: IMoney;
  totalRefunded: IMoney;
  restockedAt?: Date;
  processedByOxyUserId?: string;
  rmaNumber?: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RefundLineItemSchema = new Schema<IRefundLineItem>(
  {
    variantId: { type: String, required: true },
    quantity: { type: Number, required: true },
    amount: { type: MoneySchema, required: true },
    restock: { type: Boolean, default: false },
    locationId: { type: String },
  },
  { _id: false },
);

const RefundSchema = new Schema<IRefund>(
  {
    orderId: { type: String, required: true, index: true },
    storeId: { type: String },
    sellerOxyUserId: { type: String },
    type: { type: String, enum: REFUND_TYPES as string[], default: 'refund' },
    status: { type: String, enum: REFUND_STATUSES as string[], default: 'refunded' },
    reason: { type: String },
    lineItems: { type: [RefundLineItemSchema], default: [] },
    refundShipping: { type: MoneySchema, required: false },
    totalRefunded: { type: MoneySchema, required: true },
    restockedAt: { type: Date },
    processedByOxyUserId: { type: String },
    rmaNumber: { type: String },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

// List an order's refunds, newest first.
RefundSchema.index({ orderId: 1, createdAt: -1 });
// List a store's refunds by status, newest first.
RefundSchema.index({ storeId: 1, status: 1, createdAt: -1 });
// A unique human-friendly RMA number (sparse: not every refund carries one).
RefundSchema.index({ rmaNumber: 1 }, { unique: true, sparse: true });
// Idempotent processing: a replayed submit collides on this key and converges.
RefundSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const Refund: Model<IRefund> =
  mongoose.models.Refund || mongoose.model<IRefund>('Refund', RefundSchema);
