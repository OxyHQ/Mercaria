/**
 * Order model — one seller's IMMUTABLE portion of a checkout.
 *
 * A multi-seller cart splits into one order per seller, all sharing a
 * `checkoutGroupId`. Line items (`items`) are SNAPSHOTS copied at checkout —
 * title, variant, option values, unit price and image are frozen at purchase
 * time and never re-read from the live catalog. The shipping destination is
 * likewise snapshotted (`shippingAddressSnapshot`) so a later edit of the saved
 * address cannot mutate a placed order.
 *
 * Inventory transitions are NOT performed here — they go through
 * `inventory.service` driven by `order.service.transition`. The `idempotencyKey`
 * (sparse-unique) lets a replayed checkout converge on the same orders instead
 * of creating duplicates.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type {
  OrderStatus,
  ShippingMethod,
  OrderSellerType,
  OrderSourceChannel,
  PaymentInfo,
} from '@mercaria/shared-types';
import { MoneySchema } from './schemas/money-schema.js';

const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
];
const PAYMENT_STATUSES: readonly PaymentInfo['status'][] = [
  'unpaid',
  'authorized',
  'paid',
  'refunded',
  'failed',
];
const PAYMENT_PROVIDERS: readonly PaymentInfo['provider'][] = ['oxy_pay'];
const SHIPPING_METHODS: readonly ShippingMethod[] = ['standard', 'express', 'pickup'];
const SELLER_TYPES: readonly OrderSellerType[] = ['user', 'store'];
const SOURCE_CHANNELS: readonly OrderSourceChannel[] = ['storefront', 'pos', 'draft'];

/** A persisted `{ amount, currency }` sub-document. */
interface IMoney {
  amount: number;
  currency: string;
}

export interface IOrderItem {
  listingId: string;
  variantId: string;
  title: string;
  variantTitle: string;
  imageUrl?: string;
  optionValues: { name: string; value: string }[];
  unitPrice: IMoney;
  quantity: number;
  lineTotal: IMoney;
  /** Total discount attributed to this line; absent on un-discounted lines. */
  discountTotal?: IMoney;
  /** The store location this line's stock commits at (POS); absent → default location. */
  locationId?: string;
}

/** One discount's contribution to the order (persisted for exact refundability). */
export interface IDiscountAllocation {
  discountId: string;
  code?: string;
  title: string;
  valueType: string;
  amount: IMoney;
  target: 'order' | 'line';
  targetLineIndex?: number;
}

/** One applied tax rate's contribution to the order. */
export interface ITaxLine {
  name: string;
  rateBps: number;
  amount: IMoney;
}

export interface IOrderStatusEvent {
  status: OrderStatus;
  at: Date;
  byOxyUserId?: string;
  note?: string;
}

export interface IPaymentInfo {
  status: PaymentInfo['status'];
  provider: PaymentInfo['provider'];
  reference?: string;
  paidAt?: Date;
}

export interface IShippingSnapshot {
  method: ShippingMethod;
  label: string;
  cost: IMoney;
  trackingNumber: string | null;
}

export interface IAddressSnapshot {
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

export interface IOrder {
  _id: mongoose.Types.ObjectId;
  orderNumber: string;
  buyerOxyUserId: string;
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  customerId?: string;
  sourceChannel: OrderSourceChannel;
  items: IOrderItem[];
  shippingAddressSnapshot: IAddressSnapshot;
  shipping: IShippingSnapshot;
  totals: {
    subtotal: IMoney;
    /** Total of every applied discount allocation; absent on pre-B4 orders. */
    discountTotal?: IMoney;
    shipping: IMoney;
    /** Total tax added; absent on pre-B4 orders. */
    tax?: IMoney;
    grandTotal: IMoney;
  };
  appliedDiscounts: IDiscountAllocation[];
  taxLines: ITaxLine[];
  status: OrderStatus;
  statusHistory: IOrderStatusEvent[];
  payment: IPaymentInfo;
  checkoutGroupId: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemOptionValueSchema = new Schema(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const OrderItemSchema = new Schema<IOrderItem>(
  {
    listingId: { type: String, required: true },
    variantId: { type: String, required: true },
    title: { type: String, required: true },
    variantTitle: { type: String, required: true },
    imageUrl: { type: String },
    optionValues: { type: [OrderItemOptionValueSchema], default: [] },
    unitPrice: { type: MoneySchema, required: true },
    quantity: { type: Number, required: true },
    lineTotal: { type: MoneySchema, required: true },
    // Optional (back-compat): pre-B4 items carry no per-line discount.
    discountTotal: { type: MoneySchema, required: false },
    // Optional (POS): the location the line commits at; absent → default location.
    locationId: { type: String },
  },
  { _id: false },
);

/** One discount's contribution to the order (target 'order' or a specific 'line'). */
const DiscountAllocationSchema = new Schema<IDiscountAllocation>(
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

/** One applied tax rate's contribution to the order. */
const TaxLineSchema = new Schema<ITaxLine>(
  {
    name: { type: String, required: true },
    rateBps: { type: Number, required: true },
    amount: { type: MoneySchema, required: true },
  },
  { _id: false },
);

const ShippingSnapshotSchema = new Schema<IShippingSnapshot>(
  {
    method: { type: String, enum: SHIPPING_METHODS as string[], required: true },
    label: { type: String, required: true },
    cost: { type: MoneySchema, required: true },
    trackingNumber: { type: String, default: null },
  },
  { _id: false },
);

const AddressSnapshotSchema = new Schema<IAddressSnapshot>(
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

const PaymentSchema = new Schema<IPaymentInfo>(
  {
    status: { type: String, enum: PAYMENT_STATUSES as string[], default: 'unpaid' },
    provider: { type: String, enum: PAYMENT_PROVIDERS as string[], default: 'oxy_pay' },
    reference: { type: String },
    paidAt: { type: Date },
  },
  { _id: false },
);

const StatusEventSchema = new Schema<IOrderStatusEvent>(
  {
    status: { type: String, enum: ORDER_STATUSES as string[], required: true },
    at: { type: Date, default: Date.now },
    byOxyUserId: { type: String },
    note: { type: String },
  },
  { _id: false },
);

const OrderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true },
    buyerOxyUserId: { type: String, required: true },
    sellerType: { type: String, enum: SELLER_TYPES as string[], required: true },
    sellerOxyUserId: { type: String },
    storeId: { type: String },
    customerId: { type: String },
    // Additive/back-compat: pre-B5 orders default to the online storefront.
    sourceChannel: { type: String, enum: SOURCE_CHANNELS as string[], default: 'storefront' },
    items: { type: [OrderItemSchema], default: [] },
    shippingAddressSnapshot: { type: AddressSnapshotSchema, required: true },
    shipping: { type: ShippingSnapshotSchema, required: true },
    totals: {
      subtotal: { type: MoneySchema, required: true },
      // Optional (back-compat): pre-B4 orders carry no discount/tax totals; the
      // hydration falls back to zero. Services always write them on new orders.
      discountTotal: { type: MoneySchema, required: false },
      shipping: { type: MoneySchema, required: true },
      tax: { type: MoneySchema, required: false },
      grandTotal: { type: MoneySchema, required: true },
    },
    appliedDiscounts: { type: [DiscountAllocationSchema], default: [] },
    taxLines: { type: [TaxLineSchema], default: [] },
    status: {
      type: String,
      enum: ORDER_STATUSES as string[],
      default: 'pending_payment',
    },
    statusHistory: { type: [StatusEventSchema], default: [] },
    payment: { type: PaymentSchema, default: () => ({}) },
    checkoutGroupId: { type: String },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

OrderSchema.index({ buyerOxyUserId: 1, createdAt: -1 });
OrderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
// Serves a store customer's order history (storeId + customerId, newest first).
OrderSchema.index({ storeId: 1, customerId: 1, createdAt: -1 });
OrderSchema.index({ sellerOxyUserId: 1, status: 1, createdAt: -1 });
OrderSchema.index({ orderNumber: 1 }, { unique: true });
OrderSchema.index({ checkoutGroupId: 1 });
OrderSchema.index({ 'payment.status': 1, createdAt: 1 });
// Serves the expire-reservations sweep: { status: 'pending_payment', createdAt: { $lt } }.
OrderSchema.index({ status: 1, createdAt: 1 });
OrderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const Order: Model<IOrder> =
  mongoose.models.Order || mongoose.model<IOrder>('Order', OrderSchema);
