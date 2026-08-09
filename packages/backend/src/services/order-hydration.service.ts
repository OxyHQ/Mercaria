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

import type {
  BuyerContactProjection,
  CurrencyCode,
  DualMoney,
  FxRateSnapshot,
  MerchantBuyerLabel,
  MerchantOrder,
  MerchantOrderSummary,
  Order as OrderDTO,
  OrderBuyer,
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
import type {
  OrderAppliedDiscountRow,
  OrderItemRecord,
  OrderRecord,
  OrderStatusEventRow,
  OrderTaxLineRow,
} from '../db/orders/orderRepository.js';
import {
  findSellerProfilesByUserIds,
  type SellerProfileRecord,
} from '../db/buyers/sellerProfileRepository.js';
import { findStoresByIds, type StoreRow } from '../db/stores/storeRepository.js';
import { findGuestContactsByIds } from '../db/guests/guestCheckoutRepository.js';
import { getDb } from '../db/postgres.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { orderBuyerOf } from './orders/order-buyer.js';
import { resolveMedia, toMerchantSummary } from './catalog-hydration.service.js';

/**
 * The four columns of a `DualMoney`, reassembled.
 *
 * Every amount on an order is four flat columns, and this is where they become
 * the nested `{shop, presentment}` the DTO has always carried. Taking the four
 * VALUES rather than a row plus a prefix is deliberate: a prefix would be a
 * string the compiler cannot check, and `unitPrice` versus `lineTotal` is exactly
 * the kind of typo that produces a plausible wrong number.
 */
function dual(
  shopAmount: number,
  shopCurrency: CurrencyCode,
  presentmentAmount: number,
  presentmentCurrency: CurrencyCode,
): DualMoney {
  return {
    shop: { amount: shopAmount, currency: shopCurrency },
    presentment: { amount: presentmentAmount, currency: presentmentCurrency },
  };
}

/** {@link dual} for an OPTIONAL amount — all four columns are absent together. */
function optionalDual(
  shopAmount: number | null,
  shopCurrency: CurrencyCode | null,
  presentmentAmount: number | null,
  presentmentCurrency: CurrencyCode | null,
): DualMoney | undefined {
  if (
    shopAmount === null ||
    shopCurrency === null ||
    presentmentAmount === null ||
    presentmentCurrency === null
  ) {
    return undefined;
  }
  return dual(shopAmount, shopCurrency, presentmentAmount, presentmentCurrency);
}

/**
 * Build a minimal `Seller` DTO from the seller profile aggregates + the Oxy
 * identity. Mirrors `catalog-hydration`'s (non-exported) `toSeller`: when the Oxy
 * profile is missing it falls back to a minimal seller (displayName = username =
 * oxyUserId) so the request never breaks.
 */
function toSeller(
  oxyUserId: string,
  profile: SellerProfileRecord | undefined,
  oxyProfile: OxyProfile | undefined,
): Seller {
  const seller: Seller = {
    id: profile ? profile.id : oxyUserId,
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
export function toOrderItemDTO(item: OrderItemRecord): OrderItem {
  const dto: OrderItem = {
    listingId: item.listingId,
    variantId: item.variantId,
    title: item.title,
    variantTitle: item.variantTitle,
    optionValues: item.optionValues.map((o) => ({ name: o.name, value: o.value })),
    unitPrice: dual(
      item.unitPriceShopAmount,
      item.unitPriceShopCurrency,
      item.unitPricePresentmentAmount,
      item.unitPricePresentmentCurrency,
    ),
    quantity: item.quantity,
    lineTotal: dual(
      item.lineTotalShopAmount,
      item.lineTotalShopCurrency,
      item.lineTotalPresentmentAmount,
      item.lineTotalPresentmentCurrency,
    ),
  };
  if (item.imageUrl) {
    dto.imageUrl = item.imageUrl;
  }
  const discountTotal = optionalDual(
    item.discountTotalShopAmount,
    item.discountTotalShopCurrency,
    item.discountTotalPresentmentAmount,
    item.discountTotalPresentmentCurrency,
  );
  if (discountTotal) {
    dto.discountTotal = discountTotal;
  }
  if (item.locationId) {
    dto.locationId = item.locationId;
  }
  return dto;
}

/** Map a persisted discount allocation to the `DiscountAllocation` DTO. */
function toDiscountAllocation(allocation: OrderAppliedDiscountRow): DiscountAllocation {
  const dto: DiscountAllocation = {
    discountId: allocation.discountId,
    title: allocation.title,
    valueType: allocation.valueType,
    amount: { amount: allocation.amountAmount, currency: allocation.amountCurrency },
    target: allocation.target,
  };
  if (allocation.code) {
    dto.code = allocation.code;
  }
  // `null`, not `undefined`: the column is nullable and only a LINE-targeted
  // allocation carries an index (`order_applied_discounts_target_line_check`).
  if (allocation.targetLineIndex !== null) {
    dto.targetLineIndex = allocation.targetLineIndex;
  }
  return dto;
}

/** Map a persisted tax line to the `TaxLine` DTO. */
function toTaxLine(line: OrderTaxLineRow): TaxLine {
  return {
    name: line.name,
    rateBps: line.rateBps,
    amount: { amount: line.amountAmount, currency: line.amountCurrency },
  };
}

/** Map the snapshotted shipping address columns to the `AddressSnapshot` DTO. */
function toAddressSnapshot(order: OrderRecord): AddressSnapshot {
  const dto: AddressSnapshot = {
    recipientName: order.shippingAddressRecipientName,
    line1: order.shippingAddressLine1,
    city: order.shippingAddressCity,
    postalCode: order.shippingAddressPostalCode,
    country: order.shippingAddressCountry,
  };
  if (order.shippingAddressLabel) {
    dto.label = order.shippingAddressLabel;
  }
  if (order.shippingAddressLine2) {
    dto.line2 = order.shippingAddressLine2;
  }
  if (order.shippingAddressRegion) {
    dto.region = order.shippingAddressRegion;
  }
  if (order.shippingAddressPhone) {
    dto.phone = order.shippingAddressPhone;
  }
  return dto;
}

/** Map the shipping columns to the `ShippingInfo` DTO (drop null tracking). */
function toShippingInfo(order: OrderRecord): ShippingInfo {
  const dto: ShippingInfo = {
    method: order.shippingMethod,
    label: order.shippingLabel,
    cost: dual(
      order.shippingCostShopAmount,
      order.shippingCostShopCurrency,
      order.shippingCostPresentmentAmount,
      order.shippingCostPresentmentCurrency,
    ),
  };
  if (order.shippingTrackingNumber) {
    dto.trackingNumber = order.shippingTrackingNumber;
  }
  return dto;
}

/**
 * Map the payment columns to the `PaymentInfo` DTO.
 *
 * `provider` and `paymentId` are OMITTED when absent rather than defaulted: an
 * order with reserved stock and no payment has neither, and the retired
 * `oxy_pay` default asserted a rail for every such order. Everything else a
 * payment knows stays in the payment domain and is reached through `paymentId`.
 *
 * `reference` is deliberately absent too, for a different reason: it is a
 * PROTECTED column, so the order row this reads does not carry it at all. Adding
 * it back here would not compile, which is the guard working rather than a gap.
 */
function toPaymentInfo(order: OrderRecord): PaymentInfo {
  const dto: PaymentInfo = { status: order.paymentStatus };
  if (order.paymentProvider) {
    dto.provider = order.paymentProvider;
  }
  if (order.paymentPaidAt) {
    dto.paidAt = order.paymentPaidAt.toISOString();
  }
  if (order.paymentId) {
    dto.paymentId = order.paymentId;
  }
  return dto;
}

/**
 * Map a persisted status event to the `OrderStatusEvent` DTO.
 *
 * `actorGuestSessionId` cannot be forgotten here, because the row does not
 * carry it: the column is registered in `db/protectedColumns.ts` and the
 * repository selects `PUBLIC_STATUS_EVENT_COLUMNS`, so reaching for it fails
 * `tsc` rather than shipping a guest correlation key to a merchant.
 */
function toStatusEvent(event: OrderStatusEventRow): OrderStatusEvent {
  const dto: OrderStatusEvent = {
    status: event.status,
    at: event.at.toISOString(),
    actorKind: event.actorKind,
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
 * The redacted contact projection for a batch of orders (#106 contact rules).
 *
 * ONE statement for the whole page, and it reads the order's OWN contact
 * snapshot — `guest_checkouts`, immutable by trigger and referenced by a
 * `RESTRICT` foreign key — never a live Oxy profile. That is contact rule 5
 * mechanically: there is no profile call on this path to forget to remove.
 *
 * An `oxy`-origin order gets `{source: 'oxy_account'}` and no value, because
 * Mercaria stores none: an Oxy buyer's transactional channel is Oxy's own
 * notification path, and copying their address here would create the profile
 * mirror ADR 0003 D15 says does not exist. An `external` order gets nothing at
 * all — its buyer was never Mercaria's contact.
 *
 * An ANONYMIZED contact (D15) renders as its stored `deleted`, which is the
 * honest answer: the erasure reached the one copy, which is precisely what
 * keeping one copy buys.
 */
async function loadBuyerContacts(
  orders: OrderRecord[],
): Promise<Map<string, BuyerContactProjection>> {
  const guestCheckoutIds = [
    ...new Set(orders.flatMap((o) => (o.buyerGuestCheckoutId ? [o.buyerGuestCheckoutId] : []))),
  ];
  const contacts = await findGuestContactsByIds(getDb(), guestCheckoutIds);

  const byOrderId = new Map<string, BuyerContactProjection>();
  for (const order of orders) {
    if (order.buyerOrigin === 'oxy') {
      byOrderId.set(order.id, { source: 'oxy_account' });
      continue;
    }
    if (order.buyerGuestCheckoutId === null) continue;
    const contact = contacts.get(order.buyerGuestCheckoutId);
    // A missing row is unrepresentable — the foreign key is `RESTRICT` — so
    // absence here means the id was never selected, not that the contact is
    // gone. Skipping beats fabricating an empty projection that would read as
    // "we have a contact and it is blank".
    if (!contact) continue;
    byOrderId.set(order.id, {
      source: 'guest_checkout',
      emailRedacted: contact.emailRedacted,
      ...(contact.phoneRedacted !== null ? { phoneRedacted: contact.phoneRedacted } : {}),
      verificationStage: contact.contactVerificationStage,
      marketingOptIn: contact.marketingOptIn,
      policyVersion: contact.contactPolicyVersion,
    });
  }
  return byOrderId;
}

/**
 * Batched lookup of the seller (P2P) + store identities referenced by a list of
 * orders: ONE `getProfiles`, ONE `SellerProfile.find`, ONE `Store.find`.
 *
 * `extraOxyUserIds` rides the SAME `getProfiles` call rather than adding a
 * second one — the merchant projection needs buyer handles (ADR 0003 D13's
 * display label) and `getProfiles` already dedupes across a batch. The buyer's
 * own projection passes none: a buyer does not need their own handle resolved
 * to read their order.
 */
async function loadSellerContext(
  orders: OrderRecord[],
  extraOxyUserIds: readonly string[] = [],
): Promise<{
  oxyProfiles: Map<string, OxyProfile>;
  sellerProfileByUser: Map<string, SellerProfileRecord>;
  storeById: Map<string, StoreRow>;
}> {
  const userSellerIds = [
    ...new Set(
      orders.flatMap((o) =>
        o.sellerType === 'user' && o.sellerOxyUserId ? [o.sellerOxyUserId] : [],
      ),
    ),
  ];
  const storeIds = [
    ...new Set(orders.flatMap((o) => (o.sellerType === 'store' && o.storeId ? [o.storeId] : []))),
  ];

  const [sellerProfileRows, storeDocs, oxyProfiles] = await Promise.all([
    findSellerProfilesByUserIds(userSellerIds),
    storeIds.length > 0
      ? findStoresByIds(storeIds)
      : Promise.resolve([] as StoreRow[]),
    getProfiles([...userSellerIds, ...extraOxyUserIds]),
  ]);

  const sellerProfileByUser = new Map<string, SellerProfileRecord>();
  for (const p of sellerProfileRows) {
    sellerProfileByUser.set(p.oxyUserId, p);
  }
  const storeById = new Map<string, StoreRow>();
  for (const s of storeDocs) {
    storeById.set(s.id, s);
  }

  return { oxyProfiles, sellerProfileByUser, storeById };
}

/**
 * Hydrate raw order docs into client-ready `Order` DTOs with batched Oxy/DB
 * lookups. Maps the persisted `shippingAddressSnapshot` to the DTO's
 * `shippingAddress`, and serializes every `Date` to ISO-8601. Preserves order.
 */
export async function hydrateOrders(orders: OrderRecord[]): Promise<OrderDTO[]> {
  if (orders.length === 0) {
    return [];
  }

  const [{ oxyProfiles, sellerProfileByUser, storeById }, buyerContacts] = await Promise.all([
    loadSellerContext(orders),
    loadBuyerContacts(orders),
  ]);

  return orders.map((order) => {
    const buyer = orderBuyerOf(order);
    const dto: OrderDTO = {
      id: order.id,
      orderNumber: order.orderNumber,
      buyer,
      // The v1 spelling, written only where its old meaning holds: the account
      // that PLACED the order. A claimed guest order deliberately carries none
      // — filling it with the claimant would tell an old client that an Oxy
      // account made a purchase it did not make. See `Order.buyerOxyUserId`.
      ...(buyer.origin === 'oxy' ? { buyerOxyUserId: buyer.oxyUserId } : {}),
      sellerType: order.sellerType,
      // The column is NOT NULL with a `storefront` default now, so the
      // back-compat coalesce the Mongo path needed is gone: a pre-B5 row acquires
      // the default during the backfill rather than at every read.
      sourceChannel: order.sourceChannel,
      items: order.items.map(toOrderItemDTO),
      shippingAddress: toAddressSnapshot(order),
      shipping: toShippingInfo(order),
      totals: {
        subtotal: dual(
          order.totalsSubtotalShopAmount,
          order.totalsSubtotalShopCurrency,
          order.totalsSubtotalPresentmentAmount,
          order.totalsSubtotalPresentmentCurrency,
        ),
        discountTotal: dual(
          order.totalsDiscountTotalShopAmount,
          order.totalsDiscountTotalShopCurrency,
          order.totalsDiscountTotalPresentmentAmount,
          order.totalsDiscountTotalPresentmentCurrency,
        ),
        shipping: dual(
          order.totalsShippingShopAmount,
          order.totalsShippingShopCurrency,
          order.totalsShippingPresentmentAmount,
          order.totalsShippingPresentmentCurrency,
        ),
        tax: dual(
          order.totalsTaxShopAmount,
          order.totalsTaxShopCurrency,
          order.totalsTaxPresentmentAmount,
          order.totalsTaxPresentmentCurrency,
        ),
        grandTotal: dual(
          order.totalsGrandTotalShopAmount,
          order.totalsGrandTotalShopCurrency,
          order.totalsGrandTotalPresentmentAmount,
          order.totalsGrandTotalPresentmentCurrency,
        ),
      },
      appliedDiscounts: order.appliedDiscounts.map(toDiscountAllocation),
      taxLines: order.taxLines.map(toTaxLine),
      status: order.status,
      statusHistory: order.statusHistory.map(toStatusEvent),
      payment: toPaymentInfo(order),
      checkoutGroupId: order.checkoutGroupId ?? '',
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };

    // The five fx columns are present or absent together
    // (`orders_fx_rate_complete_check`), so one non-null is enough to narrow all
    // five — but each is tested, because the CHECK constrains the DATABASE and
    // this is the only thing that constrains the TYPES.
    if (
      order.fxRateFrom !== null &&
      order.fxRateTo !== null &&
      order.fxRateRate !== null &&
      order.fxRateProvider !== null &&
      order.fxRateAsOf !== null
    ) {
      const fxRate: FxRateSnapshot = {
        from: order.fxRateFrom,
        to: order.fxRateTo,
        rate: order.fxRateRate,
        provider: order.fxRateProvider,
        asOf: order.fxRateAsOf,
      };
      dto.fxRate = fxRate;
    }

    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      const oxyUserId = order.sellerOxyUserId;
      dto.sellerOxyUserId = oxyUserId;
      dto.seller = toSeller(oxyUserId, sellerProfileByUser.get(oxyUserId), oxyProfiles.get(oxyUserId));
    } else if (order.sellerType === 'store' && order.storeId) {
      const storeId = order.storeId;
      dto.storeId = storeId;
      const store = storeById.get(storeId);
      if (store) {
        dto.store = toMerchantSummary(store, []);
      }
    }

    if (order.customerId) {
      dto.customerId = order.customerId;
    }

    const contact = buyerContacts.get(order.id);
    if (contact) {
      dto.buyerContact = contact;
    }

    return dto;
  });
}

/**
 * The buyer's display label as a SELLER sees it — ADR 0003 D13.
 *
 * Two branches and no third: a resolved Oxy handle, or the literal `Guest`. An
 * unresolvable Oxy profile falls back to the account id, which is the same
 * fallback `toSeller` above already uses and is information the merchant could
 * read from `buyer.oxyUserId` anyway.
 *
 * `Guest` is deliberately not `Guest #4821`, not a masked email and not an
 * initial: any per-guest label is a correlation key wearing a display name, and
 * invariant I11 says a seller API must not be able to correlate two of a
 * guest's purchases. An `external` order gets the same label for a different
 * reason — its buyer is the source platform's, and Mercaria has no name to
 * give.
 */
function toMerchantBuyerLabel(
  buyer: OrderBuyer,
  oxyProfiles: Map<string, OxyProfile>,
): MerchantBuyerLabel {
  if (buyer.origin !== 'oxy') {
    return { displayLabel: GUEST_BUYER_LABEL };
  }
  const profile = oxyProfiles.get(buyer.oxyUserId);
  return {
    displayLabel: profile?.displayName ?? profile?.username ?? buyer.oxyUserId,
    oxyUserId: buyer.oxyUserId,
  };
}

/**
 * The ONE label every non-`oxy` buyer gets in a merchant projection.
 *
 * A constant rather than an inline literal because it is the thing a test
 * asserts is IDENTICAL across two different guests' orders — which is the
 * property, not the spelling.
 */
export const GUEST_BUYER_LABEL = 'Guest';

/**
 * Hydrate orders for the SELLER who fulfils them (#106 DTO rule 2, D13).
 *
 * Built by re-projecting the buyer DTO rather than by assembling a second one
 * from the rows, so a field added to `Order` cannot arrive in a merchant
 * response without somebody deciding: `MerchantOrder` `Omit`s the three buyer
 * fields, and the destructure below names every one of them, so adding a fourth
 * buyer-ish field to `Order` fails `tsc` here until it is classified.
 *
 * The `buyerContact` and legacy `buyerOxyUserId` are DISCARDED, not blanked:
 * they are named on the left of the rest spread so they never enter
 * `merchantSafe`. A `{...dto}` spread would carry both at runtime while the
 * TYPE said otherwise, which is the silent version of this leak.
 */
export async function hydrateOrdersForMerchant(orders: OrderRecord[]): Promise<MerchantOrder[]> {
  if (orders.length === 0) {
    return [];
  }
  const buyerOxyUserIds = orders.flatMap((order) =>
    order.buyerOrigin === 'oxy' && order.buyerOxyUserId ? [order.buyerOxyUserId] : [],
  );
  const [dtos, { oxyProfiles }] = await Promise.all([
    hydrateOrders(orders),
    loadSellerContext(orders, buyerOxyUserIds),
  ]);

  return dtos.map((dto) => {
    const { buyer, buyerOxyUserId, buyerContact, ...merchantSafe } = dto;
    return { ...merchantSafe, buyer: toMerchantBuyerLabel(buyer, oxyProfiles) };
  });
}

/** {@link hydrateOrdersForMerchant}'s list projection. */
export async function summarizeOrdersForMerchant(
  orders: OrderRecord[],
): Promise<MerchantOrderSummary[]> {
  if (orders.length === 0) {
    return [];
  }
  const buyerOxyUserIds = orders.flatMap((order) =>
    order.buyerOrigin === 'oxy' && order.buyerOxyUserId ? [order.buyerOxyUserId] : [],
  );
  const [summaries, { oxyProfiles }] = await Promise.all([
    summarizeOrders(orders),
    loadSellerContext(orders, buyerOxyUserIds),
  ]);

  // `OrderSummary` never carried a buyer field, so there is nothing to strip
  // here — the merchant summary is the existing shape PLUS a label. The map is
  // aligned by index because `summarizeOrders` documents that it preserves
  // order, and both arrays come from the same `orders` argument.
  return summaries.map((summary, index) => ({
    ...summary,
    buyer: toMerchantBuyerLabel(orderBuyerOf(orders[index]), oxyProfiles),
  }));
}

/**
 * Summarize raw order docs into `OrderSummary` DTOs (buyer/seller list views),
 * with the same batched seller/store load as `hydrateOrders`. Preserves order.
 */
export async function summarizeOrders(orders: OrderRecord[]): Promise<OrderSummary[]> {
  if (orders.length === 0) {
    return [];
  }

  const { oxyProfiles, sellerProfileByUser, storeById } = await loadSellerContext(orders);

  return orders.map((order) => {
    const summary: OrderSummary = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      grandTotal: dual(
        order.totalsGrandTotalShopAmount,
        order.totalsGrandTotalShopCurrency,
        order.totalsGrandTotalPresentmentAmount,
        order.totalsGrandTotalPresentmentCurrency,
      ),
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      sellerType: order.sellerType,
      createdAt: order.createdAt.toISOString(),
    };

    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      const oxyUserId = order.sellerOxyUserId;
      summary.seller = toSeller(
        oxyUserId,
        sellerProfileByUser.get(oxyUserId),
        oxyProfiles.get(oxyUserId),
      );
    } else if (order.sellerType === 'store' && order.storeId) {
      const store = storeById.get(order.storeId);
      if (store) {
        summary.store = toMerchantSummary(store, []);
      }
    }

    return summary;
  });
}
