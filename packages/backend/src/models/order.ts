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
  items: IOrderItem[];
  shippingAddressSnapshot: IAddressSnapshot;
  shipping: IShippingSnapshot;
  totals: {
    subtotal: IMoney;
    shipping: IMoney;
    grandTotal: IMoney;
  };
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
    items: { type: [OrderItemSchema], default: [] },
    shippingAddressSnapshot: { type: AddressSnapshotSchema, required: true },
    shipping: { type: ShippingSnapshotSchema, required: true },
    totals: {
      subtotal: { type: MoneySchema, required: true },
      shipping: { type: MoneySchema, required: true },
      grandTotal: { type: MoneySchema, required: true },
    },
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
OrderSchema.index({ sellerOxyUserId: 1, status: 1, createdAt: -1 });
OrderSchema.index({ orderNumber: 1 }, { unique: true });
OrderSchema.index({ checkoutGroupId: 1 });
OrderSchema.index({ 'payment.status': 1, createdAt: 1 });
// Serves the expire-reservations sweep: { status: 'pending_payment', createdAt: { $lt } }.
OrderSchema.index({ status: 1, createdAt: 1 });
OrderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const Order: Model<IOrder> =
  mongoose.models.Order || mongoose.model<IOrder>('Order', OrderSchema);
