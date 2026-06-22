/**
 * Order hydration service.
 *
 * Turns raw `IOrder` documents into client-ready `Order` / `OrderSummary` DTOs,
 * doing ALL Oxy + DB lookups in BATCHES (no N+1): for a list of orders it issues
 * exactly ONE `getProfiles` (distinct P2P seller ids), ONE `SellerProfile.find`
 * and ONE `Store.find`, then assembles each DTO from the precomputed maps.
 *
 * Order line items are IMMUTABLE snapshots — they are mapped VERBATIM from the
 * persisted order and NEVER re-read from the live catalog. This module is the
 * ONLY place order DTOs are built; controllers never hand-assemble order shapes.
 */

import mongoose from 'mongoose';
import type {
  Money,
  Order as OrderDTO,
  OrderItem,
  OrderSummary,
  Seller,
  ShippingInfo,
  PaymentInfo,
  AddressSnapshot,
  OrderStatusEvent,
  DiscountAllocation,
  TaxLine,
} from '@mercaria/shared-types';
import {
  type IOrder,
  type IOrderItem,
  type IAddressSnapshot,
  type IShippingSnapshot,
  type IPaymentInfo,
  type IOrderStatusEvent,
  type IDiscountAllocation,
  type ITaxLine,
} from '../models/order.js';
import { SellerProfile, type ISellerProfile } from '../models/seller-profile.js';
import { Store, type IStore } from '../models/store.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { resolveMedia, toMerchantSummary } from './catalog-hydration.service.js';

/** Map a persisted `{ amount, currency }` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/**
 * Build a minimal `Seller` DTO from the seller profile aggregates + the Oxy
 * identity. Mirrors `catalog-hydration`'s (non-exported) `toSeller`: when the Oxy
 * profile is missing it falls back to a minimal seller (displayName = username =
 * oxyUserId) so the request never breaks.
 */
function toSeller(
  oxyUserId: string,
  profile: ISellerProfile | undefined,
  oxyProfile: OxyProfile | undefined,
): Seller {
  const seller: Seller = {
    id: profile ? String((profile as { _id: mongoose.Types.ObjectId })._id) : oxyUserId,
    oxyUserId,
    displayName: oxyProfile?.displayName ?? oxyUserId,
    username: oxyProfile?.username ?? oxyUserId,
    avatar: oxyProfile?.avatar ? resolveMedia(oxyProfile.avatar) : oxyProfile?.avatar ?? null,
    isVerified: profile?.isVerified ?? false,
  };
  if (profile && profile.reviewCount > 0) {
    seller.rating = profile.rating;
    seller.reviewCount = profile.reviewCount;
  }
  return seller;
}

/** Map a stored immutable line item snapshot to the `OrderItem` DTO (verbatim). */
export function toOrderItemDTO(item: IOrderItem): OrderItem {
  const dto: OrderItem = {
    listingId: String(item.listingId),
    variantId: String(item.variantId),
    title: item.title,
    variantTitle: item.variantTitle,
    optionValues: item.optionValues.map((o) => ({ name: o.name, value: o.value })),
    unitPrice: toMoney(item.unitPrice),
    quantity: item.quantity,
    lineTotal: toMoney(item.lineTotal),
  };
  if (item.imageUrl) {
    dto.imageUrl = item.imageUrl;
  }
  if (item.discountTotal) {
    dto.discountTotal = toMoney(item.discountTotal);
  }
  if (item.locationId) {
    dto.locationId = item.locationId;
  }
  return dto;
}

/** Map a persisted discount allocation to the `DiscountAllocation` DTO. */
function toDiscountAllocation(allocation: IDiscountAllocation): DiscountAllocation {
  const dto: DiscountAllocation = {
    discountId: String(allocation.discountId),
    title: allocation.title,
    valueType: allocation.valueType as DiscountAllocation['valueType'],
    amount: toMoney(allocation.amount),
    target: allocation.target,
  };
  if (allocation.code) {
    dto.code = allocation.code;
  }
  if (allocation.targetLineIndex !== undefined) {
    dto.targetLineIndex = allocation.targetLineIndex;
  }
  return dto;
}

/** Map a persisted tax line to the `TaxLine` DTO. */
function toTaxLine(line: ITaxLine): TaxLine {
  return { name: line.name, rateBps: line.rateBps, amount: toMoney(line.amount) };
}

/** Map the persisted address snapshot to the `AddressSnapshot` DTO (omit absent optionals). */
function toAddressSnapshot(snapshot: IAddressSnapshot): AddressSnapshot {
  const dto: AddressSnapshot = {
    recipientName: snapshot.recipientName,
    line1: snapshot.line1,
    city: snapshot.city,
    postalCode: snapshot.postalCode,
    country: snapshot.country,
  };
  if (snapshot.label) {
    dto.label = snapshot.label;
  }
  if (snapshot.line2) {
    dto.line2 = snapshot.line2;
  }
  if (snapshot.region) {
    dto.region = snapshot.region;
  }
  if (snapshot.phone) {
    dto.phone = snapshot.phone;
  }
  return dto;
}

/** Map the persisted shipping snapshot to the `ShippingInfo` DTO (drop null tracking). */
function toShippingInfo(shipping: IShippingSnapshot): ShippingInfo {
  const dto: ShippingInfo = {
    method: shipping.method,
    label: shipping.label,
    cost: toMoney(shipping.cost),
  };
  if (shipping.trackingNumber) {
    dto.trackingNumber = shipping.trackingNumber;
  }
  return dto;
}

/** Map the persisted payment sub-document to the `PaymentInfo` DTO. */
function toPaymentInfo(payment: IPaymentInfo): PaymentInfo {
  const dto: PaymentInfo = {
    status: payment.status,
    provider: payment.provider,
  };
  if (payment.reference) {
    dto.reference = payment.reference;
  }
  if (payment.paidAt) {
    dto.paidAt = payment.paidAt.toISOString();
  }
  return dto;
}

/** Map a persisted status event to the `OrderStatusEvent` DTO. */
function toStatusEvent(event: IOrderStatusEvent): OrderStatusEvent {
  const dto: OrderStatusEvent = {
    status: event.status,
    at: event.at.toISOString(),
  };
  if (event.byOxyUserId) {
    dto.byOxyUserId = event.byOxyUserId;
  }
  if (event.note) {
    dto.note = event.note;
  }
  return dto;
}

/**
 * Batched lookup of the seller (P2P) + store identities referenced by a list of
 * orders: ONE `getProfiles`, ONE `SellerProfile.find`, ONE `Store.find`.
 */
async function loadSellerContext(orders: IOrder[]): Promise<{
  oxyProfiles: Map<string, OxyProfile>;
  sellerProfileByUser: Map<string, ISellerProfile>;
  storeById: Map<string, IStore>;
}> {
  const userSellerIds = [
    ...new Set(
      orders
        .filter((o) => o.sellerType === 'user' && o.sellerOxyUserId)
        .map((o) => String(o.sellerOxyUserId)),
    ),
  ];
  const storeIds = [
    ...new Set(
      orders.filter((o) => o.sellerType === 'store' && o.storeId).map((o) => String(o.storeId)),
    ),
  ];

  const [sellerProfileDocs, storeDocs, oxyProfiles] = await Promise.all([
    userSellerIds.length > 0
      ? SellerProfile.find({ oxyUserId: { $in: userSellerIds } }).lean<ISellerProfile[]>()
      : Promise.resolve([] as ISellerProfile[]),
    storeIds.length > 0
      ? Store.find({ _id: { $in: storeIds } }).lean<IStore[]>()
      : Promise.resolve([] as IStore[]),
    getProfiles(userSellerIds),
  ]);

  const sellerProfileByUser = new Map<string, ISellerProfile>();
  for (const p of sellerProfileDocs) {
    sellerProfileByUser.set(String(p.oxyUserId), p);
  }
  const storeById = new Map<string, IStore>();
  for (const s of storeDocs) {
    storeById.set(String((s as { _id: mongoose.Types.ObjectId })._id), s);
  }

  return { oxyProfiles, sellerProfileByUser, storeById };
}

/**
 * Hydrate raw order docs into client-ready `Order` DTOs with batched Oxy/DB
 * lookups. Maps the persisted `shippingAddressSnapshot` to the DTO's
 * `shippingAddress`, and serializes every `Date` to ISO-8601. Preserves order.
 */
export async function hydrateOrders(orders: IOrder[]): Promise<OrderDTO[]> {
  if (orders.length === 0) {
    return [];
  }

  const { oxyProfiles, sellerProfileByUser, storeById } = await loadSellerContext(orders);

  return orders.map((order) => {
    // Zero in the order's settlement currency — the back-compat fallback for the
    // discount/tax totals on pre-B4 orders that predate those fields.
    const zero: Money = { amount: 0, currency: toMoney(order.totals.subtotal).currency };
    const dto: OrderDTO = {
      id: String((order as { _id: mongoose.Types.ObjectId })._id),
      orderNumber: order.orderNumber,
      buyerOxyUserId: String(order.buyerOxyUserId),
      sellerType: order.sellerType,
      // Back-compat: pre-B5 orders carry no sourceChannel → online storefront.
      sourceChannel: order.sourceChannel ?? 'storefront',
      items: order.items.map(toOrderItemDTO),
      shippingAddress: toAddressSnapshot(order.shippingAddressSnapshot),
      shipping: toShippingInfo(order.shipping),
      totals: {
        subtotal: toMoney(order.totals.subtotal),
        discountTotal: order.totals.discountTotal ? toMoney(order.totals.discountTotal) : zero,
        shipping: toMoney(order.totals.shipping),
        tax: order.totals.tax ? toMoney(order.totals.tax) : zero,
        grandTotal: toMoney(order.totals.grandTotal),
      },
      appliedDiscounts: (order.appliedDiscounts ?? []).map(toDiscountAllocation),
      taxLines: (order.taxLines ?? []).map(toTaxLine),
      status: order.status,
      statusHistory: order.statusHistory.map(toStatusEvent),
      payment: toPaymentInfo(order.payment),
      checkoutGroupId: String(order.checkoutGroupId),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };

    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      const oxyUserId = String(order.sellerOxyUserId);
      dto.sellerOxyUserId = oxyUserId;
      dto.seller = toSeller(oxyUserId, sellerProfileByUser.get(oxyUserId), oxyProfiles.get(oxyUserId));
    } else if (order.sellerType === 'store' && order.storeId) {
      const storeId = String(order.storeId);
      dto.storeId = storeId;
      const store = storeById.get(storeId);
      if (store) {
        dto.store = toMerchantSummary(store, []);
      }
    }

    if (order.customerId) {
      dto.customerId = String(order.customerId);
    }

    return dto;
  });
}

/**
 * Summarize raw order docs into `OrderSummary` DTOs (buyer/seller list views),
 * with the same batched seller/store load as `hydrateOrders`. Preserves order.
 */
export async function summarizeOrders(orders: IOrder[]): Promise<OrderSummary[]> {
  if (orders.length === 0) {
    return [];
  }

  const { oxyProfiles, sellerProfileByUser, storeById } = await loadSellerContext(orders);

  return orders.map((order) => {
    const summary: OrderSummary = {
      id: String((order as { _id: mongoose.Types.ObjectId })._id),
      orderNumber: order.orderNumber,
      status: order.status,
      grandTotal: toMoney(order.totals.grandTotal),
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      sellerType: order.sellerType,
      createdAt: order.createdAt.toISOString(),
    };

    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      const oxyUserId = String(order.sellerOxyUserId);
      summary.seller = toSeller(
        oxyUserId,
        sellerProfileByUser.get(oxyUserId),
        oxyProfiles.get(oxyUserId),
      );
    } else if (order.sellerType === 'store' && order.storeId) {
      const store = storeById.get(String(order.storeId));
      if (store) {
        summary.store = toMerchantSummary(store, []);
      }
    }

    return summary;
  });
}
