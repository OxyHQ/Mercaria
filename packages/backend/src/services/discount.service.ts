/**
 * Discount service — store-admin lifecycle for promotions (B4).
 *
 * Owns create/list/get/update/delete for a store's `Discount`s plus the
 * `Discount` DTO serializer. Codes are normalized to UPPERCASE and unique PER
 * STORE (the sparse unique index on `{ storeId, codes.code }`); a duplicate maps
 * to a CONFLICT. Every operation is scoped to its `storeId`, so a member only
 * operates on their own store's discounts.
 *
 * The pricing/redemption side (gating, amount math, usage increments) lives in
 * `pricing.service` + `checkout.service`; this module is purely the admin CRUD.
 */

import type {
  CreateDiscountInput,
  UpdateDiscountInput,
  Discount as DiscountDTO,
  DiscountCombinesWith,
} from '@mercaria/shared-types';
import {
  Discount,
  type IDiscount,
  type IDiscountCode,
  type IDiscountAppliesTo,
  type IDiscountLeg,
} from '../models/discount.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';

/** Mongo duplicate-key error code (a unique-index violation). */
const MONGO_DUPLICATE_KEY = 11000;

/** True iff `err` is a Mongo duplicate-key (unique-index) error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

/** Normalize a redeemable code: trim + uppercase (the matching key everywhere). */
export function normalizeDiscountCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Default combinability (stacks with nothing) when a create payload omits it. */
function resolveCombinesWith(input?: Partial<DiscountCombinesWith>): DiscountCombinesWith {
  return {
    orderDiscounts: input?.orderDiscounts ?? false,
    productDiscounts: input?.productDiscounts ?? false,
    shippingDiscounts: input?.shippingDiscounts ?? false,
  };
}

/** Build the persisted `appliesTo` sub-document from input (omit absent id arrays). */
function buildAppliesTo(input: CreateDiscountInput['appliesTo']): IDiscountAppliesTo {
  const appliesTo: IDiscountAppliesTo = { scope: input.scope };
  if (input.productIds) appliesTo.productIds = [...input.productIds];
  if (input.collectionIds) appliesTo.collectionIds = [...input.collectionIds];
  return appliesTo;
}

/** Build a persisted buy/get leg from input (omit absent optionals). */
function buildLeg(input: NonNullable<CreateDiscountInput['buy']>): IDiscountLeg {
  const leg: IDiscountLeg = { quantity: input.quantity, scope: input.scope };
  if (input.productIds) leg.productIds = [...input.productIds];
  if (input.collectionIds) leg.collectionIds = [...input.collectionIds];
  if (input.discountPercent !== undefined) leg.discountPercent = input.discountPercent;
  return leg;
}

/** Build the persisted code sub-documents from a list of raw code strings. */
function buildCodes(codes: string[]): IDiscountCode[] {
  return codes.map((code) => ({ code: normalizeDiscountCode(code), usageCount: 0 }));
}

/** Serialize a discount document to the `Discount` DTO. */
export function toDiscountDTO(discount: IDiscount): DiscountDTO {
  const dto: DiscountDTO = {
    id: String((discount as { _id: unknown })._id),
    storeId: discount.storeId,
    title: discount.title,
    method: discount.method,
    codes: discount.codes.map((c) => ({ code: c.code, usageCount: c.usageCount })),
    valueType: discount.valueType,
    value: discount.value,
    appliesTo: {
      scope: discount.appliesTo.scope,
      ...(discount.appliesTo.productIds ? { productIds: [...discount.appliesTo.productIds] } : {}),
      ...(discount.appliesTo.collectionIds
        ? { collectionIds: [...discount.appliesTo.collectionIds] }
        : {}),
    },
    combinesWith: {
      orderDiscounts: discount.combinesWith.orderDiscounts,
      productDiscounts: discount.combinesWith.productDiscounts,
      shippingDiscounts: discount.combinesWith.shippingDiscounts,
    },
    startsAt: discount.startsAt.toISOString(),
    isActive: discount.isActive,
    createdAt: discount.createdAt.toISOString(),
    updatedAt: discount.updatedAt.toISOString(),
  };
  if (discount.buy) {
    dto.buy = {
      quantity: discount.buy.quantity,
      scope: discount.buy.scope,
      ...(discount.buy.productIds ? { productIds: [...discount.buy.productIds] } : {}),
      ...(discount.buy.collectionIds ? { collectionIds: [...discount.buy.collectionIds] } : {}),
      ...(discount.buy.discountPercent !== undefined
        ? { discountPercent: discount.buy.discountPercent }
        : {}),
    };
  }
  if (discount.get) {
    dto.get = {
      quantity: discount.get.quantity,
      scope: discount.get.scope,
      ...(discount.get.productIds ? { productIds: [...discount.get.productIds] } : {}),
      ...(discount.get.collectionIds ? { collectionIds: [...discount.get.collectionIds] } : {}),
      ...(discount.get.discountPercent !== undefined
        ? { discountPercent: discount.get.discountPercent }
        : {}),
    };
  }
  if (discount.minimumRequirement) {
    dto.minimumRequirement = {
      type: discount.minimumRequirement.type,
      value: discount.minimumRequirement.value,
    };
  }
  if (discount.customerEligibility) {
    dto.customerEligibility = {
      type: discount.customerEligibility.type,
      ...(discount.customerEligibility.customerIds
        ? { customerIds: [...discount.customerEligibility.customerIds] }
        : {}),
      ...(discount.customerEligibility.groupTags
        ? { groupTags: [...discount.customerEligibility.groupTags] }
        : {}),
    };
  }
  if (discount.usageLimits) {
    dto.usageLimits = {
      ...(discount.usageLimits.totalMax !== undefined
        ? { totalMax: discount.usageLimits.totalMax }
        : {}),
      ...(discount.usageLimits.perCustomerMax !== undefined
        ? { perCustomerMax: discount.usageLimits.perCustomerMax }
        : {}),
    };
  }
  if (discount.endsAt) {
    dto.endsAt = discount.endsAt.toISOString();
  }
  return dto;
}

/** List a store's discounts, newest first. */
export async function listDiscounts(storeId: string): Promise<IDiscount[]> {
  return Discount.find({ storeId }).sort({ createdAt: -1 }).lean<IDiscount[]>();
}

/** Load one discount scoped to its store, or throw NOT_FOUND. */
export async function getDiscount(storeId: string, discountId: string): Promise<IDiscount> {
  const discount = await Discount.findOne({ _id: discountId, storeId }).lean<IDiscount | null>();
  if (!discount) {
    throw notFound('Discount not found');
  }
  return discount;
}

/**
 * Create a discount for a store. Code uniqueness per store is enforced by the
 * sparse unique index; a duplicate code maps to a CONFLICT. `startsAt` defaults to
 * now when omitted; `combinesWith` defaults to stacking with nothing.
 */
export async function createDiscount(
  storeId: string,
  input: CreateDiscountInput,
): Promise<IDiscount> {
  const doc: Partial<IDiscount> = {
    storeId,
    title: input.title,
    method: input.method,
    codes: buildCodes(input.codes ?? []),
    valueType: input.valueType,
    value: input.value,
    appliesTo: buildAppliesTo(input.appliesTo),
    combinesWith: resolveCombinesWith(input.combinesWith),
    startsAt: input.startsAt ? new Date(input.startsAt) : new Date(),
    isActive: input.isActive ?? true,
  };
  if (input.buy) doc.buy = buildLeg(input.buy);
  if (input.get) doc.get = buildLeg(input.get);
  if (input.minimumRequirement) doc.minimumRequirement = { ...input.minimumRequirement };
  if (input.customerEligibility) {
    doc.customerEligibility = {
      type: input.customerEligibility.type,
      ...(input.customerEligibility.customerIds
        ? { customerIds: [...input.customerEligibility.customerIds] }
        : {}),
      ...(input.customerEligibility.groupTags
        ? { groupTags: [...input.customerEligibility.groupTags] }
        : {}),
    };
  }
  if (input.usageLimits) doc.usageLimits = { ...input.usageLimits };
  if (input.endsAt) doc.endsAt = new Date(input.endsAt);

  try {
    const created = await Discount.create(doc);
    return created.toObject();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict('A discount with that code already exists');
    }
    throw err;
  }
}

/**
 * Update a discount in place (scoped to `storeId`, else NOT_FOUND). A code change
 * is guarded by the unique index → CONFLICT on collision. Only the supplied fields
 * are touched; `codes` (when supplied) are normalized and reset (usage counts
 * start fresh for any newly-minted code, preserved for codes already present).
 */
export async function updateDiscount(
  storeId: string,
  discountId: string,
  patch: UpdateDiscountInput,
): Promise<IDiscount> {
  const discount = await Discount.findOne({ _id: discountId, storeId });
  if (!discount) {
    throw notFound('Discount not found');
  }

  if (patch.title !== undefined) discount.title = patch.title;
  if (patch.method !== undefined) discount.method = patch.method;
  if (patch.codes !== undefined) {
    // Preserve existing usage counts for codes that survive the edit.
    const existingByCode = new Map(discount.codes.map((c) => [c.code, c.usageCount]));
    discount.codes = patch.codes.map((raw) => {
      const code = normalizeDiscountCode(raw);
      return { code, usageCount: existingByCode.get(code) ?? 0 };
    });
  }
  if (patch.valueType !== undefined) discount.valueType = patch.valueType;
  if (patch.value !== undefined) discount.value = patch.value;
  if (patch.appliesTo !== undefined) discount.appliesTo = buildAppliesTo(patch.appliesTo);
  if (patch.buy !== undefined) discount.buy = buildLeg(patch.buy);
  // `get` is also `Document.get` — assign through `set('get', …)` to avoid the
  // method/field name collision while keeping the path typed.
  if (patch.get !== undefined) discount.set('get', buildLeg(patch.get));
  if (patch.minimumRequirement !== undefined) {
    discount.minimumRequirement = { ...patch.minimumRequirement };
  }
  if (patch.customerEligibility !== undefined) {
    discount.customerEligibility = {
      type: patch.customerEligibility.type,
      ...(patch.customerEligibility.customerIds
        ? { customerIds: [...patch.customerEligibility.customerIds] }
        : {}),
      ...(patch.customerEligibility.groupTags
        ? { groupTags: [...patch.customerEligibility.groupTags] }
        : {}),
    };
  }
  if (patch.usageLimits !== undefined) discount.usageLimits = { ...patch.usageLimits };
  if (patch.combinesWith !== undefined) {
    discount.combinesWith = resolveCombinesWith({
      ...discount.combinesWith,
      ...patch.combinesWith,
    });
  }
  if (patch.startsAt !== undefined) discount.startsAt = new Date(patch.startsAt);
  if (patch.endsAt !== undefined) discount.endsAt = new Date(patch.endsAt);
  if (patch.isActive !== undefined) discount.isActive = patch.isActive;

  try {
    await discount.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict('A discount with that code already exists');
    }
    throw err;
  }
  return discount.toObject();
}

/** Delete a discount (scoped to `storeId`, else NOT_FOUND). */
export async function deleteDiscount(storeId: string, discountId: string): Promise<void> {
  const result = await Discount.deleteOne({ _id: discountId, storeId });
  if (result.deletedCount === 0) {
    throw notFound('Discount not found');
  }
}
