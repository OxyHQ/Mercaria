/**
 * Discount service — store-admin lifecycle for promotions (B4).
 *
 * Owns create/list/get/update/delete for a store's discounts plus the `Discount`
 * DTO serializer. Codes are normalized to UPPERCASE and unique PER STORE
 * (`discount_codes_store_id_code_key`); a duplicate maps to a CONFLICT. Every
 * operation is scoped to its `storeId`, so a member only operates on their own
 * store's discounts.
 *
 * The pricing/redemption side (gating, amount math, usage increments) lives in
 * `pricing.service` + `checkout.service`; this module is purely the admin CRUD.
 *
 * ## The DTO reassembles what the schema flattened
 *
 * Mongo held `appliesTo`, `buy`, `get`, `minimumRequirement`,
 * `customerEligibility` and `usageLimits` as nested sub-documents; Postgres holds
 * each field as its own column. The wire shape does NOT change — clients and the
 * dashboard still receive the nested `Discount` DTO — so this serializer is where
 * the two representations meet, and it is the only place that knows both.
 *
 * A sub-document is emitted only when the schema really has one: `buy`/`get` are
 * keyed on their `quantity` column being non-NULL, because a leg with a scope and
 * no quantity is not a leg the engine can reward against, and emitting it would
 * put a half-formed object on the wire that no client can render.
 */

import type {
  CreateDiscountInput,
  UpdateDiscountInput,
  Discount as DiscountDTO,
  DiscountCombinesWith,
  DiscountScope,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  deleteDiscount as deleteDiscountRow,
  findDiscount,
  findDiscountsForStore,
  insertDiscount,
  updateDiscount as updateDiscountRow,
  type DiscountLegInput,
  type DiscountPatch,
  type DiscountRecord,
} from '../db/merchandising/discountRepository.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';

export type { DiscountRecord };

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

/** Build a repository buy/get leg from input (omit absent optionals). */
function buildLeg(input: NonNullable<CreateDiscountInput['buy']>): DiscountLegInput {
  const leg: DiscountLegInput = { quantity: input.quantity, scope: input.scope };
  if (input.productIds) leg.productIds = [...input.productIds];
  if (input.collectionIds) leg.collectionIds = [...input.collectionIds];
  if (input.discountPercent !== undefined) leg.discountPercent = input.discountPercent;
  return leg;
}

/** One buy/get leg of the DTO, or `undefined` when the row has no such leg. */
function toLegDTO(
  quantity: number | null,
  scope: Exclude<DiscountScope, 'order'> | null,
  productIds: string[] | null,
  collectionIds: string[] | null,
  discountPercent: number | null,
): DiscountDTO['buy'] | undefined {
  if (quantity === null || scope === null) return undefined;
  return {
    quantity,
    scope,
    ...(productIds ? { productIds: [...productIds] } : {}),
    ...(collectionIds ? { collectionIds: [...collectionIds] } : {}),
    ...(discountPercent !== null ? { discountPercent } : {}),
  };
}

/** Serialize a discount row (with its codes) to the `Discount` DTO. */
export function toDiscountDTO(discount: DiscountRecord): DiscountDTO {
  const dto: DiscountDTO = {
    id: discount.id,
    storeId: discount.storeId,
    title: discount.title,
    method: discount.method,
    codes: discount.codes.map((c) => ({ code: c.code, usageCount: c.usageCount })),
    valueType: discount.valueType,
    value: discount.value,
    appliesTo: {
      scope: discount.appliesToScope,
      ...(discount.appliesToProductIds ? { productIds: [...discount.appliesToProductIds] } : {}),
      ...(discount.appliesToCollectionIds
        ? { collectionIds: [...discount.appliesToCollectionIds] }
        : {}),
    },
    combinesWith: {
      orderDiscounts: discount.combinesWithOrderDiscounts,
      productDiscounts: discount.combinesWithProductDiscounts,
      shippingDiscounts: discount.combinesWithShippingDiscounts,
    },
    startsAt: discount.startsAt.toISOString(),
    isActive: discount.isActive,
    createdAt: discount.createdAt.toISOString(),
    updatedAt: discount.updatedAt.toISOString(),
  };

  const buy = toLegDTO(
    discount.buyQuantity,
    discount.buyScope,
    discount.buyProductIds,
    discount.buyCollectionIds,
    discount.buyDiscountPercent,
  );
  if (buy) dto.buy = buy;

  const get = toLegDTO(
    discount.getQuantity,
    discount.getScope,
    discount.getProductIds,
    discount.getCollectionIds,
    discount.getDiscountPercent,
  );
  if (get) dto.get = get;

  // Both columns move together, so the sub-document is emitted only when the
  // VALUE is present — a type with no threshold is not a requirement to render.
  if (discount.minimumRequirementType !== null && discount.minimumRequirementValue !== null) {
    dto.minimumRequirement = {
      type: discount.minimumRequirementType,
      value: discount.minimumRequirementValue,
    };
  }
  if (discount.customerEligibilityType !== null) {
    dto.customerEligibility = {
      type: discount.customerEligibilityType,
      ...(discount.customerEligibilityCustomerIds
        ? { customerIds: [...discount.customerEligibilityCustomerIds] }
        : {}),
      ...(discount.customerEligibilityGroupTags
        ? { groupTags: [...discount.customerEligibilityGroupTags] }
        : {}),
    };
  }
  if (discount.usageLimitsTotalMax !== null || discount.usageLimitsPerCustomerMax !== null) {
    dto.usageLimits = {
      ...(discount.usageLimitsTotalMax !== null ? { totalMax: discount.usageLimitsTotalMax } : {}),
      ...(discount.usageLimitsPerCustomerMax !== null
        ? { perCustomerMax: discount.usageLimitsPerCustomerMax }
        : {}),
    };
  }
  if (discount.endsAt) {
    dto.endsAt = discount.endsAt.toISOString();
  }
  return dto;
}

/** List a store's discounts, newest first. */
export async function listDiscounts(storeId: string): Promise<DiscountRecord[]> {
  return findDiscountsForStore(storeId);
}

/** Load one discount scoped to its store, or throw NOT_FOUND. */
export async function getDiscount(
  storeId: string,
  discountId: string,
): Promise<DiscountRecord> {
  const discount = await findDiscount(storeId, discountId);
  if (!discount) {
    throw notFound('Discount not found');
  }
  return discount;
}

/**
 * Create a discount for a store. Code uniqueness per store is enforced by
 * `discount_codes_store_id_code_key`; a duplicate maps to a CONFLICT. `startsAt`
 * defaults to now when omitted; `combinesWith` defaults to stacking with nothing.
 */
export async function createDiscount(
  storeId: string,
  input: CreateDiscountInput,
): Promise<DiscountRecord> {
  try {
    return await insertDiscount(storeId, {
      title: input.title,
      method: input.method,
      valueType: input.valueType,
      value: input.value,
      appliesTo: {
        scope: input.appliesTo.scope,
        ...(input.appliesTo.productIds ? { productIds: [...input.appliesTo.productIds] } : {}),
        ...(input.appliesTo.collectionIds
          ? { collectionIds: [...input.appliesTo.collectionIds] }
          : {}),
      },
      ...(input.buy ? { buy: buildLeg(input.buy) } : {}),
      ...(input.get ? { get: buildLeg(input.get) } : {}),
      ...(input.minimumRequirement ? { minimumRequirement: { ...input.minimumRequirement } } : {}),
      ...(input.customerEligibility
        ? {
            customerEligibility: {
              type: input.customerEligibility.type,
              ...(input.customerEligibility.customerIds
                ? { customerIds: [...input.customerEligibility.customerIds] }
                : {}),
              ...(input.customerEligibility.groupTags
                ? { groupTags: [...input.customerEligibility.groupTags] }
                : {}),
            },
          }
        : {}),
      ...(input.usageLimits ? { usageLimits: { ...input.usageLimits } } : {}),
      combinesWith: resolveCombinesWith(input.combinesWith),
      startsAt: input.startsAt ? new Date(input.startsAt) : new Date(),
      ...(input.endsAt ? { endsAt: new Date(input.endsAt) } : {}),
      isActive: input.isActive ?? true,
      codes: (input.codes ?? []).map(normalizeDiscountCode),
    });
  } catch (err) {
    if (isUniqueViolation(err, 'discount_codes_store_id_code_key')) {
      throw conflict('A discount with that code already exists');
    }
    throw err;
  }
}

/**
 * Update a discount in place (scoped to `storeId`, else NOT_FOUND). A code change
 * is guarded by the unique index → CONFLICT on collision. Only the supplied
 * fields are touched; supplied `codes` are normalized and replace the set, with
 * usage counts preserved for codes that survive the edit (see the repository).
 */
export async function updateDiscount(
  storeId: string,
  discountId: string,
  patch: UpdateDiscountInput,
): Promise<DiscountRecord> {
  const repositoryPatch: DiscountPatch = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.method !== undefined ? { method: patch.method } : {}),
    ...(patch.valueType !== undefined ? { valueType: patch.valueType } : {}),
    ...(patch.value !== undefined ? { value: patch.value } : {}),
    ...(patch.appliesTo !== undefined
      ? {
          appliesTo: {
            scope: patch.appliesTo.scope,
            ...(patch.appliesTo.productIds ? { productIds: [...patch.appliesTo.productIds] } : {}),
            ...(patch.appliesTo.collectionIds
              ? { collectionIds: [...patch.appliesTo.collectionIds] }
              : {}),
          },
        }
      : {}),
    ...(patch.buy !== undefined ? { buy: buildLeg(patch.buy) } : {}),
    ...(patch.get !== undefined ? { get: buildLeg(patch.get) } : {}),
    ...(patch.minimumRequirement !== undefined
      ? { minimumRequirement: { ...patch.minimumRequirement } }
      : {}),
    ...(patch.customerEligibility !== undefined
      ? {
          customerEligibility: {
            type: patch.customerEligibility.type,
            ...(patch.customerEligibility.customerIds
              ? { customerIds: [...patch.customerEligibility.customerIds] }
              : {}),
            ...(patch.customerEligibility.groupTags
              ? { groupTags: [...patch.customerEligibility.groupTags] }
              : {}),
          },
        }
      : {}),
    ...(patch.usageLimits !== undefined ? { usageLimits: { ...patch.usageLimits } } : {}),
    ...(patch.combinesWith !== undefined
      ? { combinesWith: resolveCombinesWith(patch.combinesWith) }
      : {}),
    ...(patch.startsAt !== undefined ? { startsAt: new Date(patch.startsAt) } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: new Date(patch.endsAt) } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.codes !== undefined ? { codes: patch.codes.map(normalizeDiscountCode) } : {}),
  };

  try {
    const updated = await updateDiscountRow(storeId, discountId, repositoryPatch);
    if (!updated) {
      throw notFound('Discount not found');
    }
    return updated;
  } catch (err) {
    if (isUniqueViolation(err, 'discount_codes_store_id_code_key')) {
      throw conflict('A discount with that code already exists');
    }
    throw err;
  }
}

/** Delete a discount (scoped to `storeId`, else NOT_FOUND). */
export async function deleteDiscount(storeId: string, discountId: string): Promise<void> {
  const deleted = await deleteDiscountRow(storeId, discountId);
  if (!deleted) {
    throw notFound('Discount not found');
  }
}
