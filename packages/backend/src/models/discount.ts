/**
 * Discount model — a store-scoped promotion that reduces the buyer's price (B4).
 *
 * A discount is applied either by entering a CODE (`method: 'code'`) or
 * AUTOMATICALLY for every eligible cart (`method: 'automatic'`). Its reduction is
 * a `percentage` (basis points, 1500 = 15%), a `fixed_amount` (FAIR integer minor
 * units), or a `bogo`/`free_item` buy-X-get-Y rule (`buy`/`get` legs). It targets
 * the whole ORDER, specific PRODUCTS, or whole COLLECTIONS (`appliesTo`).
 *
 * `storeId` is ALWAYS a String (the Store's id), never an ObjectId/ref. Codes are
 * unique PER STORE (a sparse unique index on `{ storeId, codes.code }`). Money is
 * NOT stored here — `value` is a scalar (bps or FAIR minor units) interpreted by
 * `valueType`; the pricing service produces the actual `Money` allocations.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type {
  DiscountMethod,
  DiscountValueType,
  DiscountScope,
} from '@mercaria/shared-types';

const DISCOUNT_METHODS: readonly DiscountMethod[] = ['code', 'automatic'];
const DISCOUNT_VALUE_TYPES: readonly DiscountValueType[] = [
  'percentage',
  'fixed_amount',
  'bogo',
  'free_item',
];
const DISCOUNT_SCOPES: readonly DiscountScope[] = ['order', 'products', 'collections'];
/** The buy/get legs only ever target products or collections (never the whole order). */
const DISCOUNT_LEG_SCOPES: readonly Exclude<DiscountScope, 'order'>[] = ['products', 'collections'];
const MINIMUM_REQUIREMENT_TYPES = ['none', 'subtotal', 'quantity'] as const;
const CUSTOMER_ELIGIBILITY_TYPES = ['all', 'groups', 'customers'] as const;

/** A single redeemable code with its redemption counter. */
export interface IDiscountCode {
  code: string;
  usageCount: number;
}

/** What a discount targets (whole order, or specific products/collections). */
export interface IDiscountAppliesTo {
  scope: DiscountScope;
  productIds?: string[];
  collectionIds?: string[];
}

/** A BOGO/free-item buy or get leg. */
export interface IDiscountLeg {
  quantity: number;
  scope: Exclude<DiscountScope, 'order'>;
  productIds?: string[];
  collectionIds?: string[];
  discountPercent?: number;
}

/** A minimum the cart must meet for the discount to apply. */
export interface IDiscountMinimumRequirement {
  type: (typeof MINIMUM_REQUIREMENT_TYPES)[number];
  value: number;
}

/** Which customers a discount is available to. */
export interface IDiscountCustomerEligibility {
  type: (typeof CUSTOMER_ELIGIBILITY_TYPES)[number];
  customerIds?: string[];
  groupTags?: string[];
}

/** Caps on how many times a discount may be used. */
export interface IDiscountUsageLimits {
  totalMax?: number;
  perCustomerMax?: number;
}

/** Which other discount classes this discount may stack with. */
export interface IDiscountCombinesWith {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

export interface IDiscount {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  title: string;
  method: DiscountMethod;
  codes: IDiscountCode[];
  valueType: DiscountValueType;
  value: number;
  appliesTo: IDiscountAppliesTo;
  buy?: IDiscountLeg;
  get?: IDiscountLeg;
  minimumRequirement?: IDiscountMinimumRequirement;
  customerEligibility?: IDiscountCustomerEligibility;
  usageLimits?: IDiscountUsageLimits;
  combinesWith: IDiscountCombinesWith;
  startsAt: Date;
  endsAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DiscountCodeSchema = new Schema<IDiscountCode>(
  {
    code: { type: String, required: true },
    usageCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const DiscountAppliesToSchema = new Schema<IDiscountAppliesTo>(
  {
    scope: { type: String, enum: DISCOUNT_SCOPES as string[], required: true },
    productIds: { type: [String], default: undefined },
    collectionIds: { type: [String], default: undefined },
  },
  { _id: false },
);

const DiscountLegSchema = new Schema<IDiscountLeg>(
  {
    quantity: { type: Number, required: true },
    scope: { type: String, enum: DISCOUNT_LEG_SCOPES as string[], required: true },
    productIds: { type: [String], default: undefined },
    collectionIds: { type: [String], default: undefined },
    discountPercent: { type: Number },
  },
  { _id: false },
);

const DiscountMinimumRequirementSchema = new Schema<IDiscountMinimumRequirement>(
  {
    type: { type: String, enum: MINIMUM_REQUIREMENT_TYPES as unknown as string[], default: 'none' },
    value: { type: Number, default: 0 },
  },
  { _id: false },
);

const DiscountCustomerEligibilitySchema = new Schema<IDiscountCustomerEligibility>(
  {
    type: { type: String, enum: CUSTOMER_ELIGIBILITY_TYPES as unknown as string[], default: 'all' },
    customerIds: { type: [String], default: undefined },
    groupTags: { type: [String], default: undefined },
  },
  { _id: false },
);

const DiscountUsageLimitsSchema = new Schema<IDiscountUsageLimits>(
  {
    totalMax: { type: Number },
    perCustomerMax: { type: Number },
  },
  { _id: false },
);

const DiscountCombinesWithSchema = new Schema<IDiscountCombinesWith>(
  {
    orderDiscounts: { type: Boolean, default: false },
    productDiscounts: { type: Boolean, default: false },
    shippingDiscounts: { type: Boolean, default: false },
  },
  { _id: false },
);

const DiscountSchema = new Schema<IDiscount>(
  {
    storeId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    method: { type: String, enum: DISCOUNT_METHODS as string[], required: true },
    codes: { type: [DiscountCodeSchema], default: [] },
    valueType: { type: String, enum: DISCOUNT_VALUE_TYPES as string[], required: true },
    value: { type: Number, required: true },
    appliesTo: { type: DiscountAppliesToSchema, required: true },
    buy: { type: DiscountLegSchema },
    get: { type: DiscountLegSchema },
    minimumRequirement: { type: DiscountMinimumRequirementSchema },
    customerEligibility: { type: DiscountCustomerEligibilitySchema },
    usageLimits: { type: DiscountUsageLimitsSchema },
    combinesWith: { type: DiscountCombinesWithSchema, default: () => ({}) },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  // `get` is a deliberate field name (the BOGO "get" leg, per the B4 contract);
  // Mongoose warns it shadows `Document.get`. We set/read it via `.set('get', …)`
  // on documents (and from `.lean()` plain objects elsewhere), so suppress the warning.
  { timestamps: true, suppressReservedKeysWarning: true },
);

// Serves the active-discount load in the pricing service (storeId + isActive + method).
DiscountSchema.index({ storeId: 1, isActive: 1, method: 1 });
// Per-store code uniqueness (sparse: automatic discounts carry no codes).
DiscountSchema.index({ storeId: 1, 'codes.code': 1 }, { unique: true, sparse: true });
// Serves the scheduled-window scan (startsAt <= now <= endsAt) per store + method.
DiscountSchema.index({ storeId: 1, method: 1, startsAt: 1, endsAt: 1 });

export const Discount: Model<IDiscount> =
  mongoose.models.Discount || mongoose.model<IDiscount>('Discount', DiscountSchema);
