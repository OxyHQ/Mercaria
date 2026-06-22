/**
 * DraftOrder model — the POS cart that converts into a paid Order (B5).
 *
 * A store member builds a draft at the register: line items are added/edited
 * against the live catalog, a discount code list and a customer may be attached,
 * and totals are recomputed through the SAME pricing engine the storefront uses.
 * On `complete` the draft reserves stock, freezes immutable line snapshots and
 * converts into a paid `Order` (`sourceChannel: 'pos'`, `convertedOrderId`).
 *
 * `storeId`/`locationId`/`customerId`/`createdByOxyUserId` are ALWAYS Strings
 * (ids), never ObjectIds/refs. An `open` draft is MUTABLE; `completed`/`cancelled`
 * are terminal. The sparse-unique `idempotencyKey` lets a replayed `complete`
 * collide on the index and converge instead of double-creating an order; the
 * embedded `DiscountAllocationSchema` mirrors the order model's (redefined here so
 * the two models do not import across each other).
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { DraftOrderStatus } from '@mercaria/shared-types';
import { MoneySchema, CURRENCY_CODES } from './schemas/money-schema.js';

const DRAFT_ORDER_STATUSES: readonly DraftOrderStatus[] = ['open', 'completed', 'cancelled'];

/** A persisted `{ amount, currency }` sub-document. */
interface IMoney {
  amount: number;
  currency: string;
}

export interface IDraftOrderLineItem {
  listingId: string;
  variantId: string;
  title: string;
  variantTitle: string;
  unitPrice: IMoney;
  quantity: number;
  optionValues: { name: string; value: string }[];
  /** Discount attributed to this line by the pricing engine; absent when zero. */
  discountTotal?: IMoney;
}

/** One discount's contribution to the draft (mirrors the order model's shape). */
export interface IDraftDiscountAllocation {
  discountId: string;
  code?: string;
  title: string;
  valueType: string;
  amount: IMoney;
  target: 'order' | 'line';
  targetLineIndex?: number;
}

/** One applied tax rate's contribution to the draft. */
export interface IDraftTaxLine {
  name: string;
  rateBps: number;
  amount: IMoney;
}

/** A captured shipping/contact address snapshot on the draft. */
export interface IDraftAddressSnapshot {
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

export interface IDraftOrder {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  locationId?: string;
  customerId?: string;
  createdByOxyUserId: string;
  status: DraftOrderStatus;
  lineItems: IDraftOrderLineItem[];
  discountCodes: string[];
  appliedDiscounts: IDraftDiscountAllocation[];
  taxLines: IDraftTaxLine[];
  shippingAddressSnapshot?: IDraftAddressSnapshot;
  totals: {
    subtotal: IMoney;
    discountTotal: IMoney;
    tax: IMoney;
    shipping: IMoney;
    grandTotal: IMoney;
  };
  currency: string;
  note?: string;
  convertedOrderId?: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DraftLineOptionValueSchema = new Schema(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const DraftLineItemSchema = new Schema<IDraftOrderLineItem>(
  {
    listingId: { type: String, required: true },
    variantId: { type: String, required: true },
    title: { type: String, required: true },
    variantTitle: { type: String, required: true },
    unitPrice: { type: MoneySchema, required: true },
    quantity: { type: Number, required: true },
    optionValues: { type: [DraftLineOptionValueSchema], default: [] },
    discountTotal: { type: MoneySchema, required: false },
  },
  { _id: false },
);

/** One discount's contribution to the draft (target 'order' or a specific 'line'). */
const DiscountAllocationSchema = new Schema<IDraftDiscountAllocation>(
  {
    discountId: { type: String, required: true },
    code: { type: String },
    title: { type: String, required: true },
    valueType: { type: String, required: true },
    amount: { type: MoneySchema, required: true },
    target: { type: String, enum: ['order', 'line'], required: true },
    targetLineIndex: { type: Number },
  },
  { _id: false },
);

const TaxLineSchema = new Schema<IDraftTaxLine>(
  {
    name: { type: String, required: true },
    rateBps: { type: Number, required: true },
    amount: { type: MoneySchema, required: true },
  },
  { _id: false },
);

const AddressSnapshotSchema = new Schema<IDraftAddressSnapshot>(
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

const DraftOrderSchema = new Schema<IDraftOrder>(
  {
    storeId: { type: String, required: true, index: true },
    locationId: { type: String },
    customerId: { type: String },
    createdByOxyUserId: { type: String, required: true },
    status: { type: String, enum: DRAFT_ORDER_STATUSES as string[], default: 'open' },
    lineItems: { type: [DraftLineItemSchema], default: [] },
    discountCodes: { type: [String], default: [] },
    appliedDiscounts: { type: [DiscountAllocationSchema], default: [] },
    taxLines: { type: [TaxLineSchema], default: [] },
    shippingAddressSnapshot: { type: AddressSnapshotSchema },
    totals: {
      subtotal: { type: MoneySchema, required: true },
      discountTotal: { type: MoneySchema, required: true },
      tax: { type: MoneySchema, required: true },
      shipping: { type: MoneySchema, required: true },
      grandTotal: { type: MoneySchema, required: true },
    },
    currency: { type: String, enum: CURRENCY_CODES as string[], required: true },
    note: { type: String },
    convertedOrderId: { type: String },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

// List a store's drafts by status, newest first.
DraftOrderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
// Reverse lookup from a converted order back to its draft.
DraftOrderSchema.index({ convertedOrderId: 1 }, { sparse: true });
// Idempotent completion: a replayed complete collides on this key and converges.
DraftOrderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const DraftOrder: Model<IDraftOrder> =
  mongoose.models.DraftOrder || mongoose.model<IDraftOrder>('DraftOrder', DraftOrderSchema);
