/**
 * Checkout service — turn the buyer's cart into immutable orders.
 *
 * A multi-seller cart is SPLIT into one order per seller (a `store:<id>` or a
 * `user:<id>` group), all sharing a `checkoutGroupId`. Every line's stock is
 * reserved up front across ALL groups; if ANY reservation fails the whole
 * checkout is rolled back (every prior reservation released) and nothing is
 * created — checkout is all-or-nothing.
 *
 * Idempotency is layered: a Redis SETNX claim is the fast path (replay returns
 * the original orders), and the durable backstop is the per-order sparse-unique
 * `idempotency_key` — a unique violation on replay converges on the
 * already-created group. Redis is best-effort: any Redis failure logs a warning
 * and falls through to the durable path — it NEVER breaks checkout.
 */

import type {
  AddressSnapshot,
  CheckoutInput,
  CheckoutResult,
  CurrencyCode,
  DualMoney,
  FxRates,
  FxRateSnapshot,
  Money,
  ShippingMethod,
  OrderSellerType,
  DiscountAllocation,
  TaxLine,
} from '@mercaria/shared-types';
import type { Cart } from '@mercaria/shared-types';
import {
  findOrderByIdempotencyKey,
  findOrdersByCheckoutGroup,
  insertOrder,
  nextOrderNumber,
  type NewOrder,
  type NewOrderAppliedDiscount,
  type NewOrderItem,
  type NewOrderTaxLine,
  type OrderRecord,
} from '../db/orders/orderRepository.js';
import {
  findListingChildren,
  findListingsByIds,
  type ListingImageRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantOptionValues,
  findVariantsByIds,
  type VariantOptionValueRecord,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import { findStoresByIds } from '../db/stores/storeRepository.js';
import { redeemDiscountCode } from '../db/merchandising/discountRepository.js';
import { Address, type IAddress } from '../models/address.js';
import { getCart, clearCart, removeCartLines } from './cart.service.js';
import { reserve, release } from './inventory.service.js';
import { summarizeOrders } from './order-hydration.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { calculateTotals, type PricingLine, type PricingResult } from './pricing.service.js';
import { normalizeDiscountCode } from './discount.service.js';
import { getRates, convert, toDualMoney, pairRate } from './fx.service.js';
import { addMoney, multiplyMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { uuidv7, isUniqueViolation } from '@oxyhq/db';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { enqueueOrderEvent } from '../queue/producers.js';
import { conflict, notFound, isMercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Human label shown for each shipping method on the order. */
const SHIPPING_LABELS: Record<ShippingMethod, string> = {
  standard: 'Standard shipping',
  express: 'Express shipping',
  pickup: 'Pickup',
};

/** Sentinel value held in the Redis idempotency key while a checkout is in flight. */
const IDEMPOTENCY_PENDING = '__pending__';
/** Redis key prefix for checkout idempotency claims. */
const IDEMPOTENCY_KEY_PREFIX = 'checkout:';

/** A reservation made during this checkout attempt (for rollback). */
interface Reservation {
  variantId: string;
  qty: number;
}

/**
 * A cart line resolved against its live listing + variant for snapshotting.
 *
 * The gallery, the collection memberships and the variant's option values were
 * all fields ON the two documents and are child tables now, so they travel with
 * the line rather than being read off it — resolved ONCE for the whole cart, not
 * per line.
 */
interface ResolvedLine {
  cartItem: Cart['items'][number];
  listing: ListingRecord;
  variant: VariantRecord;
  images: ListingImageRecord[];
  collectionIds: string[];
  optionValues: VariantOptionValueRecord[];
}

/** A per-seller group of resolved lines that becomes one order. */
interface SellerGroup {
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  lines: ResolvedLine[];
}

/** Build the immutable address snapshot from a saved address (omit absent optionals). */
function snapshotAddress(address: IAddress): AddressSnapshot {
  const snapshot: AddressSnapshot = {
    recipientName: address.recipientName,
    line1: address.line1,
    city: address.city,
    postalCode: address.postalCode,
    country: address.country,
  };
  if (address.label) {
    snapshot.label = address.label;
  }
  if (address.line2) {
    snapshot.line2 = address.line2;
  }
  if (address.region) {
    snapshot.region = address.region;
  }
  if (address.phone) {
    snapshot.phone = address.phone;
  }
  return snapshot;
}

/** The stable seller group key for a listing (`store:<id>` or `user:<id>`). */
function sellerKeyForListing(listing: ListingRecord): string {
  return listing.ownerType === 'store'
    ? `store:${String(listing.storeId)}`
    : `user:${String(listing.oxyUserId)}`;
}

/** First listing image (lowest position), resolved through the media chokepoint. */
function firstImageUrl(images: ListingImageRecord[]): string | undefined {
  if (images.length === 0) {
    return undefined;
  }
  const first = [...images].sort((a, b) => a.position - b.position)[0];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
}

/** Release every reservation made so far, swallowing (and warning) per-release failures. */
async function rollbackReservations(reserved: Reservation[]): Promise<void> {
  for (const r of reserved) {
    try {
      await release(r.variantId, r.qty);
    } catch (relErr) {
      log.general.warn(
        { err: relErr, variantId: r.variantId },
        'Failed to release reservation during checkout rollback',
      );
    }
  }
}

/** Look up the orders of a prior checkout group and summarize them. */
async function summarizePriorGroup(
  oxyUserId: string,
  checkoutGroupId: string,
): Promise<CheckoutResult> {
  const prior = await findOrdersByCheckoutGroup(checkoutGroupId, oxyUserId);
  return { checkoutGroupId, orders: await summarizeOrders(prior) };
}

/**
 * The native `Money` price of a resolved line's variant.
 *
 * A variant whose price columns are NULL cannot be sold: the checkout refuses the
 * whole cart rather than snapshotting a zero onto an order, which is a price a
 * buyer would then be held to.
 */
function nativeUnitPrice(variant: VariantRecord): Money {
  if (variant.priceAmount === null || variant.priceCurrency === null) {
    throw conflict('Cart references an item that is not currently priced');
  }
  return { amount: variant.priceAmount, currency: variant.priceCurrency };
}

/**
 * Build the immutable line item snapshots for a group: title/variant/options/
 * unit price are frozen here and never re-read after the order is placed. Each
 * money field is `DualMoney` — the variant's NATIVE price converted to the SHOP
 * currency, plus a `presentment` side for the buyer. The pricing engine's
 * `perLineDiscount` (aligned to `group.lines` order) is stamped onto each item's
 * `discountTotal` (only when the shop side is non-zero).
 */
function buildItems(
  group: SellerGroup,
  perLineDiscount: DualMoney[],
  shopCurrency: CurrencyCode,
  presentmentCurrency: CurrencyCode,
  rates: FxRates,
): NewOrderItem[] {
  return group.lines.map(({ cartItem, listing, variant, images, optionValues }, index) => {
    const shopUnit = convert(nativeUnitPrice(variant), shopCurrency, rates);
    const unitPrice: DualMoney = toDualMoney(shopUnit, presentmentCurrency, rates);
    const lineTotal: DualMoney = toDualMoney(
      multiplyMoney(shopUnit, cartItem.quantity),
      presentmentCurrency,
      rates,
    );
    const item: NewOrderItem = {
      listingId: listing.id,
      variantId: variant.id,
      title: listing.title,
      variantTitle: variant.title,
      optionValues: optionValues.map((o) => ({ name: o.name, value: o.value })),
      unitPrice,
      quantity: cartItem.quantity,
      lineTotal,
    };
    const lineDiscount = perLineDiscount[index];
    if (lineDiscount && lineDiscount.shop.amount > 0) {
      item.discountTotal = lineDiscount;
    }
    const imageUrl = firstImageUrl(images);
    if (imageUrl !== undefined) {
      item.imageUrl = imageUrl;
    }
    return item;
  });
}

/**
 * Build the `PricingLine[]` for a group from its resolved lines (input order
 * preserved). Uses the variant's NATIVE price — the pricing engine converts it to
 * the shop currency.
 */
function buildPricingLines(group: SellerGroup): PricingLine[] {
  return group.lines.map(({ cartItem, listing, variant, collectionIds }) => {
    const line: PricingLine = {
      listingId: listing.id,
      variantId: variant.id,
      collectionIds: [...collectionIds],
      unitPrice: nativeUnitPrice(variant),
      quantity: cartItem.quantity,
    };
    if (listing.productType) {
      line.productType = listing.productType;
    }
    return line;
  });
}

/** Map the engine's discount allocations to the repository's allocation rows. */
function toOrderAllocations(allocations: DiscountAllocation[]): NewOrderAppliedDiscount[] {
  return allocations.map((a) => ({
    discountId: a.discountId,
    ...(a.code ? { code: a.code } : {}),
    title: a.title,
    valueType: a.valueType,
    amount: a.amount,
    target: a.target,
    ...(a.targetLineIndex !== undefined ? { targetLineIndex: a.targetLineIndex } : {}),
  }));
}

/** Map the engine's tax lines to the repository's tax-line rows. */
function toOrderTaxLines(taxLines: TaxLine[]): NewOrderTaxLine[] {
  return taxLines.map((t) => ({ name: t.name, rateBps: t.rateBps, amount: t.amount }));
}

/**
 * Count one redemption of every code that actually produced an allocation,
 * EXACTLY once per checkout — this runs only on the fresh-claim success path,
 * never on a replay or a converge.
 *
 * The ceiling guard lives in the repository, which serializes on the parent
 * discount before counting; see it for why the shorter `UPDATE … WHERE (subquery)
 * < max` form lets two concurrent redemptions past a `totalMax`. A refusal here
 * means the ceiling was genuinely reached and is logged, never raised: a
 * redemption count is bookkeeping and must not fail a checkout that has already
 * created orders and taken stock.
 */
async function incrementDiscountUsage(codes: string[]): Promise<void> {
  for (const code of codes) {
    try {
      const counted = await redeemDiscountCode(code);
      if (!counted) {
        log.general.warn({ code }, 'Discount usage increment skipped (usage ceiling reached)');
      }
    } catch (err) {
      // A usage-count bookkeeping failure must never fail a completed checkout.
      log.general.warn({ err, code }, 'Failed to increment discount usage count');
    }
  }
}

/**
 * Place orders from the buyer's current cart.
 *
 * @param oxyUserId - The buyer.
 * @param input - The shipping address + optional per-seller shipping selections.
 * @param idempotencyKey - Optional client-supplied key; a replay with the same
 *   key returns the original orders instead of creating duplicates.
 */
export async function checkout(
  oxyUserId: string,
  input: CheckoutInput,
  idempotencyKey?: string,
): Promise<CheckoutResult> {
  // 1. Redis idempotency fast-path (best-effort; never breaks checkout).
  const redis = idempotencyKey ? getRedisClient() : null;
  const redisKey = idempotencyKey ? `${IDEMPOTENCY_KEY_PREFIX}${oxyUserId}:${idempotencyKey}` : null;
  let holdsRedisClaim = false;

  if (redis && redisKey) {
    try {
      const claim = await withRedisTimeout(
        redis.set(redisKey, IDEMPOTENCY_PENDING, 'PX', config.orders.idempotencyTtlMs, 'NX'),
      );
      if (claim === null) {
        const stored = await withRedisTimeout(redis.get(redisKey));
        if (stored && stored !== IDEMPOTENCY_PENDING) {
          const prior = await findOrdersByCheckoutGroup(stored, oxyUserId);
          if (prior.length > 0) {
            return { checkoutGroupId: stored, orders: await summarizeOrders(prior) };
          }
        } else if (stored === IDEMPOTENCY_PENDING) {
          throw conflict('Checkout already in progress');
        }
      } else {
        holdsRedisClaim = true;
      }
    } catch (err) {
      if (isMercariaError(err)) {
        throw err;
      }
      log.general.warn({ err }, 'Redis idempotency fast-path failed; falling back to durable path');
    }
  }

  // 2. Load + validate the cart.
  const cart = await getCart(oxyUserId);
  if (cart.items.length === 0) {
    throw conflict('Cart is empty');
  }
  if (cart.items.some((item) => item.stale === true)) {
    throw conflict('Cart has stale items; please review your cart');
  }

  // 3. Resolve + snapshot the shipping address.
  const address = await Address.findOne({ _id: input.addressId, oxyUserId }).lean<IAddress | null>();
  if (!address) {
    throw notFound('Address not found');
  }
  const shippingAddressSnapshot = snapshotAddress(address);

  // 4. Load listings + variants for every cart line; group by seller.
  const listingIds = [...new Set(cart.items.map((i) => i.listingId))];
  const variantIds = [...new Set(cart.items.map((i) => i.variantId))];
  const [listingDocs, variantDocs, children] = await Promise.all([
    findListingsByIds(listingIds),
    findVariantsByIds(variantIds),
    findListingChildren(listingIds),
  ]);
  const optionValuesByVariant = await findVariantOptionValues(variantIds);
  const listingById = new Map(listingDocs.map((l) => [l.id, l]));
  const variantById = new Map(variantDocs.map((v) => [v.id, v]));

  const groups = new Map<string, SellerGroup>();
  for (const cartItem of cart.items) {
    const listing = listingById.get(cartItem.listingId);
    const variant = variantById.get(cartItem.variantId);
    if (!listing || !variant) {
      throw conflict('Cart references an item that no longer exists');
    }
    const resolved: ResolvedLine = {
      cartItem,
      listing,
      variant,
      images: children.images.get(listing.id) ?? [],
      collectionIds: children.collectionIds.get(listing.id) ?? [],
      optionValues: optionValuesByVariant.get(variant.id) ?? [],
    };
    const key = sellerKeyForListing(listing);
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(resolved);
    } else {
      groups.set(key, {
        sellerType: listing.ownerType === 'store' ? 'store' : 'user',
        ...(listing.ownerType === 'store'
          ? { storeId: String(listing.storeId) }
          : { sellerOxyUserId: String(listing.oxyUserId) }),
        lines: [resolved],
      });
    }
  }

  // 4b. Per-seller checkout: when `sellerKeys` is given, keep only the requested
  // groups and place those (the rest stay in the cart). At least one must match.
  if (input.sellerKeys && input.sellerKeys.length > 0) {
    const wanted = new Set(input.sellerKeys);
    for (const key of [...groups.keys()]) {
      if (!wanted.has(key)) {
        groups.delete(key);
      }
    }
    if (groups.size === 0) {
      throw conflict('No matching cart items for the selected seller(s)');
    }
  }
  // Whether this checkout placed the WHOLE cart (empty it) or just some groups
  // (remove only the placed lines, keeping the rest).
  const isPartialCheckout = Boolean(input.sellerKeys && input.sellerKeys.length > 0);

  // 4c. Refuse an unpriced line BEFORE any stock is touched.
  //
  // `nativeUnitPrice` throws for a variant whose price columns are NULL, and it is
  // called from `shopCurrencyForGroup`, `buildPricingLines` and `buildItems` —
  // three places that all run AFTER the reservation loop below. Only the last two
  // sit inside a `try` that rolls back, so a throw from the currency resolution
  // would strand every unit this checkout had already committed, with no order to
  // release them and nothing in the response to say so.
  //
  // Checking here rather than widening that `try` is the stronger shape: a
  // checkout that cannot be priced never reserves in the first place, so there is
  // nothing to roll back and no window in which a partial reservation exists.
  for (const group of groups.values()) {
    for (const line of group.lines) {
      nativeUnitPrice(line.variant);
    }
  }

  // 5. Reserve every line across ALL groups; roll back on any failure.
  const reserved: Reservation[] = [];
  try {
    for (const group of groups.values()) {
      for (const line of group.lines) {
        await reserve(line.cartItem.variantId, line.cartItem.quantity);
        reserved.push({ variantId: line.cartItem.variantId, qty: line.cartItem.quantity });
      }
    }
  } catch (err) {
    await rollbackReservations(reserved);
    throw err;
  }

  // 5b. Resolve the discount codes to apply: checkout input ∪ cart-pinned codes
  // (normalized + deduped). Only store groups consult them; P2P groups ignore them.
  const discountCodes = [
    ...new Set(
      [...(input.discountCodes ?? []), ...(cart.pendingDiscountCodes ?? [])]
        .map((code) => normalizeDiscountCode(code))
        .filter((code) => code.length > 0),
    ),
  ];
  const shippingCountry = address.country;
  const shippingRegion = address.region;
  const shippingPostal = address.postalCode;

  // 5c. Resolve the buyer's PRESENTMENT currency (the cart's display currency) and
  // each store group's SHOP (settlement) currency — its `defaultCurrency`, falling
  // back to a line's native currency. FAIR-based rates covering every currency
  // involved (presentment + shop + native) are fetched ONCE so the native → shop →
  // presentment conversions and the per-order fxRate snapshot are all consistent.
  const presentmentCurrency: CurrencyCode = cart.currency;
  const groupStoreIds = [
    ...new Set(
      [...groups.values()].map((g) => g.storeId).filter((s): s is string => Boolean(s)),
    ),
  ];
  const storeRows = await findStoresByIds(groupStoreIds);
  const shopCurrencyByStore = new Map(
    storeRows.map((s) => [s.id, s.defaultCurrency as CurrencyCode]),
  );
  const shopCurrencyForGroup = (group: SellerGroup): CurrencyCode =>
    (group.storeId ? shopCurrencyByStore.get(group.storeId) : undefined) ??
    nativeUnitPrice(group.lines[0].variant).currency;

  const involvedCurrencies = new Set<CurrencyCode>([presentmentCurrency]);
  for (const group of groups.values()) {
    involvedCurrencies.add(shopCurrencyForGroup(group));
    for (const line of group.lines) {
      involvedCurrencies.add(nativeUnitPrice(line.variant).currency);
    }
  }
  const rates = await getRates('FAIR', [...involvedCurrencies]);

  // 6-7. Build + create one order per group (durable idempotency via 11000).
  // The pricing engine computes discount→tax→grand in the SHOP currency (shipping
  // = 0); the flat config shipping cost is added AFTER (so grandTotal =
  // pricing.grandTotal + shippingCost) on BOTH the shop and presentment sides. The
  // codes that actually produced an allocation are collected so their usageCount
  // can be incremented EXACTLY once on the fresh-claim path.
  // A uuid v7 rather than a fresh ObjectId: the id shape every row created after
  // the cutover uses, and k-sortable, so the `orders_checkout_group_id_idx`
  // lookups a replay makes stay clustered by time.
  const checkoutGroupId = uuidv7();
  const groupEntries = [...groups.entries()];
  const created: OrderRecord[] = [];
  const appliedCodes = new Set<string>();

  try {
    for (const [sellerKey, group] of groupEntries) {
      const method = input.shippingSelections?.[sellerKey] ?? 'standard';
      const shopCurrency = shopCurrencyForGroup(group);
      // Shipping cost is a flat SHOP-currency amount; convert to presentment.
      const cost: DualMoney = toDualMoney(
        { amount: config.orders.shippingRates[method], currency: shopCurrency },
        presentmentCurrency,
        rates,
      );

      // Store groups consult discounts/taxes; P2P groups price with no storeId.
      const pricing: PricingResult = await calculateTotals({
        ...(group.storeId ? { storeId: group.storeId } : {}),
        lines: buildPricingLines(group),
        currency: shopCurrency,
        presentmentCurrency,
        rates,
        discountCodes: group.storeId ? discountCodes : [],
        customerId: oxyUserId,
        shippingAddress: { country: shippingCountry, region: shippingRegion, postalCode: shippingPostal },
      });

      for (const allocation of pricing.appliedDiscounts) {
        if (allocation.code) {
          appliedCodes.add(allocation.code);
        }
      }

      const items = buildItems(group, pricing.perLineDiscount, shopCurrency, presentmentCurrency, rates);
      // grandTotal = (subtotal − discount + tax) from pricing, plus flat shipping,
      // added on each of the shop + presentment sides.
      const grandTotal: DualMoney = {
        shop: addMoney(pricing.grandTotal.shop, cost.shop),
        presentment: addMoney(pricing.grandTotal.presentment, cost.presentment),
      };
      const fxRate: FxRateSnapshot = {
        from: shopCurrency,
        to: presentmentCurrency,
        rate: pairRate(shopCurrency, presentmentCurrency, rates),
        asOf: rates.asOf,
      };
      const orderNumber = await nextOrderNumber();

      const doc: NewOrder = {
        orderNumber,
        buyerOxyUserId: oxyUserId,
        sellerType: group.sellerType,
        ...(group.sellerOxyUserId ? { sellerOxyUserId: group.sellerOxyUserId } : {}),
        ...(group.storeId ? { storeId: group.storeId } : {}),
        items,
        shippingAddress: shippingAddressSnapshot,
        shippingMethod: method,
        shippingLabel: SHIPPING_LABELS[method],
        shippingCost: cost,
        totals: {
          subtotal: pricing.subtotal,
          discountTotal: pricing.discountTotal,
          shipping: cost,
          tax: pricing.tax,
          grandTotal,
        },
        fxRate,
        appliedDiscounts: toOrderAllocations(pricing.appliedDiscounts),
        taxLines: toOrderTaxLines(pricing.taxLines),
        status: 'pending_payment',
        statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: oxyUserId }],
        paymentStatus: 'unpaid',
        paymentProvider: 'oxy_pay',
        checkoutGroupId,
        ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:${sellerKey}` } : {}),
      };

      // ONE transaction per seller-order: the order row and all five child
      // relations land together or not at all. A half-written order is not a
      // degraded record, it is a charge with no lines.
      created.push(await insertOrder(doc));
    }
  } catch (err) {
    // A duplicate idempotencyKey means a concurrent/replayed checkout already
    // created these orders. Roll back THIS attempt's reservations and converge
    // on the prior group.
    // The NAMED index, not "some unique violation": a duplicate on any other
    // constraint is a real failure, and converging on a prior group for it would
    // return someone else's orders.
    if (isUniqueViolation(err, 'orders_idempotency_key_key')) {
      await rollbackReservations(reserved);
      if (idempotencyKey && groupEntries.length > 0) {
        const sampleKey = `${idempotencyKey}:${groupEntries[0][0]}`;
        const prior = await findOrderByIdempotencyKey(sampleKey);
        if (prior && prior.buyerOxyUserId === oxyUserId && prior.checkoutGroupId) {
          log.general.warn(
            { oxyUserId, idempotencyKey },
            'Concurrent/replayed checkout detected; converging on prior order group',
          );
          return summarizePriorGroup(oxyUserId, prior.checkoutGroupId);
        }
      }
      throw conflict('Checkout already processed');
    }
    // Any other create failure: release reservations and rethrow.
    await rollbackReservations(reserved);
    throw err;
  }

  // 8. Best-effort: overwrite the Redis claim with the real group id.
  if (redis && redisKey && holdsRedisClaim) {
    try {
      await withRedisTimeout(
        redis.set(redisKey, checkoutGroupId, 'PX', config.orders.idempotencyTtlMs),
      );
    } catch (err) {
      log.general.warn({ err }, 'Failed to persist checkout idempotency group id to Redis');
    }
  }

  // 9. Increment redeemed discount usage EXACTLY once — this runs only on the
  // fresh-claim success path (the replay/11000-converge paths return early above,
  // so they never reach here), keeping redemption counts idempotent. Then empty
  // the cart now that orders exist.
  await incrementDiscountUsage([...appliedCodes]);
  if (isPartialCheckout) {
    // Remove only the lines that were just placed; the rest stay in the cart.
    const placedVariantIds = [...groups.values()].flatMap((group) =>
      group.lines.map((line) => line.cartItem.variantId),
    );
    await removeCartLines(oxyUserId, placedVariantIds);
  } else {
    await clearCart(oxyUserId);
  }

  // 10. Best-effort: notify buyer + seller of each placed order. A notification
  // failure must never fail a completed checkout.
  try {
    for (const o of created) {
      await enqueueOrderEvent({ orderId: o.id, event: 'placed' });
    }
  } catch (err) {
    log.general.warn({ err }, 'Failed to enqueue order-placed notifications');
  }

  // 11. Summarize the created orders.
  return { checkoutGroupId, orders: await summarizeOrders(created) };
}
