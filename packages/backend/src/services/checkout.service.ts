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
 * the original orders), and the durable backstop is the per-order
 * sparse-unique `idempotencyKey` (a Mongo 11000 on replay converges on the
 * already-created group). Redis is best-effort: any Redis failure logs a warning
 * and falls through to the durable Mongo path — it NEVER breaks checkout.
 */

import mongoose from 'mongoose';
import type {
  CheckoutInput,
  CheckoutResult,
  Money,
  ShippingMethod,
  OrderSellerType,
} from '@mercaria/shared-types';
import type { Cart } from '@mercaria/shared-types';
import { Order, type IOrder, type IOrderItem, type IAddressSnapshot } from '../models/order.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Address, type IAddress } from '../models/address.js';
import { nextOrderNumber } from '../models/counter.js';
import { getCart, clearCart } from './cart.service.js';
import { reserve, release } from './inventory.service.js';
import { summarizeOrders } from './order-hydration.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { multiplyMoney, addMoney, sumMoney } from '../utils/money.js';
import { config } from '../config/index.js';
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

/** A cart line resolved against its live listing + variant for snapshotting. */
interface ResolvedLine {
  cartItem: Cart['items'][number];
  listing: IListing;
  variant: IProductVariant;
}

/** A per-seller group of resolved lines that becomes one order. */
interface SellerGroup {
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  lines: ResolvedLine[];
}

/** The shape passed to `Order.create` for a single group's order. */
interface OrderCreateDoc {
  orderNumber: string;
  buyerOxyUserId: string;
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  items: IOrderItem[];
  shippingAddressSnapshot: IAddressSnapshot;
  shipping: { method: ShippingMethod; label: string; cost: Money; trackingNumber: null };
  totals: { subtotal: Money; shipping: Money; grandTotal: Money };
  status: 'pending_payment';
  statusHistory: { status: 'pending_payment'; at: Date; byOxyUserId: string }[];
  payment: { status: 'unpaid'; provider: 'oxy_pay' };
  checkoutGroupId: string;
  idempotencyKey?: string;
}

/** Build the immutable address snapshot from a saved address (omit absent optionals). */
function snapshotAddress(address: IAddress): IAddressSnapshot {
  const snapshot: IAddressSnapshot = {
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
function sellerKeyForListing(listing: IListing): string {
  return listing.ownerType === 'store'
    ? `store:${String(listing.storeId)}`
    : `user:${String(listing.oxyUserId)}`;
}

/** First listing image (lowest position), resolved through the media chokepoint. */
function firstImageUrl(listing: IListing): string | undefined {
  if (listing.images.length === 0) {
    return undefined;
  }
  const first = [...listing.images].sort((a, b) => a.position - b.position)[0];
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
  const prior = await Order.find({ checkoutGroupId, buyerOxyUserId: oxyUserId }).lean<IOrder[]>();
  return { checkoutGroupId, orders: await summarizeOrders(prior) };
}

/**
 * Build the immutable line item snapshots for a group: title/variant/options/
 * unit price are frozen here and never re-read after the order is placed.
 */
function buildItems(group: SellerGroup): IOrderItem[] {
  return group.lines.map(({ cartItem, listing, variant }) => {
    const unitPrice: Money = cartItem.unitPrice;
    const item: IOrderItem = {
      listingId: String((listing as { _id: mongoose.Types.ObjectId })._id),
      variantId: String((variant as { _id: mongoose.Types.ObjectId })._id),
      title: listing.title,
      variantTitle: variant.title,
      optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
      unitPrice,
      quantity: cartItem.quantity,
      lineTotal: multiplyMoney(unitPrice, cartItem.quantity),
    };
    const imageUrl = firstImageUrl(listing);
    if (imageUrl !== undefined) {
      item.imageUrl = imageUrl;
    }
    return item;
  });
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
          const prior = await Order.find({
            checkoutGroupId: stored,
            buyerOxyUserId: oxyUserId,
          }).lean<IOrder[]>();
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
  if (cart.items.some((item) => item.unitPrice.currency !== cart.currency)) {
    throw conflict('Cart currency mismatch');
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
  const [listingDocs, variantDocs] = await Promise.all([
    Listing.find({ _id: { $in: listingIds } }).lean<IListing[]>(),
    ProductVariant.find({ _id: { $in: variantIds } }).lean<IProductVariant[]>(),
  ]);
  const listingById = new Map(
    listingDocs.map((l) => [String((l as { _id: mongoose.Types.ObjectId })._id), l]),
  );
  const variantById = new Map(
    variantDocs.map((v) => [String((v as { _id: mongoose.Types.ObjectId })._id), v]),
  );

  const groups = new Map<string, SellerGroup>();
  for (const cartItem of cart.items) {
    const listing = listingById.get(cartItem.listingId);
    const variant = variantById.get(cartItem.variantId);
    if (!listing || !variant) {
      throw conflict('Cart references an item that no longer exists');
    }
    const key = sellerKeyForListing(listing);
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push({ cartItem, listing, variant });
    } else {
      groups.set(key, {
        sellerType: listing.ownerType === 'store' ? 'store' : 'user',
        ...(listing.ownerType === 'store'
          ? { storeId: String(listing.storeId) }
          : { sellerOxyUserId: String(listing.oxyUserId) }),
        lines: [{ cartItem, listing, variant }],
      });
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

  // 6-7. Build + create one order per group (durable idempotency via 11000).
  const checkoutGroupId = new mongoose.Types.ObjectId().toString();
  const groupEntries = [...groups.entries()];
  const created: IOrder[] = [];

  try {
    for (const [sellerKey, group] of groupEntries) {
      const method = input.shippingSelections?.[sellerKey] ?? 'standard';
      const cost: Money = { amount: config.orders.shippingRates[method], currency: cart.currency };
      const items = buildItems(group);
      const subtotal = sumMoney(
        items.map((i) => i.lineTotal as Money),
        cart.currency,
      );
      const grandTotal = addMoney(subtotal, cost);
      const orderNumber = await nextOrderNumber();

      const doc: OrderCreateDoc = {
        orderNumber,
        buyerOxyUserId: oxyUserId,
        sellerType: group.sellerType,
        ...(group.sellerOxyUserId ? { sellerOxyUserId: group.sellerOxyUserId } : {}),
        ...(group.storeId ? { storeId: group.storeId } : {}),
        items,
        shippingAddressSnapshot,
        shipping: { method, label: SHIPPING_LABELS[method], cost, trackingNumber: null },
        totals: { subtotal, shipping: cost, grandTotal },
        status: 'pending_payment',
        statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: oxyUserId }],
        payment: { status: 'unpaid', provider: 'oxy_pay' },
        checkoutGroupId,
        ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:${sellerKey}` } : {}),
      };

      const order = await Order.create(doc);
      created.push(order.toObject<IOrder>());
    }
  } catch (err) {
    // A duplicate idempotencyKey means a concurrent/replayed checkout already
    // created these orders. Roll back THIS attempt's reservations and converge
    // on the prior group.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      await rollbackReservations(reserved);
      if (idempotencyKey && groupEntries.length > 0) {
        const sampleKey = `${idempotencyKey}:${groupEntries[0][0]}`;
        const prior = await Order.findOne({
          buyerOxyUserId: oxyUserId,
          idempotencyKey: sampleKey,
        }).lean<IOrder | null>();
        if (prior) {
          log.general.warn(
            { oxyUserId, idempotencyKey },
            'Concurrent/replayed checkout detected; converging on prior order group',
          );
          return summarizePriorGroup(oxyUserId, String(prior.checkoutGroupId));
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

  // 9. Empty the cart now that orders exist.
  await clearCart(oxyUserId);

  // 10. Best-effort: notify buyer + seller of each placed order. A notification
  // failure must never fail a completed checkout.
  try {
    for (const o of created) {
      await enqueueOrderEvent({
        orderId: String((o as { _id: mongoose.Types.ObjectId })._id),
        event: 'placed',
      });
    }
  } catch (err) {
    log.general.warn({ err }, 'Failed to enqueue order-placed notifications');
  }

  // 11. Summarize the created orders.
  return { checkoutGroupId, orders: await summarizeOrders(created) };
}
